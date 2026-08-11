import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { nodeEmbeddings } from "@/db/schema";
import {
  OPENAI_EMBEDDING_DIMENSIONS,
  OPENAI_EMBEDDING_MODEL,
} from "@/lib/ai/openai-profiles";
import { fingerprintSynthesisRelatedInput } from "@/lib/server/synthesis-input-fingerprint";

export const MAX_RELATED_NODE_RESULTS = 5;
export const MAX_RELATED_NODE_EXCLUSIONS = 256;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type RelatedNodeResult = {
  nodeId: string;
  parentId: string | null;
  title: string;
  archived: boolean;
  synthesisVersionId: string;
  content: string;
  sourceStateFingerprint: string;
  cosineDistance: number;
};

type RelatedNodeRow = {
  node_id: string;
  parent_id: string | null;
  title: string;
  archived_at: Date | null;
  synthesis_version_id: string;
  content: string;
  cosine_distance: number;
};

function normalizeExcludedNodeIds(targetNodeId: string, nodeIds: readonly string[]) {
  if (!UUID_PATTERN.test(targetNodeId)) {
    throw new TypeError("target node ID must be a UUID");
  }
  if (nodeIds.length > MAX_RELATED_NODE_EXCLUSIONS) {
    throw new TypeError("too many related-node exclusions");
  }

  const excluded = new Set([targetNodeId]);
  for (const nodeId of nodeIds) {
    if (!UUID_PATTERN.test(nodeId)) {
      throw new TypeError("excluded node IDs must be UUIDs");
    }
    excluded.add(nodeId);
  }
  return [...excluded].sort();
}

export async function getRelatedNodesForUser(
  userId: string,
  input: {
    targetNodeId: string;
    excludeNodeIds?: readonly string[];
  },
): Promise<RelatedNodeResult[]> {
  const excludedNodeIds = normalizeExcludedNodeIds(
    input.targetNodeId,
    input.excludeNodeIds ?? [],
  );
  const excludedNodeList = sql.join(
    excludedNodeIds.map((nodeId) => sql`${nodeId}::uuid`),
    sql`, `,
  );
  const result = await db.execute<RelatedNodeRow>(sql`
    with recursive target_ancestor_ids as (
      select candidate.parent_id as id
      from "nodes" as candidate
      where candidate.user_id = ${userId}
        and candidate.id = ${input.targetNodeId}
        and candidate.parent_id is not null

      union

      select ancestor.parent_id
      from "nodes" as ancestor
      inner join target_ancestor_ids
        on target_ancestor_ids.id = ancestor.id
      where ancestor.user_id = ${userId}
        and ancestor.parent_id is not null
    ), query_embedding as (
      select ${nodeEmbeddings.embedding} as embedding
      from ${nodeEmbeddings}
      inner join "nodes" as query_node
        on query_node.user_id = ${nodeEmbeddings.userId}
        and query_node.id = ${nodeEmbeddings.nodeId}
        and query_node.published_synthesis_version_id =
          ${nodeEmbeddings.sourceSynthesisVersionId}
      inner join "synthesis_versions" as query_version
        on query_version.user_id = ${nodeEmbeddings.userId}
        and query_version.node_id = ${nodeEmbeddings.nodeId}
        and query_version.id =
          ${nodeEmbeddings.sourceSynthesisVersionId}
        and query_version.status = 'approved'
      where ${nodeEmbeddings.userId} = ${userId}
        and ${nodeEmbeddings.nodeId} = ${input.targetNodeId}
        and ${nodeEmbeddings.model} = ${OPENAI_EMBEDDING_MODEL}
        and ${nodeEmbeddings.dimensions} = ${OPENAI_EMBEDDING_DIMENSIONS}
    )
    select
      candidate_node.id as node_id,
      candidate_node.parent_id as parent_id,
      candidate_node.title as title,
      candidate_node.archived_at as archived_at,
      candidate_version.id as synthesis_version_id,
      candidate_version.content as content,
      (${nodeEmbeddings.embedding} <=> query_embedding.embedding)::float8 as cosine_distance
    from query_embedding
    inner join ${nodeEmbeddings}
      on ${nodeEmbeddings.userId} = ${userId}
    inner join "nodes" as candidate_node
      on candidate_node.user_id = ${nodeEmbeddings.userId}
      and candidate_node.id = ${nodeEmbeddings.nodeId}
      and candidate_node.published_synthesis_version_id =
        ${nodeEmbeddings.sourceSynthesisVersionId}
    inner join "synthesis_versions" as candidate_version
      on candidate_version.user_id = ${nodeEmbeddings.userId}
      and candidate_version.node_id = ${nodeEmbeddings.nodeId}
      and candidate_version.id =
        ${nodeEmbeddings.sourceSynthesisVersionId}
      and candidate_version.status = 'approved'
    where ${nodeEmbeddings.nodeId} not in (${excludedNodeList})
      and candidate_node.parent_id is distinct from ${input.targetNodeId}
      and not exists (
        select 1 from target_ancestor_ids
        where target_ancestor_ids.id = ${nodeEmbeddings.nodeId}
      )
      and ${nodeEmbeddings.model} = ${OPENAI_EMBEDDING_MODEL}
      and ${nodeEmbeddings.dimensions} = ${OPENAI_EMBEDDING_DIMENSIONS}
    order by cosine_distance asc, candidate_node.id asc
    limit ${MAX_RELATED_NODE_RESULTS}
  `);

  return result.rows.map((row) => ({
    nodeId: row.node_id,
    parentId: row.parent_id,
    title: row.title,
    archived: row.archived_at !== null,
    synthesisVersionId: row.synthesis_version_id,
    content: row.content,
    sourceStateFingerprint: fingerprintSynthesisRelatedInput({
      nodeId: row.node_id,
      synthesisVersionId: row.synthesis_version_id,
    }),
    cosineDistance: row.cosine_distance,
  }));
}
