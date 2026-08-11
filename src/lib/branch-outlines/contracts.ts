import { z } from "zod";

import {
  MAX_SYNTHESIS_CONTENT_LENGTH,
  synthesisContentSchema,
} from "@/lib/synthesis/contracts";

export const MAX_BRANCH_OUTLINE_CONTENT_LENGTH = MAX_SYNTHESIS_CONTENT_LENGTH;

export const branchOutlineStatusSchema = z.enum([
  "pending",
  "completed",
  "failed",
]);

export const branchOutlineFailureCodeSchema = z.enum([
  "generation-failed",
  "provider-refusal",
  "provider-timeout",
  "response-invalid",
  "stream-disconnected",
  "inputs-changed",
]);

export const branchOutlineStaleReasonSchema = z.enum([
  "summary-changed",
  "branch-structure-changed",
  "branch-content-changed",
  "branch-availability-changed",
  "node-renamed",
]);

export const branchOutlineDraftSchema = z.object({
  content: synthesisContentSchema,
}).strict();

export const generateBranchOutlineInputSchema = z.object({
  nodeId: z.uuid(),
  clientRequestId: z.uuid(),
}).strict();

export const loadBranchOutlineWorkspaceInputSchema = z.object({
  nodeId: z.uuid(),
}).strict();

export const branchOutlineInputSnapshotSchema = z.object({
  sourceNodeId: z.uuid(),
  sourceSynthesisVersionId: z.uuid().nullable(),
  sourceBranchOutlineVersionId: z.uuid().nullable(),
  summaryState: z.enum(["none", "published"]),
  outlineState: z.enum(["none", "current", "stale"]),
  sourceStateFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  position: z.number().int().nonnegative(),
}).strict().superRefine((input, context) => {
  if (
    (input.summaryState === "none") !==
    (input.sourceSynthesisVersionId === null)
  ) {
    context.addIssue({
      code: "custom",
      message: "Summary state and version must agree.",
      path: ["sourceSynthesisVersionId"],
    });
  }
  if (
    (input.outlineState === "none") !==
    (input.sourceBranchOutlineVersionId === null)
  ) {
    context.addIssue({
      code: "custom",
      message: "Outline state and version must agree.",
      path: ["sourceBranchOutlineVersionId"],
    });
  }
});

export const claimBranchOutlineGenerationInputSchema = z.object({
  nodeId: z.uuid(),
  clientRequestId: z.uuid(),
  baseSynthesisVersionId: z.uuid().nullable(),
  inputFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  inputs: z.array(branchOutlineInputSnapshotSchema),
}).strict();

export const completeBranchOutlineGenerationInputSchema = z.object({
  nodeId: z.uuid(),
  generationId: z.uuid(),
  draft: branchOutlineDraftSchema,
}).strict();

export const failBranchOutlineGenerationInputSchema = z.object({
  nodeId: z.uuid(),
  generationId: z.uuid(),
  failureCode: branchOutlineFailureCodeSchema,
}).strict();

export const recordBranchOutlineProviderResponseInputSchema = z.object({
  nodeId: z.uuid(),
  generationId: z.uuid(),
  providerResponseId: z.string().min(1).max(255),
}).strict();

export type BranchOutlineStatus = z.infer<typeof branchOutlineStatusSchema>;
export type BranchOutlineFailureCode = z.infer<typeof branchOutlineFailureCodeSchema>;
export type BranchOutlineStaleReason = z.infer<typeof branchOutlineStaleReasonSchema>;
export type BranchOutlineDraft = z.infer<typeof branchOutlineDraftSchema>;
export type GenerateBranchOutlineInput = z.infer<
  typeof generateBranchOutlineInputSchema
>;
export type BranchOutlineInputSnapshot = z.infer<
  typeof branchOutlineInputSnapshotSchema
>;
export type ClaimBranchOutlineGenerationInput = z.infer<
  typeof claimBranchOutlineGenerationInputSchema
>;
export type CompleteBranchOutlineGenerationInput = z.infer<
  typeof completeBranchOutlineGenerationInputSchema
>;
export type FailBranchOutlineGenerationInput = z.infer<
  typeof failBranchOutlineGenerationInputSchema
>;
export type RecordBranchOutlineProviderResponseInput = z.infer<
  typeof recordBranchOutlineProviderResponseInputSchema
>;

export type BranchOutlineVersion = {
  id: string;
  nodeId: string;
  clientRequestId: string;
  baseSynthesisVersionId: string | null;
  status: BranchOutlineStatus;
  content: string;
  model: string;
  reasoningMode: string;
  reasoningEffort: string;
  inputFingerprint: string;
  providerResponseId: string | null;
  failureCode: BranchOutlineFailureCode | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type BranchOutlineWorkspace = {
  current: BranchOutlineVersion | null;
  pending: BranchOutlineVersion | null;
  latestFailure: BranchOutlineVersion | null;
  staleAt: string | null;
  staleReason: BranchOutlineStaleReason | null;
};

export type BranchOutlineStreamEvent =
  | { type: "generation"; generation: BranchOutlineVersion }
  | { type: "delta"; content: string }
  | {
      type: "completed";
      generation: BranchOutlineVersion;
      installed: boolean;
    }
  | { type: "failed"; generation: BranchOutlineVersion };
