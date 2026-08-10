import "server-only";

import { z } from "zod";

import {
  branchOutlineDraftSchema,
  MAX_BRANCH_OUTLINE_CONTENT_LENGTH,
  type BranchOutlineDraft,
} from "@/lib/branch-outlines/contracts";

const MAX_BRANCH_OUTLINE_DESCRIPTION_LENGTH = 600;
const unsupportedControlCharacter = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const artifactStateNoun = String.raw`(?:summary|branch\s+outline|outline)`;
const evidenceStateNoun = String.raw`(?:${artifactStateNoun}|evidence|context)`;
const evidenceStateBoilerplate = new RegExp([
  String.raw`\b${evidenceStateNoun}\s+(?:(?:is|was|were|has\s+been|had\s+been)\s+)?(?:missing|stale|unavailable|current|approved|unpublished|absent)\b`,
  String.raw`\b${evidenceStateNoun}\s+(?:(?:is|was|were|has\s+been|had\s+been)\s+)?not\s+(?:provided|available|present|published|approved)\b`,
  String.raw`\b(?:missing|stale|unavailable|current|approved|unpublished|absent)\s+${evidenceStateNoun}\b`,
  String.raw`\bno\s+(?:approved\s+|current\s+|published\s+)?${artifactStateNoun}\b`,
  String.raw`\b(?:lacks?|lacked|lacking|without)\s+(?:an?\s+|the\s+)?${artifactStateNoun}\b`,
  String.raw`\bno\s+(?:evidence|context)\s+(?:(?:is|was|were|has\s+been|had\s+been)\s+)?(?:provided|available|present|exists?)\b`,
  String.raw`\bnot\s+archived\b`,
  String.raw`\b(?:this\s+|the\s+)?(?:node|child)\s+(?:is|was|has\s+been)\s+(?:not\s+)?archived\b`,
  String.raw`\b(?:this\s+|the\s+)?(?:node|child)\s+(?:is|was)\s+in\s+(?:the\s+)?archive\b`,
].join("|"), "i");

const modelItemSchema = z.object({
  ordinal: z.number().int().positive(),
  description: z
    .string()
    .trim()
    .min(1)
    .max(MAX_BRANCH_OUTLINE_DESCRIPTION_LENGTH)
    .refine((description) => !/[\r\n]/.test(description))
    .refine((description) => !unsupportedControlCharacter.test(description))
    .refine((description) => !evidenceStateBoilerplate.test(description)),
}).strict();

const modelOutputSchema = z.object({
  items: z.array(modelItemSchema),
}).strict();

export class BranchOutlineOutputError extends Error {
  constructor(public readonly reason: "invalid-output" | "output-too-large") {
    super(reason);
    this.name = "BranchOutlineOutputError";
  }
}

function safeTitle(title: string) {
  const replacements: Record<string, string> = {
    "<": "‹",
    ">": "›",
    "[": "(",
    "]": ")",
    "`": "'",
    "|": "¦",
    "\\": "／",
    "*": "∗",
    "_": "＿",
  };
  return title
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[<>\[\]`|\\*_]/g, (character) => replacements[character] ?? "");
}

function renderOutline(
  titles: readonly string[],
  descriptions: readonly string[],
) {
  if (titles.length === 0) return "No direct child nodes.";
  return titles
    .map((title, index) => `- ${safeTitle(title)} — ${descriptions[index]}`)
    .join("\n");
}

export function requireBranchOutlineOutputFeasible(titles: readonly string[]) {
  const descriptions = titles.map(() => "x");
  const minimumModelOutput = JSON.stringify({
    items: titles.map((_, index) => ({ ordinal: index + 1, description: "x" })),
  });
  const minimumRenderedOutput = renderOutline(titles, descriptions);
  if (
    minimumModelOutput.length > MAX_BRANCH_OUTLINE_CONTENT_LENGTH ||
    minimumRenderedOutput.length > MAX_BRANCH_OUTLINE_CONTENT_LENGTH
  ) {
    throw new BranchOutlineOutputError("output-too-large");
  }
}

export function compileBranchOutlineModelOutput(
  rawOutput: string,
  titles: readonly string[],
): BranchOutlineDraft {
  let decoded: unknown;
  try {
    decoded = JSON.parse(rawOutput);
  } catch {
    throw new BranchOutlineOutputError("invalid-output");
  }
  const parsed = modelOutputSchema.safeParse(decoded);
  if (!parsed.success || parsed.data.items.length !== titles.length) {
    throw new BranchOutlineOutputError("invalid-output");
  }
  for (const [index, item] of parsed.data.items.entries()) {
    if (item.ordinal !== index + 1) {
      throw new BranchOutlineOutputError("invalid-output");
    }
  }
  const draft = branchOutlineDraftSchema.safeParse({
    content: renderOutline(
      titles,
      parsed.data.items.map(({ description }) => description),
    ),
  });
  if (!draft.success) {
    throw new BranchOutlineOutputError("invalid-output");
  }
  return draft.data;
}
