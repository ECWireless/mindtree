import "server-only";

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { DrizzleError, DrizzleQueryError } from "drizzle-orm/errors";

import { db } from "@/db/client";
import {
  branchOutlineInputs,
  branchOutlineVersions,
  nodes,
  synthesisVersions,
  user,
} from "@/db/schema";
import {
  OPENAI_CHAT_TIMEOUT_MS,
  OPENAI_SYNTHESIS_MODEL,
} from "@/lib/ai/openai-profiles";
import {
  branchOutlineDraftSchema,
  claimBranchOutlineGenerationInputSchema,
  completeBranchOutlineGenerationInputSchema,
  failBranchOutlineGenerationInputSchema,
  generateBranchOutlineInputSchema,
  recordBranchOutlineProviderResponseInputSchema,
  type BranchOutlineInputSnapshot,
  type BranchOutlineVersion,
  type BranchOutlineWorkspace,
  type ClaimBranchOutlineGenerationInput,
  type CompleteBranchOutlineGenerationInput,
  type FailBranchOutlineGenerationInput,
  type GenerateBranchOutlineInput,
  type RecordBranchOutlineProviderResponseInput,
} from "@/lib/branch-outlines/contracts";
import {
  fingerprintBranchOutlineGeneration,
  fingerprintBranchOutlineSourceState,
} from "@/lib/server/branch-outline-fingerprint";
import {
  collectAncestorPathIds,
  markArtifactsStale,
  StalenessTreeError,
} from "@/lib/server/staleness";

type BranchOutlineTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type LockedNode = typeof nodes.$inferSelect;

export const BRANCH_OUTLINE_GENERATION_LEASE_MS = OPENAI_CHAT_TIMEOUT_MS + 30_000;

export function isBranchOutlineGenerationExpired(
  generation: Pick<BranchOutlineVersion, "updatedAt">,
  now = Date.now(),
) {
  return new Date(generation.updatedAt).getTime() <=
    now - BRANCH_OUTLINE_GENERATION_LEASE_MS;
}

export class BranchOutlineServiceError extends Error {
  constructor(public readonly reason:
    | "generation-in-progress"
    | "generation-not-found"
    | "generation-not-pending"
    | "inputs-changed"
    | "invalid-generation"
    | "invalid-outline"
    | "node-not-found"
    | "request-conflict"
    | "unavailable") {
    super(reason);
    this.name = "BranchOutlineServiceError";
  }
}

type PostgreSqlFailure = { code: string; constraint?: string };

function getPostgreSqlFailure(error: unknown): PostgreSqlFailure | null {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) return null;
    if ("code" in current && typeof current.code === "string") {
      return {
        code: current.code,
        constraint:
          "constraint" in current && typeof current.constraint === "string"
            ? current.constraint
            : undefined,
      };
    }
    current = "cause" in current ? current.cause : null;
  }
  return null;
}

function sanitizeBranchOutlineServiceError(error: unknown): Error {
  if (error instanceof BranchOutlineServiceError) return error;
  const postgresFailure = getPostgreSqlFailure(error);
  if (
    postgresFailure?.code === "23505" &&
    postgresFailure.constraint === "branch_outline_versions_one_pending_per_node"
  ) {
    return new BranchOutlineServiceError("generation-in-progress");
  }
  if (
    error instanceof DrizzleError ||
    error instanceof DrizzleQueryError ||
    postgresFailure !== null ||
    error instanceof StalenessTreeError
  ) {
    return new BranchOutlineServiceError("unavailable");
  }
  return error instanceof Error
    ? error
    : new BranchOutlineServiceError("unavailable");
}

function toBranchOutlineVersion(
  row: typeof branchOutlineVersions.$inferSelect,
): BranchOutlineVersion {
  return {
    id: row.id,
    nodeId: row.nodeId,
    clientRequestId: row.clientRequestId,
    baseSynthesisVersionId: row.baseSynthesisVersionId,
    status: row.status,
    content: row.content,
    model: row.model,
    reasoningMode: row.reasoningMode,
    reasoningEffort: row.reasoningEffort,
    inputFingerprint: row.inputFingerprint,
    providerResponseId: row.providerResponseId,
    failureCode: row.failureCode,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

function toInputSnapshot(
  row: typeof branchOutlineInputs.$inferSelect,
): BranchOutlineInputSnapshot {
  return {
    sourceNodeId: row.sourceNodeId,
    sourceSynthesisVersionId: row.sourceSynthesisVersionId,
    sourceBranchOutlineVersionId: row.sourceBranchOutlineVersionId,
    summaryState: row.summaryState,
    outlineState: row.outlineState,
    sourceStateFingerprint: row.sourceStateFingerprint,
    position: row.position,
  };
}

async function lockOwnerTree(
  tx: BranchOutlineTransaction,
  userId: string,
  nodeId: string,
) {
  await tx.execute(
    sql`select ${user.id} from ${user} where ${user.id} = ${userId} for update`,
  );
  const lockedNodes = await tx
    .select()
    .from(nodes)
    .where(eq(nodes.userId, userId))
    .orderBy(asc(nodes.id))
    .for("update");
  const node = lockedNodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new BranchOutlineServiceError("node-not-found");
  return { lockedNodes, node };
}

async function requireApprovedSynthesisPointers(
  tx: BranchOutlineTransaction,
  userId: string,
  lockedNodes: readonly LockedNode[],
) {
  const pointerIds = [...new Set(
    lockedNodes.flatMap((node) =>
      node.publishedSynthesisVersionId ? [node.publishedSynthesisVersionId] : [],
    ),
  )];
  if (pointerIds.length === 0) return;
  const versions = await tx
    .select({
      id: synthesisVersions.id,
      nodeId: synthesisVersions.nodeId,
      status: synthesisVersions.status,
    })
    .from(synthesisVersions)
    .where(and(
      eq(synthesisVersions.userId, userId),
      inArray(synthesisVersions.id, pointerIds),
    ));
  const byId = new Map(versions.map((version) => [version.id, version]));
  for (const node of lockedNodes) {
    if (node.publishedSynthesisVersionId === null) continue;
    const version = byId.get(node.publishedSynthesisVersionId);
    if (!version || version.nodeId !== node.id || version.status !== "approved") {
      throw new BranchOutlineServiceError("unavailable");
    }
  }
}

async function requireCompletedOutlinePointers(
  tx: BranchOutlineTransaction,
  userId: string,
  lockedNodes: readonly LockedNode[],
) {
  const pointerIds = [...new Set(
    lockedNodes.flatMap((node) =>
      node.currentBranchOutlineVersionId ? [node.currentBranchOutlineVersionId] : [],
    ),
  )];
  if (pointerIds.length === 0) return;
  const versions = await tx
    .select({
      id: branchOutlineVersions.id,
      nodeId: branchOutlineVersions.nodeId,
      status: branchOutlineVersions.status,
    })
    .from(branchOutlineVersions)
    .where(and(
      eq(branchOutlineVersions.userId, userId),
      inArray(branchOutlineVersions.id, pointerIds),
    ));
  const byId = new Map(versions.map((version) => [version.id, version]));
  for (const node of lockedNodes) {
    if (node.currentBranchOutlineVersionId === null) continue;
    const version = byId.get(node.currentBranchOutlineVersionId);
    if (!version || version.nodeId !== node.id || version.status !== "completed") {
      throw new BranchOutlineServiceError("unavailable");
    }
  }
}

async function getCurrentInputSnapshots(
  tx: BranchOutlineTransaction,
  userId: string,
  lockedNodes: readonly LockedNode[],
  targetId: string,
) {
  const target = lockedNodes.find((node) => node.id === targetId);
  if (!target) throw new BranchOutlineServiceError("node-not-found");
  const sources = lockedNodes
    .filter((node) => node.parentId === targetId)
    .sort((left, right) =>
      left.position - right.position || left.id.localeCompare(right.id)
    );
  await Promise.all([
    requireApprovedSynthesisPointers(tx, userId, [target, ...sources]),
    requireCompletedOutlinePointers(tx, userId, sources),
  ]);
  return sources.map((source, position): BranchOutlineInputSnapshot => {
      const summaryState = source.publishedSynthesisVersionId === null
        ? "none" as const
        : "published" as const;
      const outlineState = source.currentBranchOutlineVersionId === null
        ? "none" as const
        : source.branchOutlineStaleAt === null
          ? "current" as const
          : "stale" as const;
      const state = {
        sourceNodeId: source.id,
        sourceSynthesisVersionId: source.publishedSynthesisVersionId,
        sourceBranchOutlineVersionId: source.currentBranchOutlineVersionId,
        summaryState,
        outlineState,
        position,
        title: source.title,
        archivedAt: source.archivedAt?.toISOString() ?? null,
      };
      return {
        sourceNodeId: state.sourceNodeId,
        sourceSynthesisVersionId: state.sourceSynthesisVersionId,
        sourceBranchOutlineVersionId: state.sourceBranchOutlineVersionId,
        summaryState: state.summaryState,
        outlineState: state.outlineState,
        position: state.position,
        sourceStateFingerprint: fingerprintBranchOutlineSourceState(state),
      };
    });
}

function inputsMatch(
  left: readonly BranchOutlineInputSnapshot[],
  right: readonly BranchOutlineInputSnapshot[],
) {
  const canonicalize = (inputs: readonly BranchOutlineInputSnapshot[]) =>
    inputs.map((input) => [
      input.sourceNodeId,
      input.sourceSynthesisVersionId,
      input.sourceBranchOutlineVersionId,
      input.summaryState,
      input.outlineState,
      input.sourceStateFingerprint,
      input.position,
    ]);
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

async function loadGenerationInputs(
  tx: BranchOutlineTransaction,
  userId: string,
  nodeId: string,
  outlineVersionId: string,
) {
  const rows = await tx
    .select()
    .from(branchOutlineInputs)
    .where(and(
      eq(branchOutlineInputs.userId, userId),
      eq(branchOutlineInputs.nodeId, nodeId),
      eq(branchOutlineInputs.outlineVersionId, outlineVersionId),
    ))
    .orderBy(asc(branchOutlineInputs.position));
  return rows.map(toInputSnapshot);
}

async function lockGeneration(
  tx: BranchOutlineTransaction,
  userId: string,
  nodeId: string,
  generationId: string,
) {
  const [generation] = await tx
    .select()
    .from(branchOutlineVersions)
    .where(and(
      eq(branchOutlineVersions.userId, userId),
      eq(branchOutlineVersions.nodeId, nodeId),
      eq(branchOutlineVersions.id, generationId),
    ))
    .for("update");
  if (!generation) {
    throw new BranchOutlineServiceError("generation-not-found");
  }
  return generation;
}

export async function claimBranchOutlineGenerationForUser(
  userId: string,
  input: ClaimBranchOutlineGenerationInput,
) {
  const parsed = claimBranchOutlineGenerationInputSchema.safeParse(input);
  if (!parsed.success) throw new BranchOutlineServiceError("invalid-generation");
  try {
    return await db.transaction(async (tx) => {
      const { lockedNodes, node } = await lockOwnerTree(tx, userId, parsed.data.nodeId);
      const [existing] = await tx
        .select()
        .from(branchOutlineVersions)
        .where(and(
          eq(branchOutlineVersions.userId, userId),
          eq(branchOutlineVersions.nodeId, parsed.data.nodeId),
          eq(branchOutlineVersions.clientRequestId, parsed.data.clientRequestId),
        ))
        .for("update");
      if (existing) {
        const existingInputs = await loadGenerationInputs(
          tx,
          userId,
          parsed.data.nodeId,
          existing.id,
        );
        if (
          existing.baseSynthesisVersionId !== parsed.data.baseSynthesisVersionId ||
          existing.inputFingerprint !== parsed.data.inputFingerprint ||
          existing.model !== OPENAI_SYNTHESIS_MODEL ||
          !inputsMatch(existingInputs, parsed.data.inputs)
        ) {
          throw new BranchOutlineServiceError("request-conflict");
        }
        return {
          generation: toBranchOutlineVersion(existing),
          inputs: existingInputs,
          installed: node.currentBranchOutlineVersionId === existing.id,
          replayed: true,
        };
      }

      const [active] = await tx
        .select()
        .from(branchOutlineVersions)
        .where(and(
          eq(branchOutlineVersions.userId, userId),
          eq(branchOutlineVersions.nodeId, parsed.data.nodeId),
          eq(branchOutlineVersions.status, "pending"),
        ))
        .limit(1)
        .for("update");
      if (active) {
        if (
          active.updatedAt.getTime() >
          Date.now() - BRANCH_OUTLINE_GENERATION_LEASE_MS
        ) {
          throw new BranchOutlineServiceError("generation-in-progress");
        }
        const failedAt = new Date();
        await tx
          .update(branchOutlineVersions)
          .set({
            status: "failed",
            failureCode: "stream-disconnected",
            updatedAt: failedAt,
          })
          .where(eq(branchOutlineVersions.id, active.id));
      }
      if (node.publishedSynthesisVersionId !== parsed.data.baseSynthesisVersionId) {
        throw new BranchOutlineServiceError("inputs-changed");
      }
      const currentInputs = await getCurrentInputSnapshots(
        tx,
        userId,
        lockedNodes,
        node.id,
      );
      const currentFingerprint = fingerprintBranchOutlineGeneration({
        nodeId: node.id,
        nodeTitle: node.title,
        nodeArchivedAt: node.archivedAt?.toISOString() ?? null,
        baseSynthesisVersionId: node.publishedSynthesisVersionId,
        inputs: currentInputs,
      });
      if (
        currentFingerprint !== parsed.data.inputFingerprint ||
        !inputsMatch(currentInputs, parsed.data.inputs)
      ) {
        throw new BranchOutlineServiceError("inputs-changed");
      }

      const [created] = await tx
        .insert(branchOutlineVersions)
        .values({
          userId,
          nodeId: node.id,
          clientRequestId: parsed.data.clientRequestId,
          baseSynthesisVersionId: parsed.data.baseSynthesisVersionId,
          status: "pending",
          model: OPENAI_SYNTHESIS_MODEL,
          reasoningMode: "pro",
          reasoningEffort: "high",
          inputFingerprint: parsed.data.inputFingerprint,
        })
        .returning();
      if (!created) throw new BranchOutlineServiceError("unavailable");
      if (currentInputs.length > 0) {
        await tx.insert(branchOutlineInputs).values(currentInputs.map((source) => ({
          outlineVersionId: created.id,
          userId,
          nodeId: node.id,
          ...source,
        })));
      }
      return {
        generation: toBranchOutlineVersion(created),
        inputs: currentInputs,
        installed: false,
        replayed: false,
      };
    });
  } catch (error) {
    throw sanitizeBranchOutlineServiceError(error);
  }
}

export async function completeBranchOutlineGenerationForUser(
  userId: string,
  input: CompleteBranchOutlineGenerationInput,
) {
  const parsed = completeBranchOutlineGenerationInputSchema.safeParse(input);
  const draft = parsed.success
    ? branchOutlineDraftSchema.safeParse(parsed.data.draft)
    : null;
  if (!parsed.success || !draft?.success) {
    throw new BranchOutlineServiceError("invalid-outline");
  }
  try {
    return await db.transaction(async (tx) => {
      const { lockedNodes, node } = await lockOwnerTree(tx, userId, parsed.data.nodeId);
      const generation = await lockGeneration(
        tx,
        userId,
        node.id,
        parsed.data.generationId,
      );
      if (generation.status === "completed") {
        return {
          generation: toBranchOutlineVersion(generation),
          installed: node.currentBranchOutlineVersionId === generation.id,
          replayed: true,
        };
      }
      if (generation.status === "failed") {
        return {
          generation: toBranchOutlineVersion(generation),
          installed: false,
          replayed: true,
        };
      }
      if (generation.status !== "pending") {
        throw new BranchOutlineServiceError("generation-not-pending");
      }

      const recordedInputs = await loadGenerationInputs(
        tx,
        userId,
        node.id,
        generation.id,
      );
      const currentInputs = await getCurrentInputSnapshots(
        tx,
        userId,
        lockedNodes,
        node.id,
      );
      const currentFingerprint = fingerprintBranchOutlineGeneration({
        nodeId: node.id,
        nodeTitle: node.title,
        nodeArchivedAt: node.archivedAt?.toISOString() ?? null,
        baseSynthesisVersionId: node.publishedSynthesisVersionId,
        inputs: currentInputs,
      });
      if (
        generation.baseSynthesisVersionId !== node.publishedSynthesisVersionId ||
        generation.inputFingerprint !== currentFingerprint ||
        !inputsMatch(recordedInputs, currentInputs)
      ) {
        const failedAt = new Date();
        const [failed] = await tx
          .update(branchOutlineVersions)
          .set({
            status: "failed",
            failureCode: "inputs-changed",
            updatedAt: failedAt,
          })
          .where(eq(branchOutlineVersions.id, generation.id))
          .returning();
        if (!failed) throw new BranchOutlineServiceError("unavailable");
        return {
          generation: toBranchOutlineVersion(failed),
          installed: false,
          replayed: false,
        };
      }

      const completedAt = new Date();
      const [completed] = await tx
        .update(branchOutlineVersions)
        .set({
          status: "completed",
          content: draft.data.content,
          completedAt,
          updatedAt: completedAt,
        })
        .where(eq(branchOutlineVersions.id, generation.id))
        .returning();
      if (!completed) throw new BranchOutlineServiceError("unavailable");
      await tx
        .update(nodes)
        .set({
          currentBranchOutlineVersionId: completed.id,
          branchOutlineStaleAt: null,
          branchOutlineStaleReason: null,
          updatedAt: completedAt,
        })
        .where(and(eq(nodes.userId, userId), eq(nodes.id, node.id)));
      const ancestorIds = collectAncestorPathIds(lockedNodes, node.id);
      await markArtifactsStale(tx, {
        userId,
        summaryNodeIds: ancestorIds,
        outlineNodeIds: ancestorIds,
        outlineReason: "branch-content-changed",
        at: completedAt,
      });
      return {
        generation: toBranchOutlineVersion(completed),
        installed: true,
        replayed: false,
      };
    });
  } catch (error) {
    throw sanitizeBranchOutlineServiceError(error);
  }
}

export async function recordBranchOutlineProviderResponseForUser(
  userId: string,
  input: RecordBranchOutlineProviderResponseInput,
) {
  const parsed = recordBranchOutlineProviderResponseInputSchema.safeParse(input);
  if (!parsed.success) throw new BranchOutlineServiceError("invalid-generation");
  try {
    return await db.transaction(async (tx) => {
      const { node } = await lockOwnerTree(tx, userId, parsed.data.nodeId);
      const generation = await lockGeneration(
        tx,
        userId,
        node.id,
        parsed.data.generationId,
      );
      if (generation.status !== "pending") {
        throw new BranchOutlineServiceError("generation-not-pending");
      }
      if (generation.providerResponseId === parsed.data.providerResponseId) {
        return { generation: toBranchOutlineVersion(generation), replayed: true };
      }
      if (generation.providerResponseId !== null) {
        throw new BranchOutlineServiceError("invalid-generation");
      }
      const [updated] = await tx
        .update(branchOutlineVersions)
        .set({
          providerResponseId: parsed.data.providerResponseId,
          updatedAt: new Date(),
        })
        .where(eq(branchOutlineVersions.id, generation.id))
        .returning();
      if (!updated) throw new BranchOutlineServiceError("unavailable");
      return { generation: toBranchOutlineVersion(updated), replayed: false };
    });
  } catch (error) {
    throw sanitizeBranchOutlineServiceError(error);
  }
}

export async function failBranchOutlineGenerationForUser(
  userId: string,
  input: FailBranchOutlineGenerationInput,
) {
  const parsed = failBranchOutlineGenerationInputSchema.safeParse(input);
  if (!parsed.success) throw new BranchOutlineServiceError("invalid-generation");
  try {
    return await db.transaction(async (tx) => {
      const { node } = await lockOwnerTree(tx, userId, parsed.data.nodeId);
      const generation = await lockGeneration(
        tx,
        userId,
        node.id,
        parsed.data.generationId,
      );
      if (generation.status !== "pending") {
        return {
          generation: toBranchOutlineVersion(generation),
          replayed: true,
        };
      }
      const failedAt = new Date();
      const [failed] = await tx
        .update(branchOutlineVersions)
        .set({
          status: "failed",
          failureCode: parsed.data.failureCode,
          updatedAt: failedAt,
        })
        .where(eq(branchOutlineVersions.id, generation.id))
        .returning();
      if (!failed) throw new BranchOutlineServiceError("unavailable");
      return {
        generation: toBranchOutlineVersion(failed),
        replayed: false,
      };
    });
  } catch (error) {
    throw sanitizeBranchOutlineServiceError(error);
  }
}

export async function getBranchOutlineGenerationForRequestForUser(
  userId: string,
  input: GenerateBranchOutlineInput,
) {
  const parsed = generateBranchOutlineInputSchema.safeParse(input);
  if (!parsed.success) throw new BranchOutlineServiceError("invalid-generation");
  return db.transaction(async (tx) => {
    const [node] = await tx
      .select({ currentBranchOutlineVersionId: nodes.currentBranchOutlineVersionId })
      .from(nodes)
      .where(and(eq(nodes.userId, userId), eq(nodes.id, parsed.data.nodeId)));
    if (!node) throw new BranchOutlineServiceError("node-not-found");
    const [generation] = await tx
      .select()
      .from(branchOutlineVersions)
      .where(and(
        eq(branchOutlineVersions.userId, userId),
        eq(branchOutlineVersions.nodeId, parsed.data.nodeId),
        eq(branchOutlineVersions.clientRequestId, parsed.data.clientRequestId),
      ));
    return generation
      ? {
          generation: toBranchOutlineVersion(generation),
          installed: node.currentBranchOutlineVersionId === generation.id,
        }
      : null;
  }, {
    accessMode: "read only",
    isolationLevel: "repeatable read",
  });
}

export async function recoverAbandonedBranchOutlineGenerationForUser(
  userId: string,
  nodeId: string,
) {
  try {
    return await db.transaction(async (tx) => {
      const { node } = await lockOwnerTree(tx, userId, nodeId);
      const [pending] = await tx
        .select()
        .from(branchOutlineVersions)
        .where(and(
          eq(branchOutlineVersions.userId, userId),
          eq(branchOutlineVersions.nodeId, node.id),
          eq(branchOutlineVersions.status, "pending"),
        ))
        .limit(1)
        .for("update");
      if (
        !pending ||
        pending.updatedAt.getTime() > Date.now() - BRANCH_OUTLINE_GENERATION_LEASE_MS
      ) {
        return { recovered: false };
      }
      const failedAt = new Date();
      const [failed] = await tx
        .update(branchOutlineVersions)
        .set({
          status: "failed",
          failureCode: "stream-disconnected",
          updatedAt: failedAt,
        })
        .where(eq(branchOutlineVersions.id, pending.id))
        .returning();
      if (!failed) throw new BranchOutlineServiceError("unavailable");
      return { recovered: true, generation: toBranchOutlineVersion(failed) };
    });
  } catch (error) {
    throw sanitizeBranchOutlineServiceError(error);
  }
}

export async function getBranchOutlineWorkspaceForUser(
  userId: string,
  nodeId: string,
): Promise<BranchOutlineWorkspace> {
  return db.transaction(async (tx) => {
    const [node] = await tx
      .select({
        currentBranchOutlineVersionId: nodes.currentBranchOutlineVersionId,
        branchOutlineStaleAt: nodes.branchOutlineStaleAt,
        branchOutlineStaleReason: nodes.branchOutlineStaleReason,
      })
      .from(nodes)
      .where(and(eq(nodes.userId, userId), eq(nodes.id, nodeId)));
    if (!node) throw new BranchOutlineServiceError("node-not-found");

    const [current] = node.currentBranchOutlineVersionId
      ? await tx
          .select()
          .from(branchOutlineVersions)
          .where(and(
            eq(branchOutlineVersions.userId, userId),
            eq(branchOutlineVersions.nodeId, nodeId),
            eq(branchOutlineVersions.id, node.currentBranchOutlineVersionId),
          ))
          .limit(1)
      : [];
    if (
      node.currentBranchOutlineVersionId &&
      (current?.status !== "completed" || current.completedAt === null)
    ) {
      throw new BranchOutlineServiceError("unavailable");
    }

    const pendingRows = await tx
      .select()
      .from(branchOutlineVersions)
      .where(and(
        eq(branchOutlineVersions.userId, userId),
        eq(branchOutlineVersions.nodeId, nodeId),
        eq(branchOutlineVersions.status, "pending"),
      ))
      .limit(2);
    if (pendingRows.length > 1) {
      throw new BranchOutlineServiceError("unavailable");
    }
    const [latestFailure] = await tx
      .select()
      .from(branchOutlineVersions)
      .where(and(
        eq(branchOutlineVersions.userId, userId),
        eq(branchOutlineVersions.nodeId, nodeId),
        eq(branchOutlineVersions.status, "failed"),
      ))
      .orderBy(desc(branchOutlineVersions.updatedAt), desc(branchOutlineVersions.id))
      .limit(1);

    return {
      current: current ? toBranchOutlineVersion(current) : null,
      pending: pendingRows[0] ? toBranchOutlineVersion(pendingRows[0]) : null,
      latestFailure:
        latestFailure && (!current || latestFailure.updatedAt > current.completedAt!)
          ? toBranchOutlineVersion(latestFailure)
          : null,
      staleAt: node.branchOutlineStaleAt?.toISOString() ?? null,
      staleReason: node.branchOutlineStaleReason,
    };
  }, {
    accessMode: "read only",
    isolationLevel: "repeatable read",
  });
}
