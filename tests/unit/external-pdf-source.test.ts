import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ExternalCitationValidationError } from "@/lib/server/external-citations";
import { findAuthorizedExternalPdfSource } from "@/lib/server/external-pdf-source";

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
});
