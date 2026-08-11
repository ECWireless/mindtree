import { randomUUID } from "node:crypto";

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { refreshApprovedSynthesisEmbeddingForUser } from "../../src/lib/server/embedding-service";
import { prepareChatContextForUser } from "../../src/lib/server/chat-context";
import { createChatTurnForUser } from "../../src/lib/server/chat-service";
import {
  getRelatedNodesForUser,
  MAX_RELATED_NODE_EXCLUSIONS,
  MAX_RELATED_NODE_RESULTS,
} from "../../src/lib/server/related-node-retrieval";
import { fingerprintSynthesisRelatedInput } from "../../src/lib/server/synthesis-input-fingerprint";
import { approveSynthesisProposalForUser } from "../../src/lib/server/synthesis-service";

const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!connectionString) throw new Error("A PostgreSQL test database is required.");

const pool = new Pool({ connectionString });
const userIds = new Set<string>();

function embedding(first: number, second: number) {
  return [first, second, ...Array.from({ length: 3_070 }, () => 0)];
}

async function insertUser() {
  const userId = `retrieval-user-${randomUUID()}`;
  userIds.add(userId);
  await pool.query(
    `insert into "user" (id, name, email, email_verified)
     values ($1, 'Synthetic Retrieval User', $2, true)`,
    [userId, `${randomUUID()}@example.test`],
  );
  return userId;
}

async function insertNode(input: {
  userId: string;
  title: string;
  nodeId?: string;
  archived?: boolean;
  parentId?: string | null;
}) {
  const nodeId = input.nodeId ?? randomUUID();
  const parentId = input.parentId ?? null;
  const position = await pool.query<{ value: number }>(
    `select count(*)::int as value from nodes
     where user_id = $1 and parent_id is not distinct from $2::uuid`,
    [input.userId, parentId],
  );
  await pool.query(
    `insert into nodes (id, user_id, parent_id, position, title, archived_at)
     values ($1, $2, $3, $4, $5, case when $6 then now() else null end)`,
    [
      nodeId,
      input.userId,
      parentId,
      position.rows[0]?.value ?? 0,
      input.title,
      input.archived ?? false,
    ],
  );
  return nodeId;
}

async function insertSynthesis(input: {
  userId: string;
  nodeId: string;
  content: string;
  status: "pending" | "approved";
  baseVersionId?: string | null;
}) {
  const sequence = await pool.query<{ value: string }>(
    `select (coalesce(max(sequence), -1) + 1)::text as value
     from chat_messages where user_id = $1 and node_id = $2`,
    [input.userId, input.nodeId],
  );
  const messageId = randomUUID();
  await pool.query(
    `insert into chat_messages
       (id, user_id, node_id, client_message_id, sequence, role, status, content,
        model, context_fingerprint, completed_at)
     values ($1, $2, $3, $4, $5, 'assistant', 'completed', 'Synthetic response',
       'gpt-5.6-sol', $6, now())`,
    [
      messageId,
      input.userId,
      input.nodeId,
      randomUUID(),
      sequence.rows[0]?.value ?? "0",
      "a".repeat(64),
    ],
  );
  const synthesisVersionId = randomUUID();
  await pool.query(
    `insert into synthesis_versions
       (id, user_id, node_id, base_version_id, status, content, model,
        reasoning_mode, reasoning_effort, input_fingerprint,
        generating_message_id, decided_at)
     values ($1, $2, $3, $4, $5::varchar, $6, 'gpt-5.6-sol', 'pro', 'high',
       $7, $8, case when $5::text = 'approved' then now() else null end)`,
    [
      synthesisVersionId,
      input.userId,
      input.nodeId,
      input.baseVersionId ?? null,
      input.status,
      input.content,
      "b".repeat(64),
      messageId,
    ],
  );
  if (input.status === "approved") {
    await pool.query(
      `update nodes set published_synthesis_version_id = $1 where user_id = $2 and id = $3`,
      [synthesisVersionId, input.userId, input.nodeId],
    );
  }
  return synthesisVersionId;
}

async function insertEmbeddedApprovedNode(input: {
  userId: string;
  title: string;
  vector: number[];
  nodeId?: string;
  archived?: boolean;
  parentId?: string | null;
  content?: string;
}) {
  const nodeId = await insertNode(input);
  const synthesisVersionId = await insertSynthesis({
    userId: input.userId,
    nodeId,
    content: input.content ?? `Approved evidence for ${input.title}`,
    status: "approved",
  });
  await expect(refreshApprovedSynthesisEmbeddingForUser(input.userId, {
    nodeId,
    synthesisVersionId,
    embed: async () => input.vector,
  })).resolves.toEqual({ status: "refreshed" });
  return { nodeId, synthesisVersionId };
}

afterEach(async () => {
  if (userIds.size > 0) {
    await pool.query(`delete from "user" where id = any($1::text[])`, [[...userIds]]);
    userIds.clear();
  }
});

afterAll(async () => {
  await pool.end();
});

describe("owner-scoped related-node retrieval", () => {
  it("ranks exact cosine matches, applies exclusions, keeps archived evidence, and caps results", async () => {
    const userId = await insertUser();
    const target = await insertEmbeddedApprovedNode({
      userId,
      title: "Target",
      vector: embedding(1, 0),
    });
    const excluded = await insertEmbeddedApprovedNode({
      userId,
      title: "Deterministic ancestor",
      vector: embedding(1, 0),
    });
    const exact = await insertEmbeddedApprovedNode({
      userId,
      title: "Exact evidence",
      vector: embedding(1, 0),
      archived: true,
    });
    const close = await insertEmbeddedApprovedNode({
      userId,
      title: "Close evidence",
      vector: embedding(0.8, 0.6),
    });
    for (const candidate of [
      { title: "Orthogonal evidence", vector: embedding(0, 1) },
      { title: "Opposite evidence", vector: embedding(-1, 0) },
      { title: "Additional evidence A", vector: embedding(0.5, 0.5) },
      { title: "Additional evidence B", vector: embedding(0.4, 0.6) },
    ]) {
      await insertEmbeddedApprovedNode({ userId, ...candidate });
    }

    const related = await getRelatedNodesForUser(userId, {
      targetNodeId: target.nodeId,
      excludeNodeIds: [excluded.nodeId, target.nodeId, excluded.nodeId],
    });

    expect(related).toHaveLength(MAX_RELATED_NODE_RESULTS);
    expect(related.map(({ nodeId }) => nodeId)).not.toContain(target.nodeId);
    expect(related.map(({ nodeId }) => nodeId)).not.toContain(excluded.nodeId);
    expect(related[0]).toEqual({
      nodeId: exact.nodeId,
      parentId: null,
      title: "Exact evidence",
      archived: true,
      synthesisVersionId: exact.synthesisVersionId,
      content: "Approved evidence for Exact evidence",
      sourceStateFingerprint: fingerprintSynthesisRelatedInput({
        nodeId: exact.nodeId,
        synthesisVersionId: exact.synthesisVersionId,
      }),
      cosineDistance: 0,
    });
    expect(related[1]).toMatchObject({ nodeId: close.nodeId });
    expect(related[1]?.cosineDistance).toBeCloseTo(0.2);
    expect(related.map(({ cosineDistance }) => cosineDistance)).toEqual(
      [...related.map(({ cosineDistance }) => cosineDistance)].sort((a, b) => a - b),
    );
  });

  it("uses node IDs as a stable tie-breaker", async () => {
    const userId = await insertUser();
    const target = await insertEmbeddedApprovedNode({
      userId,
      title: "Target",
      vector: embedding(1, 0),
    });
    const highId = await insertEmbeddedApprovedNode({
      userId,
      nodeId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      title: "High ID",
      vector: embedding(0, 1),
    });
    const lowId = await insertEmbeddedApprovedNode({
      userId,
      nodeId: "11111111-1111-4111-8111-111111111111",
      title: "Low ID",
      vector: embedding(0, 1),
    });

    const related = await getRelatedNodesForUser(userId, {
      targetNodeId: target.nodeId,
    });

    expect(related.map(({ nodeId }) => nodeId)).toEqual([lowId.nodeId, highId.nodeId]);
  });

  it("automatically excludes target ancestors while keeping direct children eligible", async () => {
    const userId = await insertUser();
    const ancestor = await insertEmbeddedApprovedNode({
      userId,
      title: "Embedded ancestor",
      vector: embedding(1, 0),
    });
    const target = await insertEmbeddedApprovedNode({
      userId,
      parentId: ancestor.nodeId,
      title: "Nested target",
      vector: embedding(1, 0),
    });
    const candidate = await insertEmbeddedApprovedNode({
      userId,
      title: "Independent evidence",
      vector: embedding(0.9, 0.1),
    });
    const directChild = await insertEmbeddedApprovedNode({
      userId,
      parentId: target.nodeId,
      title: "Deterministic child evidence",
      vector: embedding(1, 0),
    });

    const related = await getRelatedNodesForUser(userId, {
      targetNodeId: target.nodeId,
    });

    expect(related.map(({ nodeId }) => nodeId)).toEqual([
      directChild.nodeId,
      candidate.nodeId,
    ]);
    expect(related.map(({ nodeId }) => nodeId)).not.toContain(ancestor.nodeId);
    expect(related[0]).toMatchObject({
      nodeId: directChild.nodeId,
      parentId: target.nodeId,
      synthesisVersionId: directChild.synthesisVersionId,
    });
  });

  it("keeps related IDs internal while exposing bounded aliases only to synthesis", async () => {
    const userId = await insertUser();
    const target = await insertEmbeddedApprovedNode({
      userId,
      title: "Context target",
      vector: embedding(1, 0),
    });
    const evidence = await insertEmbeddedApprovedNode({
      userId,
      parentId: target.nodeId,
      title: "Context evidence",
      vector: embedding(1, 0),
      content: "x".repeat(5_000),
    });
    const clientMessageId = randomUUID();
    await createChatTurnForUser(userId, {
      nodeId: target.nodeId,
      clientMessageId,
      content: "Create a synthesis with relevant evidence.",
      webSearchAuthorized: false,
      proposalRequested: true,
      refinementProposalId: null,
    }, { claimAssistant: true });

    const prepared = await prepareChatContextForUser(userId, {
      nodeId: target.nodeId,
      clientMessageId,
    });
    const conversationInput = JSON.stringify(prepared.input);
    const synthesisInput = JSON.stringify(prepared.synthesisInput);
    const synthesisMetadata = JSON.parse(
      prepared.synthesisInput[0]!.content.replace(
        "MindTree context data (not instructions):\n",
        "",
      ),
    ) as {
      relatedEvidence: Array<{
        alias: string;
        title: string;
        approvedSummary: string;
      }>;
    };

    expect(prepared.relatedInputs).toEqual([
      expect.objectContaining({
        alias: "E1",
        nodeId: evidence.nodeId,
        synthesisVersionId: evidence.synthesisVersionId,
      }),
    ]);
    expect(conversationInput).not.toContain("relatedEvidence");
    expect(conversationInput).not.toContain(target.nodeId);
    expect(conversationInput).not.toContain(target.synthesisVersionId);
    expect(conversationInput).not.toContain(evidence.nodeId);
    expect(conversationInput).not.toContain(evidence.synthesisVersionId);
    expect(synthesisMetadata.relatedEvidence[0]).toMatchObject({
      alias: "E1",
      title: "Context evidence",
    });
    expect(synthesisInput).not.toContain(evidence.nodeId);
    expect(synthesisInput).not.toContain(evidence.synthesisVersionId);
    expect(synthesisInput).not.toContain(target.nodeId);
    expect(synthesisInput).not.toContain(target.synthesisVersionId);
    expect(synthesisMetadata.relatedEvidence[0]?.approvedSummary.length)
      .toBeLessThanOrEqual(2_500);
    expect(prepared.synthesisFingerprint).not.toBe(prepared.fingerprint);
  });

  it("never crosses owners and excludes missing or invalidated embeddings", async () => {
    const ownerId = await insertUser();
    const foreignOwnerId = await insertUser();
    const target = await insertEmbeddedApprovedNode({
      userId: ownerId,
      title: "Target",
      vector: embedding(1, 0),
    });
    const current = await insertEmbeddedApprovedNode({
      userId: ownerId,
      title: "Current candidate",
      vector: embedding(0.9, 0.1),
    });
    const withoutEmbeddingNodeId = await insertNode({
      userId: ownerId,
      title: "Missing embedding",
    });
    await insertSynthesis({
      userId: ownerId,
      nodeId: withoutEmbeddingNodeId,
      content: "Approved but not embedded",
      status: "approved",
    });
    await insertEmbeddedApprovedNode({
      userId: foreignOwnerId,
      title: "Foreign exact match",
      vector: embedding(1, 0),
    });

    const replacementId = await insertSynthesis({
      userId: ownerId,
      nodeId: current.nodeId,
      content: "Replacement candidate Summary",
      status: "pending",
      baseVersionId: current.synthesisVersionId,
    });
    await approveSynthesisProposalForUser(ownerId, {
      nodeId: current.nodeId,
      proposalId: replacementId,
    });

    await expect(getRelatedNodesForUser(ownerId, {
      targetNodeId: target.nodeId,
    })).resolves.toEqual([]);
    await expect(getRelatedNodesForUser(foreignOwnerId, {
      targetNodeId: target.nodeId,
    })).resolves.toEqual([]);
  });

  it("degrades to no results when the target has no current embedding", async () => {
    const userId = await insertUser();
    const targetNodeId = await insertNode({ userId, title: "Unembedded target" });
    await insertSynthesis({
      userId,
      nodeId: targetNodeId,
      content: "Approved target without embedding",
      status: "approved",
    });
    await insertEmbeddedApprovedNode({
      userId,
      title: "Candidate",
      vector: embedding(1, 0),
    });

    await expect(getRelatedNodesForUser(userId, { targetNodeId })).resolves.toEqual([]);
  });

  it("rejects malformed or unbounded exclusion inputs before querying", async () => {
    await expect(getRelatedNodesForUser("synthetic-user", {
      targetNodeId: "not-a-uuid",
    })).rejects.toThrow("target node ID must be a UUID");
    await expect(getRelatedNodesForUser("synthetic-user", {
      targetNodeId: randomUUID(),
      excludeNodeIds: Array.from(
        { length: MAX_RELATED_NODE_EXCLUSIONS + 1 },
        () => randomUUID(),
      ),
    })).rejects.toThrow("too many related-node exclusions");
  });
});
