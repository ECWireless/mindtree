import "server-only";

import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { DrizzleError, DrizzleQueryError } from "drizzle-orm/errors";

import { db } from "@/db/client";
import {
  branchOutlineVersions,
  branchShareLinks,
  citations,
  nodes,
  synthesisVersions,
  user,
} from "@/db/schema";
import {
  MAX_PUBLIC_TRAIL_NODES,
  MAX_PUBLIC_TRAIL_SERIALIZED_BYTES,
  publicTrailSelectionSchema,
  type BranchShareLinkState,
  type PublicSynthesisCitation,
  type PublicThoughtTrail,
  type PublicThoughtTrailNode,
} from "@/lib/sharing/contracts";
import {
  decryptBranchShareSecret,
  digestBranchShareSecret,
  encryptBranchShareSecret,
  generateBranchShareSecret,
} from "@/lib/server/share-capability";
import {
  normalizeExternalCitationViews,
} from "@/lib/server/external-citations";

type ShareTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

type PostgreSqlFailure = {
  code: string;
  constraint?: string;
};

type PublicNodeStructureRow = {
  id: string;
  parent_id: string | null;
  position: number;
  title: string;
  published_synthesis_version_id: string | null;
  current_branch_outline_version_id: string | null;
};

type PublicCitationRow = {
  synthesisVersionId: string | null;
  kind: "internal" | "external";
  ordinal: number;
  startUtf16: number;
  endUtf16: number;
  liveTargetNodeId: string | null;
  externalTitle: string | null;
  externalUrl: string | null;
};

export class BranchShareServiceError extends Error {
  constructor(public readonly reason:
    | "archived-root"
    | "invalid-link"
    | "link-exists"
    | "node-not-found"
    | "not-found"
    | "oversized"
    | "unrecoverable-link"
    | "unavailable") {
    super(reason);
    this.name = "BranchShareServiceError";
  }
}

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

function sanitizeShareServiceError(error: unknown) {
  if (error instanceof BranchShareServiceError) return error;
  const failure = getPostgreSqlFailure(error);
  if (
    failure?.code === "23505" &&
    failure.constraint === "branch_share_links_user_root_unique"
  ) {
    return new BranchShareServiceError("link-exists");
  }
  if (
    error instanceof DrizzleError ||
    error instanceof DrizzleQueryError ||
    failure !== null
  ) {
    return new BranchShareServiceError("unavailable");
  }
  return error instanceof Error
    ? error
    : new BranchShareServiceError("unavailable");
}

function toShareLinkState(
  row: Pick<
    typeof branchShareLinks.$inferSelect,
    "id" | "rootNodeId" | "secretCiphertext" | "createdAt"
  >,
): BranchShareLinkState {
  return {
    id: row.id,
    rootNodeId: row.rootNodeId,
    createdAt: row.createdAt.toISOString(),
    recoverable: row.secretCiphertext !== null,
  };
}

async function lockOwnerAndRoot(
  tx: ShareTransaction,
  userId: string,
  rootNodeId: string,
) {
  await tx.execute(sql`select ${user.id} from ${user} where ${user.id} = ${userId} for update`);
  const [root] = await tx
    .select({ id: nodes.id, archivedAt: nodes.archivedAt })
    .from(nodes)
    .where(and(eq(nodes.userId, userId), eq(nodes.id, rootNodeId)))
    .for("update");
  if (!root) throw new BranchShareServiceError("node-not-found");
  return root;
}

export async function getBranchShareLinkStateForUser(
  userId: string,
  rootNodeId: string,
): Promise<BranchShareLinkState | null> {
  try {
    const [root] = await db
      .select({ id: nodes.id })
      .from(nodes)
      .where(and(eq(nodes.userId, userId), eq(nodes.id, rootNodeId)));
    if (!root) throw new BranchShareServiceError("node-not-found");
    const [link] = await db
      .select({
        id: branchShareLinks.id,
        rootNodeId: branchShareLinks.rootNodeId,
        secretCiphertext: branchShareLinks.secretCiphertext,
        createdAt: branchShareLinks.createdAt,
      })
      .from(branchShareLinks)
      .where(and(
        eq(branchShareLinks.userId, userId),
        eq(branchShareLinks.rootNodeId, rootNodeId),
      ));
    return link ? toShareLinkState(link) : null;
  } catch (error) {
    throw sanitizeShareServiceError(error);
  }
}

export async function createBranchShareLinkForUser(
  userId: string,
  rootNodeId: string,
  encryptionKey: string,
): Promise<{ link: BranchShareLinkState; secret: string }> {
  const linkId = randomUUID();
  const secret = generateBranchShareSecret();
  const secretDigest = digestBranchShareSecret(secret);
  const secretCiphertext = encryptBranchShareSecret(secret, encryptionKey, {
    linkId,
    userId,
    rootNodeId,
  });
  if (!secretDigest || !secretCiphertext) {
    throw new BranchShareServiceError("unavailable");
  }
  try {
    const created = await db.transaction(async (tx) => {
      const root = await lockOwnerAndRoot(tx, userId, rootNodeId);
      if (root.archivedAt !== null) {
        throw new BranchShareServiceError("archived-root");
      }
      const [existing] = await tx
        .select({ id: branchShareLinks.id })
        .from(branchShareLinks)
        .where(and(
          eq(branchShareLinks.userId, userId),
          eq(branchShareLinks.rootNodeId, rootNodeId),
        ));
      if (existing) throw new BranchShareServiceError("link-exists");
      const [link] = await tx
        .insert(branchShareLinks)
        .values({
          id: linkId,
          userId,
          rootNodeId,
          secretDigest,
          secretCiphertext,
        })
        .returning({
          id: branchShareLinks.id,
          rootNodeId: branchShareLinks.rootNodeId,
          secretCiphertext: branchShareLinks.secretCiphertext,
          createdAt: branchShareLinks.createdAt,
        });
      if (!link) throw new BranchShareServiceError("unavailable");
      return toShareLinkState(link);
    });
    return { link: created, secret };
  } catch (error) {
    throw sanitizeShareServiceError(error);
  }
}

export async function recoverBranchShareLinkForUser(
  userId: string,
  rootNodeId: string,
  encryptionKey: string,
): Promise<{ link: BranchShareLinkState; secret: string }> {
  try {
    const [root] = await db
      .select({ id: nodes.id })
      .from(nodes)
      .where(and(eq(nodes.userId, userId), eq(nodes.id, rootNodeId)));
    if (!root) throw new BranchShareServiceError("node-not-found");

    const [link] = await db
      .select({
        id: branchShareLinks.id,
        rootNodeId: branchShareLinks.rootNodeId,
        secretDigest: branchShareLinks.secretDigest,
        secretCiphertext: branchShareLinks.secretCiphertext,
        createdAt: branchShareLinks.createdAt,
      })
      .from(branchShareLinks)
      .where(and(
        eq(branchShareLinks.userId, userId),
        eq(branchShareLinks.rootNodeId, rootNodeId),
      ));
    if (!link) throw new BranchShareServiceError("not-found");
    if (!link.secretCiphertext) {
      throw new BranchShareServiceError("unrecoverable-link");
    }

    const secret = decryptBranchShareSecret(
      link.secretCiphertext,
      encryptionKey,
      { linkId: link.id, userId, rootNodeId },
    );
    if (!secret || digestBranchShareSecret(secret) !== link.secretDigest) {
      throw new BranchShareServiceError("unavailable");
    }
    return { link: toShareLinkState(link), secret };
  } catch (error) {
    throw sanitizeShareServiceError(error);
  }
}

export async function revokeBranchShareLinkForUser(
  userId: string,
  rootNodeId: string,
) {
  try {
    return await db.transaction(async (tx) => {
      await lockOwnerAndRoot(tx, userId, rootNodeId);
      const deleted = await tx
        .delete(branchShareLinks)
        .where(and(
          eq(branchShareLinks.userId, userId),
          eq(branchShareLinks.rootNodeId, rootNodeId),
        ))
        .returning({ id: branchShareLinks.id });
      return { nodeId: rootNodeId, revoked: deleted.length > 0 };
    });
  } catch (error) {
    throw sanitizeShareServiceError(error);
  }
}

async function loadPublicCitations(
  tx: ShareTransaction,
  userId: string,
  synthesisVersionIds: readonly string[],
  inScopeNodeIds: ReadonlySet<string>,
  synthesisContentById: ReadonlyMap<string, string>,
) {
  const byVersionId = new Map<string, PublicSynthesisCitation[]>();
  if (synthesisVersionIds.length === 0) return byVersionId;
  const rows: PublicCitationRow[] = await tx
    .select({
      synthesisVersionId: citations.synthesisVersionId,
      kind: citations.kind,
      ordinal: citations.ordinal,
      startUtf16: citations.startUtf16,
      endUtf16: citations.endUtf16,
      liveTargetNodeId: citations.liveTargetNodeId,
      externalTitle: citations.externalTitle,
      externalUrl: citations.externalUrl,
    })
    .from(citations)
    .where(and(
      eq(citations.userId, userId),
      inArray(citations.synthesisVersionId, [...synthesisVersionIds]),
    ))
    .orderBy(
      asc(citations.synthesisVersionId),
      asc(citations.startUtf16),
      asc(citations.ordinal),
    );
  for (const row of rows) {
    if (row.synthesisVersionId === null) {
      throw new BranchShareServiceError("unavailable");
    }
    let view: PublicSynthesisCitation;
    if (row.kind === "internal") {
      view = {
        kind: "internal",
        ordinal: row.ordinal,
        startUtf16: row.startUtf16,
        endUtf16: row.endUtf16,
        targetNodeId:
          row.liveTargetNodeId && inScopeNodeIds.has(row.liveTargetNodeId)
            ? row.liveTargetNodeId
            : null,
      };
    } else {
      if (!row.externalTitle || !row.externalUrl) {
        throw new BranchShareServiceError("unavailable");
      }
      view = {
        kind: "external",
        ordinal: row.ordinal,
        startUtf16: row.startUtf16,
        endUtf16: row.endUtf16,
        title: row.externalTitle,
        url: row.externalUrl,
      };
    }
    const views = byVersionId.get(row.synthesisVersionId) ?? [];
    views.push(view);
    byVersionId.set(row.synthesisVersionId, views);
  }
  for (const [versionId, views] of byVersionId) {
    const content = synthesisContentById.get(versionId);
    if (content === undefined) {
      throw new BranchShareServiceError("unavailable");
    }
    const external = views.filter(
      (citation): citation is Extract<PublicSynthesisCitation, { kind: "external" }> =>
        citation.kind === "external",
    );
    let normalizedExternal: typeof external;
    try {
      normalizedExternal = external.length > 0
        ? normalizeExternalCitationViews({ content, citations: external })
        : [];
    } catch {
      throw new BranchShareServiceError("unavailable");
    }
    let externalIndex = 0;
    byVersionId.set(versionId, views.map((citation) => {
      if (citation.kind === "external") {
        return normalizedExternal[externalIndex++]!;
      }
      if (
        citation.startUtf16 < 0 ||
        citation.endUtf16 <= citation.startUtf16 ||
        citation.endUtf16 > content.length
      ) {
        throw new BranchShareServiceError("unavailable");
      }
      return citation;
    }));
  }
  return byVersionId;
}

function orderPublicNodeRows(
  rows: readonly PublicNodeStructureRow[],
  rootNodeId: string,
) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  if (byId.size !== rows.length || !byId.has(rootNodeId)) {
    throw new BranchShareServiceError("unavailable");
  }
  const childrenByParent = new Map<string, PublicNodeStructureRow[]>();
  for (const row of rows) {
    if (row.id === rootNodeId) continue;
    if (!row.parent_id || !byId.has(row.parent_id)) {
      throw new BranchShareServiceError("unavailable");
    }
    const children = childrenByParent.get(row.parent_id) ?? [];
    children.push(row);
    childrenByParent.set(row.parent_id, children);
  }
  for (const children of childrenByParent.values()) {
    children.sort((left, right) =>
      left.position - right.position || left.id.localeCompare(right.id)
    );
  }

  const ordered: Array<{ row: PublicNodeStructureRow; publicPosition: number }> = [];
  const visited = new Set<string>();
  const work = [{ row: byId.get(rootNodeId)!, publicPosition: 0 }];
  while (work.length > 0) {
    const item = work.pop();
    if (!item || visited.has(item.row.id)) {
      throw new BranchShareServiceError("unavailable");
    }
    visited.add(item.row.id);
    ordered.push(item);
    const children = childrenByParent.get(item.row.id) ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      work.push({ row: children[index]!, publicPosition: index });
    }
  }
  if (visited.size !== rows.length) {
    throw new BranchShareServiceError("unavailable");
  }
  return ordered;
}

export async function getPublicThoughtTrail(
  secret: string,
  requestedNodeId?: string,
  testHooks: { afterLinkLocked?: () => Promise<void> } = {},
): Promise<PublicThoughtTrail> {
  const secretDigest = digestBranchShareSecret(secret);
  if (!secretDigest) throw new BranchShareServiceError("invalid-link");
  const parsedSelection = requestedNodeId === undefined
    ? null
    : publicTrailSelectionSchema.safeParse(requestedNodeId);
  if (parsedSelection && !parsedSelection.success) {
    throw new BranchShareServiceError("not-found");
  }
  try {
    return await db.transaction(async (tx) => {
      const [link] = await tx
        .select({
          id: branchShareLinks.id,
          userId: branchShareLinks.userId,
          rootNodeId: branchShareLinks.rootNodeId,
        })
        .from(branchShareLinks)
        .where(eq(branchShareLinks.secretDigest, secretDigest))
        .for("share");
      if (!link) throw new BranchShareServiceError("not-found");
      await testHooks.afterLinkLocked?.();

      const result = await tx.execute<PublicNodeStructureRow>(sql`
        with recursive shared_nodes as (
          select
            root.id,
            root.parent_id,
            root.position,
            root.title,
            root.published_synthesis_version_id,
            root.current_branch_outline_version_id,
            array[root.id]::uuid[] as id_path
          from nodes root
          where root.user_id = ${link.userId}
            and root.id = ${link.rootNodeId}
            and root.archived_at is null

          union all

          select
            child.id,
            child.parent_id,
            child.position,
            child.title,
            child.published_synthesis_version_id,
            child.current_branch_outline_version_id,
            shared_nodes.id_path || child.id
          from shared_nodes
          inner join nodes child
            on child.user_id = ${link.userId}
            and child.parent_id = shared_nodes.id
            and child.archived_at is null
            and not child.id = any(shared_nodes.id_path)
        )
        select
          shared_nodes.id,
          shared_nodes.parent_id,
          shared_nodes.position,
          shared_nodes.title,
          shared_nodes.published_synthesis_version_id,
          shared_nodes.current_branch_outline_version_id
        from shared_nodes
        limit ${MAX_PUBLIC_TRAIL_NODES + 1}
      `);
      const discoveredRows = result.rows;
      if (discoveredRows.length === 0) {
        throw new BranchShareServiceError("not-found");
      }
      if (discoveredRows.length > MAX_PUBLIC_TRAIL_NODES) {
        throw new BranchShareServiceError("oversized");
      }
      const orderedRows = orderPublicNodeRows(
        discoveredRows,
        link.rootNodeId,
      );
      const rows = orderedRows.map(({ row }) => row);
      const inScopeNodeIds = new Set(rows.map(({ id }) => id));
      const selectedNodeId = parsedSelection?.success
        ? parsedSelection.data
        : link.rootNodeId;
      if (!inScopeNodeIds.has(selectedNodeId)) {
        throw new BranchShareServiceError("not-found");
      }
      const synthesisVersionIds = rows.flatMap((row) =>
        row.published_synthesis_version_id
          ? [row.published_synthesis_version_id]
          : []
      );
      const branchOutlineVersionIds = rows.flatMap((row) =>
        row.current_branch_outline_version_id
          ? [row.current_branch_outline_version_id]
          : []
      );
      if (
        new Set(synthesisVersionIds).size !== synthesisVersionIds.length ||
        new Set(branchOutlineVersionIds).size !== branchOutlineVersionIds.length
      ) {
        throw new BranchShareServiceError("unavailable");
      }
      const publicNodes: PublicThoughtTrailNode[] = orderedRows.map(({
        row,
        publicPosition,
      }) => ({
        id: row.id,
        parentId: row.id === link.rootNodeId ? null : row.parent_id,
        position: publicPosition,
        title: row.title,
        summary: row.published_synthesis_version_id
          ? { content: "", citations: [] }
          : null,
        branchOutline: row.current_branch_outline_version_id
          ? { content: "" }
          : null,
      }));
      const structureTrail: PublicThoughtTrail = {
        rootNodeId: link.rootNodeId,
        selectedNodeId,
        nodes: publicNodes,
      };
      const structureSerializedBytes = Buffer.byteLength(
        JSON.stringify(structureTrail),
        "utf8",
      );
      if (structureSerializedBytes > MAX_PUBLIC_TRAIL_SERIALIZED_BYTES) {
        throw new BranchShareServiceError("oversized");
      }

      const [summaryBudget] = synthesisVersionIds.length > 0
        ? await tx
            .select({
              count: sql<number>`count(*)::int`,
              contentBytes: sql<string>`coalesce(sum(octet_length(${synthesisVersions.content})), 0)::bigint`,
            })
            .from(synthesisVersions)
            .where(and(
              eq(synthesisVersions.userId, link.userId),
              eq(synthesisVersions.status, "approved"),
              inArray(synthesisVersions.id, synthesisVersionIds),
            ))
        : [{ count: 0, contentBytes: "0" }];
      const [outlineBudget] = branchOutlineVersionIds.length > 0
        ? await tx
            .select({
              count: sql<number>`count(*)::int`,
              contentBytes: sql<string>`coalesce(sum(octet_length(${branchOutlineVersions.content})), 0)::bigint`,
            })
            .from(branchOutlineVersions)
            .where(and(
              eq(branchOutlineVersions.userId, link.userId),
              eq(branchOutlineVersions.status, "completed"),
              inArray(branchOutlineVersions.id, branchOutlineVersionIds),
            ))
        : [{ count: 0, contentBytes: "0" }];
      if (
        !summaryBudget ||
        !outlineBudget ||
        summaryBudget.count !== synthesisVersionIds.length ||
        outlineBudget.count !== branchOutlineVersionIds.length
      ) {
        throw new BranchShareServiceError("unavailable");
      }
      const contentBytes = Number(summaryBudget.contentBytes) +
        Number(outlineBudget.contentBytes);
      if (
        !Number.isSafeInteger(contentBytes) ||
        structureSerializedBytes + contentBytes >
          MAX_PUBLIC_TRAIL_SERIALIZED_BYTES
      ) {
        throw new BranchShareServiceError("oversized");
      }

      const [summaryRows, outlineRows] = await Promise.all([
        synthesisVersionIds.length > 0
          ? tx
              .select({
                id: synthesisVersions.id,
                nodeId: synthesisVersions.nodeId,
                content: synthesisVersions.content,
              })
              .from(synthesisVersions)
              .where(and(
                eq(synthesisVersions.userId, link.userId),
                eq(synthesisVersions.status, "approved"),
                inArray(synthesisVersions.id, synthesisVersionIds),
              ))
          : [],
        branchOutlineVersionIds.length > 0
          ? tx
              .select({
                id: branchOutlineVersions.id,
                nodeId: branchOutlineVersions.nodeId,
                content: branchOutlineVersions.content,
              })
              .from(branchOutlineVersions)
              .where(and(
                eq(branchOutlineVersions.userId, link.userId),
                eq(branchOutlineVersions.status, "completed"),
                inArray(branchOutlineVersions.id, branchOutlineVersionIds),
              ))
          : [],
      ]);
      const summaryById = new Map(summaryRows.map((row) => [row.id, row]));
      const outlineById = new Map(outlineRows.map((row) => [row.id, row]));
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index]!;
        const publicNode = publicNodes[index]!;
        if (row.published_synthesis_version_id) {
          const summary = summaryById.get(row.published_synthesis_version_id);
          if (!summary || summary.nodeId !== row.id || !publicNode.summary) {
            throw new BranchShareServiceError("unavailable");
          }
          publicNode.summary.content = summary.content;
        }
        if (row.current_branch_outline_version_id) {
          const outline = outlineById.get(row.current_branch_outline_version_id);
          if (!outline || outline.nodeId !== row.id || !publicNode.branchOutline) {
            throw new BranchShareServiceError("unavailable");
          }
          publicNode.branchOutline.content = outline.content;
        }
      }
      const baseTrail: PublicThoughtTrail = {
        rootNodeId: link.rootNodeId,
        selectedNodeId,
        nodes: publicNodes,
      };
      const baseSerializedBytes = Buffer.byteLength(
        JSON.stringify(baseTrail),
        "utf8",
      );
      if (baseSerializedBytes > MAX_PUBLIC_TRAIL_SERIALIZED_BYTES) {
        throw new BranchShareServiceError("oversized");
      }
      if (synthesisVersionIds.length > 0) {
        const [citationBudget] = await tx
          .select({
            count: sql<number>`count(*)::int`,
            externalBytes: sql<number>`coalesce(sum(
              octet_length(coalesce(${citations.externalTitle}, '')) +
              octet_length(coalesce(${citations.externalUrl}, ''))
            ), 0)::int`,
          })
          .from(citations)
          .where(and(
            eq(citations.userId, link.userId),
            inArray(citations.synthesisVersionId, synthesisVersionIds),
          ));
        if (
          !citationBudget ||
          baseSerializedBytes + citationBudget.externalBytes +
            citationBudget.count * 256 > MAX_PUBLIC_TRAIL_SERIALIZED_BYTES
        ) {
          throw new BranchShareServiceError("oversized");
        }
      }
      const citationViews = await loadPublicCitations(
        tx,
        link.userId,
        synthesisVersionIds,
        inScopeNodeIds,
        new Map(summaryRows.map((row) => [row.id, row.content])),
      );
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index]!;
        const publicNode = publicNodes[index]!;
        if (row.published_synthesis_version_id && publicNode.summary) {
          publicNode.summary.citations =
            citationViews.get(row.published_synthesis_version_id) ?? [];
        }
      }
      const trail: PublicThoughtTrail = {
        rootNodeId: link.rootNodeId,
        selectedNodeId,
        nodes: publicNodes,
      };
      if (
        Buffer.byteLength(JSON.stringify(trail), "utf8") >
        MAX_PUBLIC_TRAIL_SERIALIZED_BYTES
      ) {
        throw new BranchShareServiceError("oversized");
      }
      return trail;
    }, { isolationLevel: "repeatable read" });
  } catch (error) {
    throw sanitizeShareServiceError(error);
  }
}
