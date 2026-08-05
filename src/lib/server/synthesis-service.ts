import "server-only";

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { DrizzleError, DrizzleQueryError } from "drizzle-orm/errors";

import { db } from "@/db/client";
import { nodes, synthesisVersions, user } from "@/db/schema";
import { OPENAI_SYNTHESIS_MODEL } from "@/lib/ai/openai-profiles";
import {
  synthesisProposalDraftSchema,
  type SynthesisDecisionInput,
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
  refinementProposalId?: string | null;
};

type InsertPendingSynthesisProposalInput = PendingSynthesisProposalInput & {
  userId: string;
  nodeId: string;
  generatingMessageId: string;
};

export class SynthesisServiceError extends Error {
  constructor(public readonly reason:
    | "invalid-proposal"
    | "node-not-found"
    | "proposal-not-found"
    | "proposal-not-pending"
    | "stale-base"
    | "unavailable") {
    super(reason);
    this.name = "SynthesisServiceError";
  }
}

type PostgreSqlFailure = { code: string };

function getPostgreSqlFailure(error: unknown): PostgreSqlFailure | null {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) return null;
    if ("code" in current && typeof current.code === "string") {
      return { code: current.code };
    }
    current = "cause" in current ? current.cause : null;
  }
  return null;
}

function sanitizeSynthesisServiceError(error: unknown): Error {
  if (error instanceof SynthesisServiceError) return error;
  if (
    error instanceof DrizzleError ||
    error instanceof DrizzleQueryError ||
    getPostgreSqlFailure(error)
  ) {
    return new SynthesisServiceError("unavailable");
  }
  return error instanceof Error ? error : new SynthesisServiceError("unavailable");
}

async function lockOwnerTree(
  tx: SynthesisTransaction,
  userId: string,
  nodeId: string,
) {
  await tx.execute(sql`select ${user.id} from ${user} where ${user.id} = ${userId} for update`);
  const lockedNodes = await tx
    .select({
      id: nodes.id,
      parentId: nodes.parentId,
      publishedSynthesisVersionId: nodes.publishedSynthesisVersionId,
    })
    .from(nodes)
    .where(eq(nodes.userId, userId))
    .orderBy(asc(nodes.id))
    .for("update");
  const node = lockedNodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new SynthesisServiceError("node-not-found");
  return { lockedNodes, node };
}

async function lockProposal(
  tx: SynthesisTransaction,
  userId: string,
  input: SynthesisDecisionInput,
) {
  const [proposal] = await tx
    .select()
    .from(synthesisVersions)
    .where(
      and(
        eq(synthesisVersions.userId, userId),
        eq(synthesisVersions.nodeId, input.nodeId),
        eq(synthesisVersions.id, input.proposalId),
      ),
    )
    .for("update");
  if (!proposal) throw new SynthesisServiceError("proposal-not-found");
  return proposal;
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

  const refinementProposalId = input.refinementProposalId ?? null;
  if (refinementProposalId !== null) {
    const [refinementTarget] = await tx
      .select()
      .from(synthesisVersions)
      .where(
        and(
          eq(synthesisVersions.userId, input.userId),
          eq(synthesisVersions.nodeId, input.nodeId),
          eq(synthesisVersions.id, refinementProposalId),
        ),
      )
      .for("update");
    if (
      !refinementTarget ||
      refinementTarget.status !== "pending" ||
      refinementTarget.baseVersionId !== input.baseVersionId
    ) {
      throw new SynthesisServiceError("proposal-not-pending");
    }
    const decidedAt = new Date();
    await tx
      .update(synthesisVersions)
      .set({ status: "superseded", decidedAt, updatedAt: decidedAt })
      .where(eq(synthesisVersions.id, refinementTarget.id));
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

export async function approveSynthesisProposalForUser(
  userId: string,
  input: SynthesisDecisionInput,
) {
  try {
    return await db.transaction(async (tx) => {
      const { lockedNodes, node } = await lockOwnerTree(tx, userId, input.nodeId);
      const proposal = await lockProposal(tx, userId, input);
      if (
        proposal.status === "approved" &&
        node.publishedSynthesisVersionId === proposal.id
      ) {
        return toSynthesisVersion(proposal);
      }
      if (proposal.status !== "pending") {
        throw new SynthesisServiceError("proposal-not-pending");
      }
      if (proposal.baseVersionId !== node.publishedSynthesisVersionId) {
        throw new SynthesisServiceError("stale-base");
      }
      if (node.publishedSynthesisVersionId !== null) {
        const [published] = await tx
          .select({ status: synthesisVersions.status })
          .from(synthesisVersions)
          .where(
            and(
              eq(synthesisVersions.userId, userId),
              eq(synthesisVersions.nodeId, input.nodeId),
              eq(synthesisVersions.id, node.publishedSynthesisVersionId),
            ),
          );
        if (!published || published.status !== "approved") {
          throw new SynthesisServiceError("unavailable");
        }
      }

      const decidedAt = new Date();
      const [approved] = await tx
        .update(synthesisVersions)
        .set({ status: "approved", decidedAt, updatedAt: decidedAt })
        .where(eq(synthesisVersions.id, proposal.id))
        .returning();
      if (!approved) throw new SynthesisServiceError("unavailable");
      await tx
        .update(nodes)
        .set({
          publishedSynthesisVersionId: proposal.id,
          synthesisStaleAt: null,
          updatedAt: decidedAt,
        })
        .where(and(eq(nodes.userId, userId), eq(nodes.id, input.nodeId)));

      const nodeById = new Map(lockedNodes.map((candidate) => [candidate.id, candidate]));
      const ancestorIds: string[] = [];
      const visited = new Set<string>([node.id]);
      let parentId = node.parentId;
      while (parentId !== null) {
        if (visited.has(parentId)) throw new SynthesisServiceError("unavailable");
        visited.add(parentId);
        const parent = nodeById.get(parentId);
        if (!parent) throw new SynthesisServiceError("unavailable");
        ancestorIds.push(parent.id);
        parentId = parent.parentId;
      }
      if (ancestorIds.length > 0) {
        await tx
          .update(nodes)
          .set({ synthesisStaleAt: decidedAt, updatedAt: decidedAt })
          .where(and(eq(nodes.userId, userId), inArray(nodes.id, ancestorIds)));
      }
      return toSynthesisVersion(approved);
    });
  } catch (error) {
    throw sanitizeSynthesisServiceError(error);
  }
}

export async function rejectSynthesisProposalForUser(
  userId: string,
  input: SynthesisDecisionInput,
) {
  try {
    return await db.transaction(async (tx) => {
      await lockOwnerTree(tx, userId, input.nodeId);
      const proposal = await lockProposal(tx, userId, input);
      if (proposal.status === "rejected") {
        return toSynthesisVersion(proposal);
      }
      if (proposal.status !== "pending") {
        throw new SynthesisServiceError("proposal-not-pending");
      }
      const decidedAt = new Date();
      const [rejected] = await tx
        .update(synthesisVersions)
        .set({ status: "rejected", decidedAt, updatedAt: decidedAt })
        .where(eq(synthesisVersions.id, proposal.id))
        .returning();
      if (!rejected) throw new SynthesisServiceError("unavailable");
      return toSynthesisVersion(rejected);
    });
  } catch (error) {
    throw sanitizeSynthesisServiceError(error);
  }
}

export async function getSynthesisWorkspaceForUser(
  userId: string,
  nodeId: string,
  options: { generatingMessageIds?: string[] } = {},
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

    const recentDecidedVersions = await tx
      .select({
        id: synthesisVersions.id,
        baseVersionId: synthesisVersions.baseVersionId,
        generatingMessageId: synthesisVersions.generatingMessageId,
        status: synthesisVersions.status,
        content: synthesisVersions.content,
        decidedAt: synthesisVersions.decidedAt,
      })
      .from(synthesisVersions)
      .where(
        and(
          eq(synthesisVersions.userId, userId),
          eq(synthesisVersions.nodeId, nodeId),
          inArray(synthesisVersions.status, ["approved", "rejected", "superseded"]),
        ),
      )
      .orderBy(desc(synthesisVersions.decidedAt), desc(synthesisVersions.id))
      .limit(5);
    const requestedMessageIds = [...new Set(options.generatingMessageIds ?? [])].slice(0, 50);
    const pageDecidedVersions = requestedMessageIds.length > 0
      ? await tx
          .select({
            id: synthesisVersions.id,
            baseVersionId: synthesisVersions.baseVersionId,
            generatingMessageId: synthesisVersions.generatingMessageId,
            status: synthesisVersions.status,
            content: synthesisVersions.content,
            decidedAt: synthesisVersions.decidedAt,
          })
          .from(synthesisVersions)
          .where(and(
            eq(synthesisVersions.userId, userId),
            eq(synthesisVersions.nodeId, nodeId),
            inArray(synthesisVersions.status, ["approved", "rejected", "superseded"]),
            inArray(synthesisVersions.generatingMessageId, requestedMessageIds),
          ))
          .orderBy(desc(synthesisVersions.decidedAt), desc(synthesisVersions.id))
      : [];
    const decidedVersions = [...new Map(
      [...recentDecidedVersions, ...pageDecidedVersions]
        .map((version) => [version.id, version]),
    ).values()];
    const decidedBaseIds = decidedVersions.flatMap((version) =>
      version.baseVersionId ? [version.baseVersionId] : []
    );
    const decidedBases = decidedBaseIds.length > 0
      ? await tx
          .select({ id: synthesisVersions.id, content: synthesisVersions.content })
          .from(synthesisVersions)
          .where(and(
            eq(synthesisVersions.userId, userId),
            eq(synthesisVersions.nodeId, nodeId),
            inArray(synthesisVersions.id, decidedBaseIds),
          ))
      : [];
    const decidedBaseContent = new Map(
      decidedBases.map((version) => [version.id, version.content]),
    );
    return {
      published: published ? toSynthesisVersion(published) : null,
      pending: pendingVersions[0] ? toSynthesisVersion(pendingVersions[0]) : null,
      history: decidedVersions.map((version) => {
        if (version.status === "pending" || version.decidedAt === null) {
          throw new SynthesisServiceError("unavailable");
        }
        const baseContent = version.baseVersionId
          ? decidedBaseContent.get(version.baseVersionId)
          : null;
        if (version.baseVersionId && baseContent === undefined) {
          throw new SynthesisServiceError("unavailable");
        }
        return {
          id: version.id,
          generatingMessageId: version.generatingMessageId,
          status: version.status,
          content: version.content,
          baseContent: baseContent ?? null,
          decidedAt: version.decidedAt.toISOString(),
        };
      }),
    };
  }, {
    accessMode: "read only",
    isolationLevel: "repeatable read",
  });
}
