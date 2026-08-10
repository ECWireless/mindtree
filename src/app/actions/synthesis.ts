"use server";

import { revalidatePath } from "next/cache";

import {
  synthesisDecisionInputSchema,
  type SynthesisDecisionResult,
} from "@/lib/synthesis/contracts";
import { requireAuthorizedSession } from "@/lib/server/authorization";
import {
  approveSynthesisProposalForUser,
  rejectSynthesisProposalForUser,
  SynthesisServiceError,
} from "@/lib/server/synthesis-service";

function decisionFailure(error: unknown): SynthesisDecisionResult {
  if (error instanceof SynthesisServiceError) {
    switch (error.reason) {
      case "node-not-found":
      case "proposal-not-found":
        return { ok: false, message: "That synthesis proposal is no longer available." };
      case "proposal-not-pending":
        return { ok: false, message: "That synthesis proposal was already decided." };
      case "stale-base":
        return {
          ok: false,
          message: "The published synthesis changed. Request a fresh proposal before approving.",
        };
      case "stale-input":
        return {
          ok: false,
          message: "The Branch Outline changed or became stale. Regenerate it, then request a fresh Summary proposal.",
        };
      case "invalid-proposal":
      case "unavailable":
        return {
          ok: false,
          message: "MindTree couldn’t save that synthesis decision. Please try again.",
        };
    }
  }
  throw error;
}

export async function approveSynthesisProposal(
  input: unknown,
): Promise<SynthesisDecisionResult> {
  const session = await requireAuthorizedSession();
  const parsed = synthesisDecisionInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: "That synthesis proposal is invalid." };
  }

  try {
    const approved = await approveSynthesisProposalForUser(session.user.id, parsed.data);
    revalidatePath("/");
    return {
      ok: true,
      nodeId: approved.nodeId,
      proposalId: approved.id,
      status: "approved",
    };
  } catch (error) {
    return decisionFailure(error);
  }
}

export async function rejectSynthesisProposal(
  input: unknown,
): Promise<SynthesisDecisionResult> {
  const session = await requireAuthorizedSession();
  const parsed = synthesisDecisionInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: "That synthesis proposal is invalid." };
  }

  try {
    const rejected = await rejectSynthesisProposalForUser(session.user.id, parsed.data);
    revalidatePath("/");
    return {
      ok: true,
      nodeId: rejected.nodeId,
      proposalId: rejected.id,
      status: "rejected",
    };
  } catch (error) {
    return decisionFailure(error);
  }
}
