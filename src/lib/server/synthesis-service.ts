import "server-only";

import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { nodes, synthesisVersions } from "@/db/schema";
import { OPENAI_SYNTHESIS_MODEL } from "@/lib/ai/openai-profiles";
import {
  synthesisProposalDraftSchema,
  type SynthesisProposalDraft,
  type SynthesisVersion,
  type SynthesisWorkspace,
} from "@/lib/synthesis/contracts";

type SynthesisTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type PendingSynthesisProposalInput = {
  baseVersionId: string | null;
  draft: SynthesisProposalDraft;
  model: typeof OPENAI_SYNTHESIS_MODEL;
  reasoningMode: "pro";
  reasoningEffort: "high";
  inputFingerprint: string;
};

type InsertPendingSynthesisProposalInput = PendingSynthesisProposalInput & {
  userId: string;
  nodeId: string;
  generatingMessageId: string;
};

export class SynthesisServiceError extends Error {
  constructor(public readonly reason: "invalid-proposal" | "node-not-found" | "unavailable") {
    super(reason);
    this.name = "SynthesisServiceError";
  }
}

function toSynthesisVersion(
  row: typeof synthesisVersions.$inferSelect,
): SynthesisVersion {
  return {
    id: row.id,
    nodeId: row.nodeId,
    baseVersionId: row.baseVersionId,
    status: row.status,
    content: row.content,
    model: row.model,
    reasoningMode: row.reasoningMode,
    reasoningEffort: row.reasoningEffort,
    inputFingerprint: row.inputFingerprint,
    generatingMessageId: row.generatingMessageId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
  };
}

export async function insertPendingSynthesisProposal(
  tx: SynthesisTransaction,
  input: InsertPendingSynthesisProposalInput,
) {
  const draft = synthesisProposalDraftSchema.safeParse(input.draft);
  if (
    !draft.success ||
    input.model !== OPENAI_SYNTHESIS_MODEL ||
    !/^[0-9a-f]{64}$/.test(input.inputFingerprint)
  ) {
    throw new SynthesisServiceError("invalid-proposal");
  }

  const [created] = await tx
    .insert(synthesisVersions)
    .values({
      userId: input.userId,
      nodeId: input.nodeId,
      baseVersionId: input.baseVersionId,
      status: "pending",
      content: draft.data.content,
      model: input.model,
      reasoningMode: input.reasoningMode,
      reasoningEffort: input.reasoningEffort,
      inputFingerprint: input.inputFingerprint,
      generatingMessageId: input.generatingMessageId,
    })
    .returning();
  if (!created) {
    throw new SynthesisServiceError("unavailable");
  }
  return toSynthesisVersion(created);
}

export async function getSynthesisWorkspaceForUser(
  userId: string,
  nodeId: string,
): Promise<SynthesisWorkspace> {
  return db.transaction(async (tx) => {
    const [node] = await tx
      .select({ publishedSynthesisVersionId: nodes.publishedSynthesisVersionId })
      .from(nodes)
      .where(and(eq(nodes.userId, userId), eq(nodes.id, nodeId)));
    if (!node) {
      throw new SynthesisServiceError("node-not-found");
    }

    const [published] = node.publishedSynthesisVersionId
      ? await tx
        .select()
        .from(synthesisVersions)
        .where(
          and(
            eq(synthesisVersions.userId, userId),
            eq(synthesisVersions.nodeId, nodeId),
            eq(synthesisVersions.id, node.publishedSynthesisVersionId),
          ),
        )
        .limit(1)
      : [];
    if (node.publishedSynthesisVersionId && (!published || published.status !== "approved")) {
      throw new SynthesisServiceError("unavailable");
    }

    const pendingVersions = await tx
      .select()
      .from(synthesisVersions)
      .where(
        and(
          eq(synthesisVersions.userId, userId),
          eq(synthesisVersions.nodeId, nodeId),
          eq(synthesisVersions.status, "pending"),
        ),
      )
      .limit(2);
    if (pendingVersions.length > 1) {
      throw new SynthesisServiceError("unavailable");
    }

    return {
      published: published ? toSynthesisVersion(published) : null,
      pending: pendingVersions[0] ? toSynthesisVersion(pendingVersions[0]) : null,
    };
  }, {
    accessMode: "read only",
    isolationLevel: "repeatable read",
  });
}
