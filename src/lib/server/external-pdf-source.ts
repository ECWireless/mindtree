import "server-only";

import { lookup } from "node:dns/promises";
import type { IncomingMessage } from "node:http";
import { request as requestHttps, type RequestOptions } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

import type { ExternalCitationSource } from "@/lib/server/external-citations";
import {
  ExternalCitationValidationError,
  normalizeExternalTitle,
  normalizeExternalUrl,
} from "@/lib/server/external-citations";

export type ExternalPdfSource = ExternalCitationSource & {
  alias: "W1";
};

export type ExternalPdfInput = ExternalPdfSource & {
  fileData: string;
  filename: string;
};

type ResolvedAddress = {
  address: string;
  family: 4 | 6;
};

type PdfFetchResponse = {
  body: AsyncIterable<Uint8Array>;
  destroy: () => void;
  headers: {
    contentEncoding?: string;
    contentLength?: string;
    contentType?: string;
    location?: string;
  };
  statusCode: number;
};

export type ExternalPdfFetchDependencies = {
  request: (
    url: URL,
    address: ResolvedAddress,
    signal: AbortSignal,
  ) => Promise<PdfFetchResponse>;
  resolve: (hostname: string, signal: AbortSignal) => Promise<ResolvedAddress[]>;
};

export const MAX_EXTERNAL_PDF_BYTES = 20 * 1024 * 1024;
export const MAX_EXTERNAL_PDF_REDIRECTS = 5;
export const EXTERNAL_PDF_FETCH_TIMEOUT_MS = 20_000;

const URL_CANDIDATE = /https?:\/\/[^\s<>"'`]+/giu;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/u;
const LOCAL_HOSTS = new Set(["localhost", "localhost.localdomain"]);
const LOCAL_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home", ".lan"];
const deniedAddresses = new BlockList();
const globalIpv6Addresses = new BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  deniedAddresses.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  deniedAddresses.addSubnet(network, prefix, "ipv6");
}
globalIpv6Addresses.addSubnet("2000::", 3, "ipv6");

function trimUrlCandidate(candidate: string) {
  let value = candidate;
  const pairs = [
    ["(", ")"],
    ["[", "]"],
    ["{", "}"],
  ] as const;
  let prior = "";
  while (prior !== value) {
    prior = value;
    value = value.replace(TRAILING_PUNCTUATION, "");
    for (const [open, close] of pairs) {
      while (value.endsWith(close)) {
        const opens = [...value].filter((character) => character === open).length;
        const closes = [...value].filter((character) => character === close).length;
        if (closes <= opens) break;
        value = value.slice(0, -1);
      }
    }
  }
  return value;
}

function requirePublicHttpsUrl(candidate: string) {
  const normalized = normalizeExternalUrl(candidate);
  const url = new URL(normalized);
  const hostname = url.hostname.toLowerCase().replace(/\.+$/u, "");
  const literalHostname = hostname.replace(/^\[|\]$/g, "");
  if (
    url.protocol !== "https:" ||
    LOCAL_HOSTS.has(hostname) ||
    LOCAL_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix)) ||
    isIP(literalHostname) !== 0
  ) {
    throw new ExternalCitationValidationError("invalid-pdf-url");
  }
  return url;
}

function requirePublicHttpsPdf(candidate: string): ExternalPdfSource {
  const url = requirePublicHttpsUrl(candidate);
  let filename: string;
  try {
    filename = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
  } catch {
    throw new ExternalCitationValidationError("invalid-pdf-url");
  }
  if (!filename.toLowerCase().endsWith(".pdf")) {
    throw new ExternalCitationValidationError("invalid-pdf-url");
  }
  return {
    alias: "W1",
    title: normalizeExternalTitle(filename),
    url: url.toString(),
  };
}

function redirectPdfSource(current: ExternalPdfSource, candidate: string) {
  const url = requirePublicHttpsUrl(candidate);
  let title = current.title;
  try {
    const filename = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
    if (filename.toLowerCase().endsWith(".pdf")) {
      title = normalizeExternalTitle(filename);
    }
  } catch {
    throw new ExternalCitationValidationError("invalid-pdf-url");
  }
  return { ...current, title, url: url.toString() };
}

export function isPublicExternalAddress(address: string) {
  const family = isIP(address);
  if (family === 4) return !deniedAddresses.check(address, "ipv4");
  if (family === 6) {
    return globalIpv6Addresses.check(address, "ipv6") &&
      !deniedAddresses.check(address, "ipv6");
  }
  return false;
}

async function resolvePublicAddresses(hostname: string, signal: AbortSignal) {
  if (signal.aborted) throw signal.reason;
  let rejectAbort: (reason?: unknown) => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const handleAbort = () => rejectAbort(signal.reason);
  signal.addEventListener("abort", handleAbort, { once: true });
  const resolution = lookup(hostname, { all: true, verbatim: true })
    .then((results) => results.map(({ address, family }) => ({
      address,
      family: family as 4 | 6,
    })));
  let results: ResolvedAddress[];
  try {
    results = await Promise.race([resolution, aborted]);
  } finally {
    signal.removeEventListener("abort", handleAbort);
  }
  return results;
}

function headerValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function toPdfFetchResponse(response: IncomingMessage): PdfFetchResponse {
  return {
    body: response,
    destroy: () => response.destroy(),
    headers: {
      contentEncoding: headerValue(response.headers["content-encoding"]),
      contentLength: headerValue(response.headers["content-length"]),
      contentType: headerValue(response.headers["content-type"]),
      location: headerValue(response.headers.location),
    },
    statusCode: response.statusCode ?? 0,
  };
}

export function createPinnedHttpsRequestOptions(
  url: URL,
  address: ResolvedAddress,
  signal: AbortSignal,
): RequestOptions {
  const pinnedLookup: LookupFunction = (_hostname, _options, callback) => {
    callback(null, address.address, address.family);
  };
  return {
    agent: false,
    family: address.family,
    headers: {
      Accept: "application/pdf",
      "Accept-Encoding": "identity",
      "User-Agent": "MindTree/0.1 PDF research",
    },
    lookup: pinnedLookup,
    method: "GET",
    servername: url.hostname,
    signal,
  };
}

async function requestPinnedHttps(
  url: URL,
  address: ResolvedAddress,
  signal: AbortSignal,
) {
  return await new Promise<PdfFetchResponse>((resolve, reject) => {
    const request = requestHttps(
      url,
      createPinnedHttpsRequestOptions(url, address, signal),
      (response) => resolve(toPdfFetchResponse(response)),
    );
    request.once("error", reject);
    request.end();
  });
}

const defaultFetchDependencies: ExternalPdfFetchDependencies = {
  request: requestPinnedHttps,
  resolve: resolvePublicAddresses,
};

function requireContentLength(value: string | undefined) {
  if (value === undefined) return null;
  if (!/^(0|[1-9]\d*)$/u.test(value)) {
    throw new ExternalCitationValidationError("invalid-pdf-response");
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length > MAX_EXTERNAL_PDF_BYTES) {
    throw new ExternalCitationValidationError("pdf-too-large");
  }
  return length;
}

async function readPdfBody(response: PdfFetchResponse) {
  const declaredLength = requireContentLength(response.headers.contentLength);
  if (
    response.headers.contentType?.split(";", 1)[0]?.trim().toLowerCase() !==
      "application/pdf" ||
    (response.headers.contentEncoding !== undefined &&
      response.headers.contentEncoding.toLowerCase() !== "identity")
  ) {
    throw new ExternalCitationValidationError("invalid-pdf-response");
  }
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    byteLength += bytes.byteLength;
    if (byteLength > MAX_EXTERNAL_PDF_BYTES) {
      throw new ExternalCitationValidationError("pdf-too-large");
    }
    chunks.push(bytes);
  }
  if (declaredLength !== null && declaredLength !== byteLength) {
    throw new ExternalCitationValidationError("invalid-pdf-response");
  }
  const bytes = Buffer.concat(chunks, byteLength);
  if (bytes.byteLength < 5 || bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new ExternalCitationValidationError("invalid-pdf-response");
  }
  return bytes;
}

export async function fetchAuthorizedExternalPdf(
  source: ExternalPdfSource,
  options: {
    dependencies?: ExternalPdfFetchDependencies;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<ExternalPdfInput> {
  const dependencies = options.dependencies ?? defaultFetchDependencies;
  const deadlineSignal = AbortSignal.timeout(
    options.timeoutMs ?? EXTERNAL_PDF_FETCH_TIMEOUT_MS,
  );
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadlineSignal])
    : deadlineSignal;
  let current = requirePublicHttpsPdf(source.url);
  try {
    for (let redirectCount = 0; redirectCount <= MAX_EXTERNAL_PDF_REDIRECTS; redirectCount += 1) {
      const url = new URL(current.url);
      const addresses = await dependencies.resolve(url.hostname, signal);
      if (
        addresses.length < 1 ||
        addresses.some(({ address, family }) =>
          family !== isIP(address) || !isPublicExternalAddress(address)
        )
      ) {
        throw new ExternalCitationValidationError("invalid-pdf-address");
      }
      const response = await dependencies.request(url, addresses[0]!, signal);
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.destroy();
        if (redirectCount === MAX_EXTERNAL_PDF_REDIRECTS || !response.headers.location) {
          throw new ExternalCitationValidationError("invalid-pdf-redirect");
        }
        current = redirectPdfSource(
          current,
          new URL(response.headers.location, current.url).toString(),
        );
        continue;
      }
      if (response.statusCode !== 200) {
        response.destroy();
        throw new ExternalCitationValidationError("invalid-pdf-response");
      }
      let bytes: Buffer;
      try {
        bytes = await readPdfBody(response);
      } catch (error) {
        response.destroy();
        throw error;
      }
      return {
        ...current,
        fileData: `data:application/pdf;base64,${bytes.toString("base64")}`,
        filename: current.title,
      };
    }
  } catch (error) {
    if (error instanceof ExternalCitationValidationError) throw error;
    throw new ExternalCitationValidationError("pdf-fetch-failed");
  }
  throw new ExternalCitationValidationError("invalid-pdf-redirect");
}

export function createDeterministicExternalPdfInput(
  source: ExternalPdfSource,
): ExternalPdfInput {
  return {
    ...source,
    fileData: "data:application/pdf;base64,JVBERi0xLjQK",
    filename: source.title,
  };
}

export function findAuthorizedExternalPdfSource(content: string) {
  const pdfCandidates = [...content.matchAll(URL_CANDIDATE)]
    .map(([candidate]) => trimUrlCandidate(candidate))
    .filter((candidate) => {
      try {
        return new URL(candidate).pathname.toLowerCase().endsWith(".pdf");
      } catch {
        return false;
      }
    });
  if (pdfCandidates.length === 0) return null;

  const sources = new Map<string, ExternalPdfSource>();
  for (const candidate of pdfCandidates) {
    const source = requirePublicHttpsPdf(candidate);
    sources.set(source.url, source);
  }
  if (sources.size !== 1) {
    throw new ExternalCitationValidationError("too-many-pdf-sources");
  }
  return [...sources.values()][0]!;
}
