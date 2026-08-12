import { describe, expect, it } from "vitest";

import {
  MAX_SYNTHESIS_CONTENT_LENGTH,
  synthesisProposalDraftSchema,
} from "@/lib/synthesis/contracts";

describe("synthesis proposal contracts", () => {
  it("accepts the approved concise Markdown subset and trims it", () => {
    expect(synthesisProposalDraftSchema.parse({
      content: "  # Direction\n\n- **First** point\n- *Second* point  ",
      citations: [],
    })).toEqual({
      content: "# Direction\n\n- **First** point\n- *Second* point",
      citations: [],
      externalCitations: [],
    });
  });

  it("accepts bounded external citation mentions and rejects raw URLs", () => {
    expect(synthesisProposalDraftSchema.parse({
      content: "A supported external claim.",
      citations: [],
      externalCitations: [{ sourceAlias: "W1", citedText: "external claim" }],
    }).externalCitations).toEqual([
      { sourceAlias: "W1", citedText: "external claim" },
    ]);
    expect(synthesisProposalDraftSchema.safeParse({
      content: "See https://example.test/source for details.",
      citations: [],
      externalCitations: [],
    }).success).toBe(false);
  });

  it.each([
    "<script>alert('no')</script>",
    "[external](https://example.test)",
    "![image](https://example.test/image.png)",
    "[reference][source]\n\n[source]: https://example.test",
    "![reference image][source]\n\n[source]: https://example.test/image.png",
    "`code`",
    "~~~text\ncode\n~~~",
    "Paragraph\n\n    indented code",
    "Paragraph\n\n     five-space indented code",
    "Paragraph\n\n\tindented code",
    "Paragraph\n\n  \tmixed indented code",
    "> blockquote",
    "Header | Value\n--- | ---\nCell | Cell",
    "Hidden\u0000separator",
    "Hidden\u001fseparator",
  ])("rejects unsupported proposal Markdown: %s", (content) => {
    expect(synthesisProposalDraftSchema.safeParse({ content, citations: [] }).success).toBe(false);
  });

  it("rejects empty and oversized synthesis content", () => {
    expect(synthesisProposalDraftSchema.safeParse({ content: "   ", citations: [] }).success)
      .toBe(false);
    expect(synthesisProposalDraftSchema.safeParse({
      content: "x".repeat(MAX_SYNTHESIS_CONTENT_LENGTH + 1),
      citations: [],
    }).success).toBe(false);
  });

  it("rejects unexpected structured proposal fields", () => {
    expect(synthesisProposalDraftSchema.safeParse({
      content: "Valid proposal",
      citations: [],
      unexpected: "provider field",
    }).success).toBe(false);
  });
});
