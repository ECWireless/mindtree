import "server-only";

import { isIP } from "node:net";

import type { ExternalCitationSource } from "@/lib/server/external-citations";
import {
  ExternalCitationValidationError,
  normalizeExternalTitle,
  normalizeExternalUrl,
} from "@/lib/server/external-citations";

export type ExternalPdfSource = ExternalCitationSource & {
  alias: "W1";
};

const URL_CANDIDATE = /https?:\/\/[^\s<>"'`]+/giu;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/u;
const LOCAL_HOSTS = new Set(["localhost", "localhost.localdomain"]);
const LOCAL_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home", ".lan"];

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

function requirePublicHttpsPdf(candidate: string): ExternalPdfSource {
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
    url: normalized,
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
