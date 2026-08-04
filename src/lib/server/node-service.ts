import "server-only";

import { and, asc, eq, inArray, isNotNull, isNull, max, sql } from "drizzle-orm";
import { DrizzleError, DrizzleQueryError } from "drizzle-orm/errors";

import { db } from "@/db/client";
import { nodes, user } from "@/db/schema";
import type {
  CreateNodeInput,
  MoveNodeInput,
  NodeLifecycleInput,
  RenameNodeInput,
} from "@/lib/nodes/contracts";
import {
  assembleNodeTree,
  type FlatNode,
  NodeTreeDataError,
} from "@/lib/nodes/tree";

type NodeTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

type NodeMutationReason =
  | "archived-parent"
  | "cycle"
  | "invalid-position"
  | "node-not-found"
  | "parent-not-found"
  | "position-conflict"
  | "unavailable";

export class NodeMutationError extends Error {
  constructor(public readonly reason: NodeMutationReason) {
    super(reason);
    this.name = "NodeMutationError";
  }
}

function toFlatNode(row: typeof nodes.$inferSelect): FlatNode {
  return {
    id: row.id,
    parentId: row.parentId,
    position: row.position,
    title: row.title,
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}

async function lockOwnerNodes(tx: NodeTransaction, userId: string) {
  await tx.execute(sql`select ${user.id} from ${user} where ${user.id} = ${userId} for update`);
  const rows = await tx
    .select()
    .from(nodes)
    .where(eq(nodes.userId, userId))
    .orderBy(asc(nodes.id))
    .for("update");

  return rows.map(toFlatNode);
}

function requireNode(lockedNodes: readonly FlatNode[], nodeId: string) {
  const node = lockedNodes.find((candidate) => candidate.id === nodeId);
  if (!node) {
    throw new NodeMutationError("node-not-found");
  }
  return node;
}

function requireActiveDestinationPath(
  lockedNodes: readonly FlatNode[],
  destinationParent: FlatNode,
) {
  const nodeById = new Map(lockedNodes.map((node) => [node.id, node]));
  const visited = new Set<string>();
  let current: FlatNode | undefined = destinationParent;

  while (current) {
    if (visited.has(current.id)) {
      throw new NodeMutationError("cycle");
    }
    visited.add(current.id);
    if (current.archivedAt !== null) {
      throw new NodeMutationError("archived-parent");
    }
    if (current.parentId === null) {
      return;
    }
    current = nodeById.get(current.parentId);
    if (!current) {
      throw new NodeMutationError("unavailable");
    }
  }
}

function getSubtreeIds(lockedNodes: readonly FlatNode[], rootId: string) {
  const childrenByParent = new Map<string, string[]>();
  for (const node of lockedNodes) {
    if (node.parentId !== null) {
      const childIds = childrenByParent.get(node.parentId) ?? [];
      childIds.push(node.id);
      childrenByParent.set(node.parentId, childIds);
    }
  }

  const result: string[] = [];
  const visited = new Set<string>();
  const work = [rootId];
  while (work.length > 0) {
    const nodeId = work.pop();
    if (!nodeId) {
      break;
    }
    if (visited.has(nodeId)) {
      throw new NodeMutationError("cycle");
    }
    visited.add(nodeId);
    result.push(nodeId);
    work.push(...(childrenByParent.get(nodeId) ?? []));
  }
  return result;
}

async function rewriteSiblingGroup(
  tx: NodeTransaction,
  userId: string,
  siblings: readonly FlatNode[],
  parentId: string | null,
) {
  for (let position = 0; position < siblings.length; position += 1) {
    const sibling = siblings[position];
    if (sibling.parentId !== parentId || sibling.position !== position) {
      await tx
        .update(nodes)
        .set({ parentId, position, updatedAt: new Date() })
        .where(and(eq(nodes.userId, userId), eq(nodes.id, sibling.id)));
    }
  }
}

type PostgreSqlFailure = {
  code: string;
  constraint?: string;
};

function getPostgreSqlFailure(error: unknown): PostgreSqlFailure | null {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) {
      return null;
    }
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

function sanitizeNodeServiceError(error: unknown): Error {
  if (error instanceof NodeMutationError) {
    return error;
  }

  const postgresFailure = getPostgreSqlFailure(error);
  if (
    postgresFailure?.code === "23505" &&
    postgresFailure.constraint === "nodes_sibling_position_unique"
  ) {
    return new NodeMutationError("position-conflict");
  }
  if (
    error instanceof DrizzleError ||
    error instanceof DrizzleQueryError ||
    postgresFailure !== null ||
    error instanceof NodeTreeDataError
  ) {
    return new NodeMutationError("unavailable");
  }
  return error instanceof Error ? error : new NodeMutationError("unavailable");
}

export async function getNodeTreeForUser(userId: string) {
  try {
    const rows = await db
      .select()
      .from(nodes)
      .where(eq(nodes.userId, userId))
      .orderBy(asc(nodes.position), asc(nodes.id));
    const flatNodes = rows.map(toFlatNode);

    return {
      nodes: flatNodes,
      ...assembleNodeTree(flatNodes),
    };
  } catch (error) {
    throw sanitizeNodeServiceError(error);
  }
}

export async function createNodeForUser(userId: string, input: CreateNodeInput) {
  try {
    return await db.transaction(async (tx) => {
      const lockedNodes = await lockOwnerNodes(tx, userId);
      const parentId = input.parentId ?? null;
      if (parentId !== null) {
        const parent = lockedNodes.find((node) => node.id === parentId);
        if (!parent) {
          throw new NodeMutationError("parent-not-found");
        }
        requireActiveDestinationPath(lockedNodes, parent);
      }

      const [positionResult] = await tx
        .select({ value: max(nodes.position) })
        .from(nodes)
        .where(
          parentId === null
            ? sql`${nodes.userId} = ${userId} and ${nodes.parentId} is null`
            : and(eq(nodes.userId, userId), eq(nodes.parentId, parentId)),
        );
      const position = (positionResult?.value ?? -1) + 1;
      const [created] = await tx
        .insert(nodes)
        .values({ userId, parentId, position, title: input.title })
        .returning();

      return toFlatNode(created);
    });
  } catch (error) {
    throw sanitizeNodeServiceError(error);
  }
}

export async function renameNodeForUser(userId: string, input: RenameNodeInput) {
  try {
    return await db.transaction(async (tx) => {
      const lockedNodes = await lockOwnerNodes(tx, userId);
      requireNode(lockedNodes, input.id);
      const [updated] = await tx
        .update(nodes)
        .set({ title: input.title, updatedAt: new Date() })
        .where(and(eq(nodes.userId, userId), eq(nodes.id, input.id)))
        .returning();

      if (!updated) {
        throw new NodeMutationError("node-not-found");
      }
      return toFlatNode(updated);
    });
  } catch (error) {
    throw sanitizeNodeServiceError(error);
  }
}

export async function moveNodeForUser(userId: string, input: MoveNodeInput) {
  try {
    return await db.transaction(async (tx) => {
      const lockedNodes = await lockOwnerNodes(tx, userId);
      const source = requireNode(lockedNodes, input.id);
      const destinationParent =
        input.parentId === null
          ? null
          : lockedNodes.find((node) => node.id === input.parentId);
      if (input.parentId !== null && !destinationParent) {
        throw new NodeMutationError("parent-not-found");
      }
      if (source.archivedAt === null && destinationParent) {
        requireActiveDestinationPath(lockedNodes, destinationParent);
      }
      if (
        input.parentId !== null &&
        new Set(getSubtreeIds(lockedNodes, source.id)).has(input.parentId)
      ) {
        throw new NodeMutationError("cycle");
      }

      const sourceSiblings = lockedNodes
        .filter((node) => node.parentId === source.parentId && node.id !== source.id)
        .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
      const destinationSiblings =
        source.parentId === input.parentId
          ? sourceSiblings
          : lockedNodes
              .filter((node) => node.parentId === input.parentId)
              .sort(
                (left, right) => left.position - right.position || left.id.localeCompare(right.id),
              );
      const position = input.position ?? destinationSiblings.length;
      if (position < 0 || position > destinationSiblings.length) {
        throw new NodeMutationError("invalid-position");
      }

      const reorderedDestination = [...destinationSiblings];
      reorderedDestination.splice(position, 0, source);
      await tx.execute(sql`set constraints nodes_sibling_position_unique deferred`);

      if (source.parentId !== input.parentId) {
        await rewriteSiblingGroup(tx, userId, sourceSiblings, source.parentId);
      }
      await rewriteSiblingGroup(tx, userId, reorderedDestination, input.parentId);

      return { ...source, parentId: input.parentId, position };
    });
  } catch (error) {
    throw sanitizeNodeServiceError(error);
  }
}

export async function archiveNodeForUser(userId: string, input: NodeLifecycleInput) {
  try {
    return await db.transaction(async (tx) => {
      const lockedNodes = await lockOwnerNodes(tx, userId);
      const target = requireNode(lockedNodes, input.id);
      const subtreeIds = getSubtreeIds(lockedNodes, target.id);
      const archivedAt = new Date();

      await tx
        .update(nodes)
        .set({ archivedAt, updatedAt: archivedAt })
        .where(
          and(
            eq(nodes.userId, userId),
            inArray(nodes.id, subtreeIds),
            isNull(nodes.archivedAt),
          ),
        );

      return { ...target, archivedAt: target.archivedAt ?? archivedAt.toISOString() };
    });
  } catch (error) {
    throw sanitizeNodeServiceError(error);
  }
}

export async function unarchiveNodeForUser(userId: string, input: NodeLifecycleInput) {
  try {
    return await db.transaction(async (tx) => {
      const lockedNodes = await lockOwnerNodes(tx, userId);
      const target = requireNode(lockedNodes, input.id);
      const nodeById = new Map(lockedNodes.map((node) => [node.id, node]));
      const pathIds: string[] = [];
      const visited = new Set<string>();
      let current: FlatNode | undefined = target;

      while (current) {
        if (visited.has(current.id)) {
          throw new NodeMutationError("cycle");
        }
        visited.add(current.id);
        pathIds.push(current.id);
        const parentId = current.parentId;
        if (parentId === null) {
          current = undefined;
          continue;
        }
        current = nodeById.get(parentId);
        if (!current) {
          throw new NodeMutationError("unavailable");
        }
      }

      const updatedAt = new Date();
      await tx
        .update(nodes)
        .set({ archivedAt: null, updatedAt })
        .where(
          and(
            eq(nodes.userId, userId),
            inArray(nodes.id, pathIds),
            isNotNull(nodes.archivedAt),
          ),
        );

      return { ...target, archivedAt: null };
    });
  } catch (error) {
    throw sanitizeNodeServiceError(error);
  }
}

export async function deleteNodeForUser(userId: string, input: NodeLifecycleInput) {
  try {
    return await db.transaction(async (tx) => {
      const lockedNodes = await lockOwnerNodes(tx, userId);
      const target = requireNode(lockedNodes, input.id);
      const subtreeIds = new Set(getSubtreeIds(lockedNodes, target.id));
      const remainingSiblings = lockedNodes
        .filter(
          (node) => node.parentId === target.parentId && !subtreeIds.has(node.id),
        )
        .sort(
          (left, right) =>
            left.position - right.position || left.id.localeCompare(right.id),
        );
      const recoveryNodeId = target.parentId ?? (
        remainingSiblings.find((node) => node.position > target.position)?.id ??
        remainingSiblings.at(-1)?.id ??
        null
      );

      await tx.execute(sql`set constraints nodes_sibling_position_unique deferred`);
      const [deleted] = await tx
        .delete(nodes)
        .where(and(eq(nodes.userId, userId), eq(nodes.id, target.id)))
        .returning({ id: nodes.id });

      if (!deleted) {
        throw new NodeMutationError("node-not-found");
      }

      await rewriteSiblingGroup(tx, userId, remainingSiblings, target.parentId);

      return { nodeId: deleted.id, parentId: target.parentId, recoveryNodeId };
    });
  } catch (error) {
    throw sanitizeNodeServiceError(error);
  }
}
