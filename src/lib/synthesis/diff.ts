import { diffLines } from "diff";

export type SynthesisDiffPart = {
  kind: "added" | "removed" | "unchanged";
  content: string;
};

export type SynthesisDiffResult = {
  parts: SynthesisDiffPart[];
  limited: boolean;
};

export function createSynthesisDiff(
  publishedContent: string | null,
  proposedContent: string,
): SynthesisDiffResult {
  const baseline = publishedContent ?? "";
  const detailed = diffLines(baseline, proposedContent, {
    maxEditLength: 1_000,
    timeout: 30,
  });
  const changes = detailed ?? [
    ...(baseline ? [{ value: baseline, removed: true }] : []),
    { value: proposedContent, added: true },
  ];
  return {
    limited: detailed === undefined,
    parts: changes.map((part) => ({
      kind: part.added ? "added" : part.removed ? "removed" : "unchanged",
      content: part.value,
    })),
  };
}
