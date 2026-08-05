import { z } from "zod";

export const MAX_SYNTHESIS_CONTENT_LENGTH = 32_000;

const unsupportedInlineMarkdown = /[<>\[\]`|]/;
const unsupportedBlockMarkdown = /^(?: {0,3}\t| {4}| {0,3}~~~| {0,3}(?:[-*_][ \t]*){3,}$)/m;
const unsupportedControlCharacter = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export const synthesisStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "superseded",
]);

export const synthesisProposalDraftSchema = z.object({
  content: z
    .string()
    .trim()
    .min(1)
    .max(MAX_SYNTHESIS_CONTENT_LENGTH)
    .refine(
      (content) => !unsupportedControlCharacter.test(content),
      "Control characters are not supported.",
    )
    .refine(
      (content) =>
        !unsupportedInlineMarkdown.test(content) &&
        !unsupportedBlockMarkdown.test(content),
      "Use only paragraphs, headings, lists, and emphasis.",
    ),
}).strict();

export const synthesisDecisionInputSchema = z.object({
  nodeId: z.uuid(),
  proposalId: z.uuid(),
}).strict();

export type SynthesisStatus = z.infer<typeof synthesisStatusSchema>;
export type SynthesisProposalDraft = z.infer<typeof synthesisProposalDraftSchema>;
export type SynthesisDecisionInput = z.infer<typeof synthesisDecisionInputSchema>;

export type SynthesisDecisionResult =
  | {
      ok: true;
      nodeId: string;
      proposalId: string;
      status: "approved" | "rejected";
    }
  | { ok: false; message: string };

export type SynthesisVersion = {
  id: string;
  nodeId: string;
  baseVersionId: string | null;
  status: SynthesisStatus;
  content: string;
  model: string;
  reasoningMode: string;
  reasoningEffort: string;
  inputFingerprint: string;
  generatingMessageId: string;
  createdAt: string;
  updatedAt: string;
  decidedAt: string | null;
};

export type SynthesisDecisionSummary = {
  id: string;
  generatingMessageId: string;
  status: Exclude<SynthesisStatus, "pending">;
  content: string;
  baseContent: string | null;
  decidedAt: string;
};

export type SynthesisWorkspace = {
  published: SynthesisVersion | null;
  staleAt: string | null;
  pending: SynthesisVersion | null;
  history: SynthesisDecisionSummary[];
};
