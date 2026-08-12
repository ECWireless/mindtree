import { describe, expect, it } from "vitest";

import {
  ExternalCitationValidationError,
  normalizeExternalCitationAnnotations,
  normalizeExternalUrl,
} from "@/lib/server/external-citations";

describe("external citation normalization", () => {
  it("removes provider markers and reuses first-source ordinals across occurrences", () => {
    const content = "First claim.【source one】 Second claim.【source again】";
    const firstStart = content.indexOf("【source one】");
    const secondStart = content.indexOf("【source again】");
    const normalized = normalizeExternalCitationAnnotations({
      content,
      annotations: [
        {
          type: "url_citation",
          start_index: firstStart,
          end_index: firstStart + "【source one】".length,
          title: "  Synthetic   source  ",
          url: "HTTPS://EXAMPLE.TEST:443/report#section",
        },
        {
          type: "url_citation",
          start_index: secondStart,
          end_index: secondStart + "【source again】".length,
          title: "Later title for the same URL",
          url: "https://example.test/report",
        },
      ],
    });

    expect(normalized.content).toBe("First claim. Second claim.");
    expect(normalized.citations).toEqual([
      {
        kind: "external",
        ordinal: 1,
        startUtf16: "First claim.".length,
        endUtf16: "First claim.".length,
        title: "Synthetic source",
        url: "https://example.test/report",
      },
      {
        kind: "external",
        ordinal: 1,
        startUtf16: "First claim. Second claim.".length,
        endUtf16: "First claim. Second claim.".length,
        title: "Synthetic source",
        url: "https://example.test/report",
      },
    ]);
  });

  it("supports multiple distinct sources attached to one provider marker", () => {
    const content = "Supported claim.【sources】";
    const start = content.indexOf("【sources】");
    const normalized = normalizeExternalCitationAnnotations({
      content,
      annotations: [
        {
          type: "url_citation",
          start_index: start,
          end_index: content.length,
          title: "Source B",
          url: "https://b.example.test/",
        },
        {
          type: "url_citation",
          start_index: start,
          end_index: content.length,
          title: "Source A",
          url: "https://a.example.test/",
        },
      ],
    });

    expect(normalized.content).toBe("Supported claim.");
    expect(normalized.citations.map(({ ordinal, url, startUtf16 }) => ({
      ordinal,
      url,
      startUtf16,
    }))).toEqual([
      { ordinal: 1, url: "https://b.example.test/", startUtf16: 16 },
      { ordinal: 2, url: "https://a.example.test/", startUtf16: 16 },
    ]);
  });

  it.each([
    "javascript:alert(1)",
    "file:///private/file",
    "https://user:secret@example.test/private",
    "not a URL",
  ])("rejects unsafe external URL %s", (url) => {
    expect(() => normalizeExternalUrl(url)).toThrowError(
      new ExternalCitationValidationError("invalid-url"),
    );
  });

  it("rejects missing, invalid, partially overlapping, and content-consuming annotations", () => {
    expect(() => normalizeExternalCitationAnnotations({ content: "text", annotations: [] }))
      .toThrowError(new ExternalCitationValidationError("invalid-count"));

    const base = {
      type: "url_citation" as const,
      title: "Source",
      url: "https://example.test/source",
    };
    expect(() => normalizeExternalCitationAnnotations({
      content: "abcdef",
      annotations: [{ ...base, start_index: 2, end_index: 8 }],
    })).toThrowError(new ExternalCitationValidationError("invalid-location"));
    expect(() => normalizeExternalCitationAnnotations({
      content: "abcdef",
      annotations: [
        { ...base, start_index: 1, end_index: 4 },
        { ...base, start_index: 3, end_index: 5 },
      ],
    })).toThrowError(new ExternalCitationValidationError("overlapping-location"));
    expect(() => normalizeExternalCitationAnnotations({
      content: "marker",
      annotations: [{ ...base, start_index: 0, end_index: 6 }],
    })).toThrowError(new ExternalCitationValidationError("empty-content"));
  });
});
