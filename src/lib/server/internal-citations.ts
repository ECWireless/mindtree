import "server-only";

import type { InternalCitationMention } from "@/lib/citations/contracts";

export type InternalCitationEvidence = {
  alias: string;
  nodeId: string;
  parentId: string | null;
  title: string;
  archived: boolean;
  synthesisVersionId: string;
  content: string;
  sourceStateFingerprint: string;
};

export type NormalizedInternalCitation = {
  ordinal: number;
  startUtf16: number;
  endUtf16: number;
  evidence: InternalCitationEvidence;
};

export class InternalCitationValidationError extends Error {
  constructor(public readonly reason:
    | "ambiguous-span"
    | "duplicate-evidence-alias"
    | "overlapping-span"
    | "unknown-evidence-alias") {
    super(reason);
    this.name = "InternalCitationValidationError";
  }
}

export function assignInternalEvidenceAliases(
  relatedNodes: readonly Omit<InternalCitationEvidence, "alias">[],
): InternalCitationEvidence[] {
  return relatedNodes.map((node, index) => ({ ...node, alias: `E${index + 1}` }));
}

export function normalizeInternalCitationMentions(input: {
  content: string;
  mentions: readonly InternalCitationMention[];
  evidence: readonly InternalCitationEvidence[];
}): NormalizedInternalCitation[] {
  const byAlias = new Map<string, InternalCitationEvidence>();
  for (const evidence of input.evidence) {
    if (byAlias.has(evidence.alias)) {
      throw new InternalCitationValidationError("duplicate-evidence-alias");
    }
    byAlias.set(evidence.alias, evidence);
  }

  const resolved = input.mentions.map((mention) => {
    const evidence = byAlias.get(mention.evidenceAlias);
    if (!evidence) {
      throw new InternalCitationValidationError("unknown-evidence-alias");
    }
    const startUtf16 = input.content.indexOf(mention.citedText);
    if (
      startUtf16 < 0 ||
      input.content.indexOf(mention.citedText, startUtf16 + 1) >= 0
    ) {
      throw new InternalCitationValidationError("ambiguous-span");
    }
    return {
      startUtf16,
      endUtf16: startUtf16 + mention.citedText.length,
      evidence,
    };
  }).sort((left, right) =>
    left.startUtf16 - right.startUtf16 ||
    left.endUtf16 - right.endUtf16 ||
    left.evidence.alias.localeCompare(right.evidence.alias)
  );

  for (let index = 1; index < resolved.length; index += 1) {
    if (resolved[index]!.startUtf16 < resolved[index - 1]!.endUtf16) {
      throw new InternalCitationValidationError("overlapping-span");
    }
  }

  return resolved.map((citation, index) => ({
    ...citation,
    ordinal: index + 1,
  }));
}
