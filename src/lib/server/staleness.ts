import "server-only";

import { and, eq, inArray, isNotNull } from "drizzle-orm";

import { db } from "@/db/client";
import { nodes } from "@/db/schema";
import type { BranchOutlineStaleReason } from "@/lib/branch-outlines/contracts";

type StalenessTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type StalenessTreeNode = {
  id: string;
  parentId: string | null;
};

export class StalenessTreeError extends Error {
  constructor() {
    super("invalid owner tree");
    this.name = "StalenessTreeError";
  }
}

export function collectAncestorPathIds(
  lockedNodes: readonly StalenessTreeNode[],
  startId: string | null,
  options: { includeStart?: boolean } = {},
) {
  if (startId === null) return [];
  const nodeById = new Map(lockedNodes.map((node) => [node.id, node]));
  const result: string[] = [];
  const visited = new Set<string>();
  let currentId: string | null = options.includeStart ? startId : nodeById.get(startId)?.parentId ?? null;

  if (!nodeById.has(startId)) throw new StalenessTreeError();
  while (currentId !== null) {
    if (visited.has(currentId)) throw new StalenessTreeError();
    visited.add(currentId);
    const current = nodeById.get(currentId);
    if (!current) throw new StalenessTreeError();
    result.push(current.id);
    currentId = current.parentId;
  }
  return result;
}

export async function markArtifactsStale(
  tx: StalenessTransaction,
  input: {
    userId: string;
    summaryNodeIds?: readonly string[];
    outlineNodeIds?: readonly string[];
    outlineReason: BranchOutlineStaleReason;
    at: Date;
  },
) {
  const summaryNodeIds = [...new Set(input.summaryNodeIds ?? [])];
  const outlineNodeIds = [...new Set(input.outlineNodeIds ?? [])];

  if (summaryNodeIds.length > 0) {
    await tx
      .update(nodes)
      .set({ synthesisStaleAt: input.at, updatedAt: input.at })
      .where(and(
        eq(nodes.userId, input.userId),
        inArray(nodes.id, summaryNodeIds),
        isNotNull(nodes.publishedSynthesisVersionId),
      ));
  }
  if (outlineNodeIds.length > 0) {
    await tx
      .update(nodes)
      .set({
        branchOutlineStaleAt: input.at,
        branchOutlineStaleReason: input.outlineReason,
        updatedAt: input.at,
      })
      .where(and(
        eq(nodes.userId, input.userId),
        inArray(nodes.id, outlineNodeIds),
        isNotNull(nodes.currentBranchOutlineVersionId),
      ));
  }
}
