import { describe, expect, it } from "vitest";

import { createSynthesisDiff } from "@/lib/synthesis/diff";

describe("synthesis diff presentation", () => {
  it("marks a first proposal as added against an empty baseline", () => {
    expect(createSynthesisDiff(null, "# Summary\n\n- First point")).toEqual({
      limited: false,
      parts: [{ kind: "added", content: "# Summary\n\n- First point" }],
    });
  });

  it("keeps additions, removals, and unchanged context explicit", () => {
    expect(createSynthesisDiff(
      "# Summary\n\nOld point\n\nShared point\n",
      "# Summary\n\nNew point\n\nShared point\n",
    )).toEqual({
      limited: false,
      parts: [
        { kind: "unchanged", content: "# Summary\n\n" },
        { kind: "removed", content: "Old point\n" },
        { kind: "added", content: "New point\n" },
        { kind: "unchanged", content: "\nShared point\n" },
      ],
    });
  });

  it("preserves long unbroken content for wrapping in the renderer", () => {
    const content = "a".repeat(4_000);
    expect(createSynthesisDiff("", content)).toEqual({
      limited: false,
      parts: [{ kind: "added", content }],
    });
  });

  it("falls back to a bounded whole-document comparison for adversarial line changes", () => {
    const published = Array.from({ length: 4_000 }, (_, index) => `o${index}`).join("\n");
    const proposed = Array.from({ length: 4_000 }, (_, index) => `n${index}`).join("\n");
    const startedAt = performance.now();
    const result = createSynthesisDiff(published, proposed);

    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(result).toEqual({
      limited: true,
      parts: [
        { kind: "removed", content: published },
        { kind: "added", content: proposed },
      ],
    });
  });
});
