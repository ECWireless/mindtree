import { describe, expect, it } from "vitest";

import {
  ExternalCitationValidationError,
  createExternalCitationEvidence,
  mergeExternalCitationEvidenceBounded,
  normalizeExternalCitationAnnotations,
  normalizeExternalCitationMentions,
  normalizeExternalUrl,
  requireNonOverlappingSynthesisCitations,
  toExternalResearchEvidence,
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

  it("maps exact proposal phrases to validated evidence in first-use order", () => {
    const researchContent = "First research claim. Second research claim.";
    const evidence = createExternalCitationEvidence({
      content: researchContent,
      owner: "assistant-message",
      ownerId: "00000000-0000-4000-8000-000000000001",
      citations: [
        {
          kind: "external",
          ordinal: 1,
          startUtf16: 21,
          endUtf16: 21,
          title: "Source one",
          url: "https://one.example.test/report#fragment",
        },
        {
          kind: "external",
          ordinal: 2,
          startUtf16: researchContent.length,
          endUtf16: researchContent.length,
          title: "Source two",
          url: "https://two.example.test/report",
        },
      ],
    });
    expect(evidence).toMatchObject([
      { alias: "W1", title: "Source one", url: "https://one.example.test/report" },
      { alias: "W2", title: "Source two", url: "https://two.example.test/report" },
    ]);
    expect(toExternalResearchEvidence(evidence)).toMatchObject([
      {
        alias: "W1",
        excerpts: [{
          supportedTextBeforeCitation: "First research claim.",
          followingContext: " Second research claim.",
        }],
      },
      {
        alias: "W2",
        excerpts: [{
          supportedTextBeforeCitation: "First research claim. Second research claim.",
          followingContext: "",
        }],
      },
    ]);

    const content = "The second source supports batteries. The first supports storage.";
    expect(normalizeExternalCitationMentions({
      content,
      evidence,
      mentions: [
        { sourceAlias: "W2", citedText: "batteries" },
        { sourceAlias: "W1", citedText: "storage" },
      ],
    })).toEqual([
      {
        kind: "external",
        ordinal: 1,
        startUtf16: content.indexOf("batteries") + "batteries".length,
        endUtf16: content.indexOf("batteries") + "batteries".length,
        title: "Source two",
        url: "https://two.example.test/report",
      },
      {
        kind: "external",
        ordinal: 2,
        startUtf16: content.length - 1,
        endUtf16: content.length - 1,
        title: "Source one",
        url: "https://one.example.test/report",
      },
    ]);
  });

  it("rejects invented aliases and ambiguous cited phrases", () => {
    const evidence = [{ alias: "W1", title: "Source", url: "https://example.test/source" }];
    expect(() => normalizeExternalCitationMentions({
      content: "repeated claim and repeated claim.",
      evidence,
      mentions: [{ sourceAlias: "W1", citedText: "repeated claim" }],
    })).toThrowError(new ExternalCitationValidationError("invalid-mention"));
    expect(() => normalizeExternalCitationMentions({
      content: "Unique claim.",
      evidence,
      mentions: [{ sourceAlias: "W2", citedText: "Unique claim" }],
    })).toThrowError(new ExternalCitationValidationError("invalid-mention"));
  });

  it("rejects an external marker that would be hidden inside an internal link", () => {
    expect(() => requireNonOverlappingSynthesisCitations({
      external: [{ startUtf16: 10 }],
      internal: [{ startUtf16: 4, endUtf16: 14 }],
    })).toThrowError(new ExternalCitationValidationError("overlapping-mention"));
    expect(() => requireNonOverlappingSynthesisCitations({
      external: [{ startUtf16: 14 }],
      internal: [{ startUtf16: 4, endUtf16: 14 }],
    })).not.toThrow();
  });

  it("keeps source aliases structurally separate from marker-shaped research text", () => {
    const content = "A source says [W2] is user-authored text.";
    const evidence = createExternalCitationEvidence({
      content,
      citations: [{
        kind: "external",
        ordinal: 1,
        startUtf16: content.length,
        endUtf16: content.length,
        title: "Source",
        url: "https://example.test/source",
      }],
      owner: "assistant-message",
      ownerId: "00000000-0000-4000-8000-000000000001",
    });
    expect(toExternalResearchEvidence(evidence)[0]).toEqual({
      alias: "W1",
      excerpts: [{
        supportedTextBeforeCitation: "A source says [W2] is user-authored text.",
        followingContext: "",
      }],
    });
  });

  it("keeps following contradictory text outside the supported annotation boundary", () => {
    const content = "The measured value is ten. The measured value is not ten.";
    const boundary = "The measured value is ten.".length;
    const evidence = createExternalCitationEvidence({
      content,
      citations: [{
        kind: "external",
        ordinal: 1,
        startUtf16: boundary,
        endUtf16: boundary,
        title: "Measurement source",
        url: "https://example.test/measurement",
      }],
      owner: "assistant-message",
      ownerId: "00000000-0000-4000-8000-000000000001",
    });
    expect(toExternalResearchEvidence(evidence)[0]?.excerpts[0]).toEqual({
      supportedTextBeforeCitation: "The measured value is ten.",
      followingContext: " The measured value is not ten.",
    });
  });

  it("prioritizes current evidence when historical source and occurrence bounds are full", () => {
    const source = (index: number, occurrences = 1) => ({
      alias: `W${index}`,
      title: `Source ${index}`,
      url: `https://source-${index}.example.test/`,
      excerpts: Array.from({ length: occurrences }, (_, occurrence) => ({
        before: `Claim ${index}-${occurrence}.`,
        after: "",
        truncatedBefore: false,
        truncatedAfter: false,
      })),
      provenance: Array.from({ length: occurrences }, (_, occurrence) => ({
        owner: "assistant-message" as const,
        ownerId: `message-${index}`,
        ordinal: index,
        startUtf16: occurrence,
        endUtf16: occurrence,
      })),
    });
    const current = [source(1)];
    const saturatedSources = Array.from({ length: 32 }, (_, index) => source(index + 1));
    const mergedSources = mergeExternalCitationEvidenceBounded([current, saturatedSources]);
    expect(mergedSources).toHaveLength(32);
    expect(mergedSources[0]?.url).toBe("https://source-1.example.test/");
    expect(mergedSources.at(-1)?.url).toBe("https://source-32.example.test/");

    const saturatedOccurrences = [{ ...source(2, 64), alias: "W1" }];
    const mergedOccurrences = mergeExternalCitationEvidenceBounded([
      [source(1)],
      saturatedOccurrences,
    ]);
    expect(mergedOccurrences[0]?.provenance).toHaveLength(1);
    expect(mergedOccurrences[0]?.provenance[0]?.ownerId).toBe("message-1");
    expect(mergedOccurrences[1]?.provenance).toHaveLength(63);
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
