import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ExternalCitationValidationError } from "@/lib/server/external-citations";
import {
  createPinnedHttpsRequestOptions,
  fetchAuthorizedExternalPdf,
  findAuthorizedExternalPdfSource,
  isPublicExternalAddress,
  MAX_EXTERNAL_PDF_BYTES,
  MAX_EXTERNAL_PDF_REDIRECTS,
  type ExternalPdfFetchDependencies,
  type ExternalPdfSource,
} from "@/lib/server/external-pdf-source";

const source: ExternalPdfSource = {
  alias: "W1",
  title: "paper.pdf",
  url: "https://source.example.test/paper.pdf",
};

function pdfResponse(input: {
  body?: Uint8Array | Uint8Array[];
  contentEncoding?: string;
  contentLength?: string;
  contentType?: string;
  location?: string;
  statusCode?: number;
} = {}) {
  const chunks = Array.isArray(input.body)
    ? input.body
    : [input.body ?? Buffer.from("%PDF-1.7\nsynthetic")];
  return {
    body: (async function* () {
      for (const chunk of chunks) yield chunk;
    })(),
    destroy: vi.fn(),
    headers: {
      contentEncoding: input.contentEncoding,
      contentLength: input.contentLength,
      contentType: input.contentType ?? "application/pdf",
      location: input.location,
    },
    statusCode: input.statusCode ?? 200,
  };
}

function dependencies(input: {
  addresses?: Array<{ address: string; family: 4 | 6 }>;
  responses?: ReturnType<typeof pdfResponse>[];
} = {}) {
  const responses = [...(input.responses ?? [pdfResponse()])];
  return {
    request: vi.fn(async (
      url: URL,
      address: { address: string; family: 4 | 6 },
      signal: AbortSignal,
    ) => {
      void url;
      void address;
      void signal;
      const response = responses.shift();
      if (!response) throw new Error("missing synthetic response");
      return response;
    }),
    resolve: vi.fn(async (hostname: string, signal: AbortSignal) => {
      void hostname;
      void signal;
      return input.addresses ?? [{
        address: "93.184.216.34",
        family: 4 as const,
      }];
    }),
  } satisfies ExternalPdfFetchDependencies;
}

describe("authorized external PDF source", () => {
  it("extracts one public HTTPS PDF and derives a bounded title", () => {
    expect(findAuthorizedExternalPdfSource(
      "Read https://example.test/papers/Rosenblatt%201957.pdf, then summarize it.",
    )).toEqual({
      alias: "W1",
      title: "Rosenblatt 1957.pdf",
      url: "https://example.test/papers/Rosenblatt%201957.pdf",
    });
  });

  it("handles a Markdown destination with trailing punctuation", () => {
    expect(findAuthorizedExternalPdfSource(
      "Use [the paper](https://example.test/paper.pdf,)",
    )?.url).toBe("https://example.test/paper.pdf");
  });

  it("deduplicates repeated occurrences of the same PDF URL", () => {
    const url = "https://example.test/paper.pdf";
    expect(findAuthorizedExternalPdfSource(`${url} and ${url}`)?.url).toBe(url);
  });

  it("returns null when the current message contains no PDF URL", () => {
    expect(findAuthorizedExternalPdfSource("Research https://example.test/page"))
      .toBeNull();
  });

  it.each([
    "http://example.test/paper.pdf",
    "https://localhost/paper.pdf",
    "https://127.0.0.1/paper.pdf",
    "https://8.8.8.8/paper.pdf",
    "https://192.168.1.8/paper.pdf",
    "https://[::1]/paper.pdf",
    "https://[::ffff:127.0.0.1]/paper.pdf",
    "https://localhost./paper.pdf",
    "https://host.local/paper.pdf",
    "https://host.internal/paper.pdf",
  ])("rejects a non-public or non-HTTPS PDF URL: %s", (url) => {
    expect(() => findAuthorizedExternalPdfSource(`Read ${url}`)).toThrow(
      new ExternalCitationValidationError("invalid-pdf-url"),
    );
  });

  it("rejects more than one distinct PDF destination", () => {
    expect(() => findAuthorizedExternalPdfSource(
      "Compare https://one.example.test/a.pdf with https://two.example.test/b.pdf",
    )).toThrow(new ExternalCitationValidationError("too-many-pdf-sources"));
  });

  it.each([
    ["8.8.8.8", true],
    ["1.1.1.1", true],
    ["2606:4700:4700::1111", true],
    ["0.0.0.0", false],
    ["10.0.0.1", false],
    ["100.64.0.1", false],
    ["127.0.0.1", false],
    ["169.254.169.254", false],
    ["172.16.0.1", false],
    ["192.168.1.1", false],
    ["198.18.0.1", false],
    ["224.0.0.1", false],
    ["::1", false],
    ["::ffff:127.0.0.1", false],
    ["2001:db8::1", false],
    ["3fff::1", false],
    ["fc00::1", false],
    ["fe80::1", false],
    ["ff02::1", false],
  ])("classifies %s as public=%s", (address, expected) => {
    expect(isPublicExternalAddress(address)).toBe(expected);
  });

  it("fetches a bounded PDF through the exact validated address and creates transient data", async () => {
    const deps = dependencies({
      addresses: [
        { address: "93.184.216.34", family: 4 },
        { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
      ],
      responses: [pdfResponse({ contentLength: "18" })],
    });

    await expect(fetchAuthorizedExternalPdf(source, { dependencies: deps }))
      .resolves.toEqual({
        ...source,
        fileData: `data:application/pdf;base64,${Buffer.from("%PDF-1.7\nsynthetic").toString("base64")}`,
        filename: "paper.pdf",
      });
    expect(deps.resolve).toHaveBeenCalledWith(
      "source.example.test",
      expect.any(AbortSignal),
    );
    expect(deps.request).toHaveBeenCalledWith(
      new URL(source.url),
      { address: "93.184.216.34", family: 4 },
      expect.any(AbortSignal),
    );
  });

  it("pins the production HTTPS lookup while preserving hostname-based TLS verification", async () => {
    const signal = new AbortController().signal;
    const url = new URL("https://papers.example.test/download.pdf");
    const options = createPinnedHttpsRequestOptions(
      url,
      { address: "93.184.216.34", family: 4 },
      signal,
    );
    const lookup = options.lookup;
    expect(typeof lookup).toBe("function");
    const callback = vi.fn();
    if (typeof lookup === "function") {
      lookup("papers.example.test", {}, callback);
    }
    expect(callback).toHaveBeenCalledWith(null, "93.184.216.34", 4);
    expect(options).toMatchObject({
      agent: false,
      family: 4,
      servername: "papers.example.test",
      signal,
    });
  });

  it("rejects private and mixed DNS answers before opening a connection", async () => {
    for (const addresses of [
      [{ address: "127.0.0.1", family: 4 as const }],
      [
        { address: "93.184.216.34", family: 4 as const },
        { address: "10.0.0.8", family: 4 as const },
      ],
      [{ address: "::ffff:127.0.0.1", family: 6 as const }],
    ]) {
      const deps = dependencies({ addresses });
      await expect(fetchAuthorizedExternalPdf(source, { dependencies: deps }))
        .rejects.toEqual(new ExternalCitationValidationError("invalid-pdf-address"));
      expect(deps.request).not.toHaveBeenCalled();
    }
  });

  it("revalidates and pins every HTTPS redirect while retaining final provenance", async () => {
    const redirect = pdfResponse({
      contentType: undefined,
      location: "https://final.example.test/final.pdf",
      statusCode: 302,
    });
    const deps = dependencies({ responses: [redirect, pdfResponse()] });

    await expect(fetchAuthorizedExternalPdf(source, { dependencies: deps }))
      .resolves.toMatchObject({
        title: "final.pdf",
        url: "https://final.example.test/final.pdf",
      });
    expect(redirect.destroy).toHaveBeenCalledOnce();
    expect(deps.resolve).toHaveBeenNthCalledWith(
      1,
      "source.example.test",
      expect.any(AbortSignal),
    );
    expect(deps.resolve).toHaveBeenNthCalledWith(
      2,
      "final.example.test",
      expect.any(AbortSignal),
    );
    expect(deps.request).toHaveBeenCalledTimes(2);
  });

  it("accepts an extensionless HTTPS redirect after final PDF validation", async () => {
    const redirect = pdfResponse({
      location: "https://cdn.example.test/signed-download?token=synthetic",
      statusCode: 302,
    });
    const deps = dependencies({ responses: [redirect, pdfResponse()] });

    await expect(fetchAuthorizedExternalPdf(source, { dependencies: deps }))
      .resolves.toMatchObject({
        title: "paper.pdf",
        url: "https://cdn.example.test/signed-download?token=synthetic",
      });
    expect(deps.resolve).toHaveBeenNthCalledWith(
      2,
      "cdn.example.test",
      expect.any(AbortSignal),
    );
  });

  it("rejects a redirect whose new DNS answer becomes private", async () => {
    const redirect = pdfResponse({
      location: "https://private.example.test/private.pdf",
      statusCode: 307,
    });
    const deps = dependencies({ responses: [redirect] });
    deps.resolve
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockResolvedValueOnce([{ address: "192.168.1.4", family: 4 }]);

    await expect(fetchAuthorizedExternalPdf(source, { dependencies: deps }))
      .rejects.toEqual(new ExternalCitationValidationError("invalid-pdf-address"));
    expect(deps.request).toHaveBeenCalledOnce();
  });

  it.each([
    "http://final.example.test/final.pdf",
    "https://127.0.0.1/final.pdf",
  ])("rejects an unsafe redirect destination: %s", async (location) => {
    const response = pdfResponse({ location, statusCode: 302 });
    const deps = dependencies({ responses: [response] });
    await expect(fetchAuthorizedExternalPdf(source, { dependencies: deps }))
      .rejects.toEqual(new ExternalCitationValidationError("invalid-pdf-url"));
    expect(response.destroy).toHaveBeenCalledOnce();
  });

  it("bounds redirect chains", async () => {
    const responses = Array.from({ length: MAX_EXTERNAL_PDF_REDIRECTS + 1 }, (_, index) =>
      pdfResponse({
        location: `https://redirect-${index}.example.test/paper.pdf`,
        statusCode: 302,
      })
    );
    const deps = dependencies({ responses });
    await expect(fetchAuthorizedExternalPdf(source, { dependencies: deps }))
      .rejects.toEqual(new ExternalCitationValidationError("invalid-pdf-redirect"));
    expect(deps.request).toHaveBeenCalledTimes(MAX_EXTERNAL_PDF_REDIRECTS + 1);
  });

  it.each([
    {
      label: "an oversized declared length",
      response: () => pdfResponse({ contentLength: String(MAX_EXTERNAL_PDF_BYTES + 1) }),
      reason: "pdf-too-large",
    },
    {
      label: "an oversized streamed body",
      response: () => pdfResponse({ body: Buffer.alloc(MAX_EXTERNAL_PDF_BYTES + 1) }),
      reason: "pdf-too-large",
    },
    {
      label: "a non-PDF media type",
      response: () => pdfResponse({ contentType: "text/html" }),
      reason: "invalid-pdf-response",
    },
    {
      label: "encoded content",
      response: () => pdfResponse({ contentEncoding: "gzip" }),
      reason: "invalid-pdf-response",
    },
    {
      label: "a false PDF signature",
      response: () => pdfResponse({ body: Buffer.from("not a PDF") }),
      reason: "invalid-pdf-response",
    },
    {
      label: "a mismatched declared length",
      response: () => pdfResponse({ contentLength: "999" }),
      reason: "invalid-pdf-response",
    },
  ])("rejects $label", async ({ response, reason }) => {
    const failureResponse = response();
    const deps = dependencies({ responses: [failureResponse] });
    await expect(fetchAuthorizedExternalPdf(source, { dependencies: deps }))
      .rejects.toEqual(new ExternalCitationValidationError(reason));
    expect(failureResponse.destroy).toHaveBeenCalledOnce();
  });

  it("turns a bounded fetch timeout into a safe validation failure", async () => {
    const deps = dependencies();
    deps.resolve.mockImplementation(async (_hostname: string, signal: AbortSignal) =>
      await new Promise<Array<{ address: string; family: 4 | 6 }>>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      })
    );
    await expect(fetchAuthorizedExternalPdf(source, {
      dependencies: deps,
      timeoutMs: 5,
    })).rejects.toEqual(new ExternalCitationValidationError("pdf-fetch-failed"));
    expect(deps.request).not.toHaveBeenCalled();
  });

  it("destroys an established response when its body exceeds the fetch deadline", async () => {
    const deps = dependencies();
    const response = pdfResponse();
    deps.request.mockImplementation(async (_url, _address, signal) => ({
      ...response,
      body: (async function* () {
        yield Buffer.from("%PDF-");
        await new Promise<never>((_resolve, reject) => {
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      })(),
    }));

    await expect(fetchAuthorizedExternalPdf(source, {
      dependencies: deps,
      timeoutMs: 5,
    })).rejects.toEqual(new ExternalCitationValidationError("pdf-fetch-failed"));
    expect(response.destroy).toHaveBeenCalledOnce();
  });
});
