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
import { getServerEnvironment } from "@/lib/env/server";
import {
  createOpenAISafetyIdentifier,
  isDeterministicChatFixtureEnabled,
} from "@/lib/server/chat-runtime";
import { refreshApprovedSynthesisEmbeddingForUser } from "@/lib/server/embedding-service";
import { createOpenAIEmbedding } from "@/lib/server/openai-embeddings";

async function refreshEmbeddingAfterApproval(input: {
  userId: string;
  nodeId: string;
  synthesisVersionId: string;
}) {
  if (isDeterministicChatFixtureEnabled()) return;
  const environment = getServerEnvironment();
  const apiKey = environment.OPENAI_API_KEY;
  const authSecret = environment.BETTER_AUTH_SECRET;
  if (!apiKey || !authSecret) return;

  const safetyIdentifier = createOpenAISafetyIdentifier(
    input.userId,
    authSecret,
  );
  const result = await refreshApprovedSynthesisEmbeddingForUser(input.userId, {
    nodeId: input.nodeId,
    synthesisVersionId: input.synthesisVersionId,
    embed: (content) => createOpenAIEmbedding({
      apiKey,
      content,
      safetyIdentifier,
    }),
  });
  if (result.status === "failed") {
    console.warn("Approved synthesis embedding refresh failed.", {
      nodeId: input.nodeId,
      synthesisVersionId: input.synthesisVersionId,
      failureCode: result.reason,
      retryable: true,
    });
  }
}

function decisionFailure(error: unknown): SynthesisDecisionResult {
  if (error instanceof SynthesisServiceError) {
    switch (error.reason) {
      case "node-not-found":
      case "proposal-not-found":
        return { ok: false, message: "That Summary proposal is no longer available." };
      case "proposal-not-pending":
        return { ok: false, message: "That Summary proposal was already decided." };
      case "stale-base":
        return {
          ok: false,
          message: "The published Summary changed. Request a fresh proposal before approving.",
        };
      case "stale-input":
        return {
          ok: false,
          message: "The Branch Outline or related evidence changed. Refresh the relevant context, then request a fresh Summary proposal.",
        };
      case "invalid-proposal":
      case "unavailable":
        return {
          ok: false,
          message: "MindTree couldn’t save that Summary proposal decision. Please try again.",
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
    return { ok: false, message: "That Summary proposal is invalid." };
  }

  try {
    const approved = await approveSynthesisProposalForUser(session.user.id, parsed.data);
    try {
      await refreshEmbeddingAfterApproval({
        userId: session.user.id,
        nodeId: approved.nodeId,
        synthesisVersionId: approved.id,
      });
    } catch {
      console.warn("Approved synthesis embedding refresh failed.", {
        nodeId: approved.nodeId,
        synthesisVersionId: approved.id,
        failureCode: "unexpected-failure",
        retryable: true,
      });
    }
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
    return { ok: false, message: "That Summary proposal is invalid." };
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
