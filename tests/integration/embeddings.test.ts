import { randomUUID } from "node:crypto";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";

import {
  refreshApprovedSynthesisEmbeddingForUser,
} from "../../src/lib/server/embedding-service";
import { OpenAIEmbeddingError } from "../../src/lib/server/openai-embeddings";
import { approveSynthesisProposalForUser } from "../../src/lib/server/synthesis-service";

const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!connectionString) throw new Error("A PostgreSQL test database is required.");

const pool = new Pool({ connectionString });
const userIds = new Set<string>();

function embedding(component = 0.25) {
  return [component, ...Array.from({ length: 3_071 }, () => 0)];
}

async function insertUser() {
  const userId = `embedding-user-${randomUUID()}`;
  userIds.add(userId);
  await pool.query(
    `insert into "user" (id, name, email, email_verified)
     values ($1, 'Synthetic Embedding User', $2, true)`,
    [userId, `${randomUUID()}@example.test`],
  );
  return userId;
}

async function insertNode(userId: string, title = "Embedding node") {
  const nodeId = randomUUID();
  await pool.query(
    `insert into nodes (id, user_id, parent_id, position, title)
     values ($1, $2, null, 0, $3)`,
    [nodeId, userId, title],
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

afterEach(async () => {
  if (userIds.size > 0) {
    await pool.query(`delete from "user" where id = any($1::text[])`, [[...userIds]]);
    userIds.clear();
  }
});

afterAll(async () => {
  await pool.end();
});

describe("approved synthesis embedding lifecycle", () => {
  it("embeds and stores only the exact current approved Summary", async () => {
    const userId = await insertUser();
    const nodeId = await insertNode(userId);
    const synthesisVersionId = await insertSynthesis({
      userId,
      nodeId,
      content: "Exact approved synthetic Summary",
      status: "approved",
    });
    const embed = vi.fn(async () => embedding());

    await expect(refreshApprovedSynthesisEmbeddingForUser(userId, {
      nodeId,
      synthesisVersionId,
      embed,
    })).resolves.toEqual({ status: "refreshed" });
    expect(embed).toHaveBeenCalledExactlyOnceWith("Exact approved synthetic Summary");

    const stored = await pool.query<{
      user_id: string;
      node_id: string;
      source_synthesis_version_id: string;
      model: string;
      dimensions: number;
      embedding_text: string;
    }>(
      `select user_id, node_id, source_synthesis_version_id, model, dimensions,
              embedding::text as embedding_text
       from node_embeddings where user_id = $1 and node_id = $2`,
      [userId, nodeId],
    );
    expect(stored.rows).toEqual([expect.objectContaining({
      user_id: userId,
      node_id: nodeId,
      source_synthesis_version_id: synthesisVersionId,
      model: "text-embedding-3-large",
      dimensions: 3_072,
      embedding_text: expect.stringMatching(/^\[0\.25,0,/),
    })]);
  });

  it("serializes concurrent refreshes before provider use", async () => {
    const userId = await insertUser();
    const nodeId = await insertNode(userId);
    const synthesisVersionId = await insertSynthesis({
      userId,
      nodeId,
      content: "Concurrently refreshed synthetic Summary",
      status: "approved",
    });
    let providerEntered!: () => void;
    let releaseProvider!: (value: number[]) => void;
    const providerStarted = new Promise<void>((resolve) => {
      providerEntered = resolve;
    });
    const providerResult = new Promise<number[]>((resolve) => {
      releaseProvider = resolve;
    });
    const embed = vi.fn(async () => {
      providerEntered();
      return providerResult;
    });

    const first = refreshApprovedSynthesisEmbeddingForUser(userId, {
      nodeId,
      synthesisVersionId,
      embed,
    });
    await providerStarted;
    const second = refreshApprovedSynthesisEmbeddingForUser(userId, {
      nodeId,
      synthesisVersionId,
      embed,
    });
    releaseProvider(embedding());

    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: "refreshed" },
      { status: "skipped", reason: "already-current" },
    ]);
    expect(embed).toHaveBeenCalledTimes(1);
  });

  it("skips missing, foreign, pending, and no-longer-current versions before provider use", async () => {
    const ownerId = await insertUser();
    const foreignOwnerId = await insertUser();
    const nodeId = await insertNode(ownerId);
    const currentVersionId = await insertSynthesis({
      userId: ownerId,
      nodeId,
      content: "Current approved Summary",
      status: "approved",
    });
    const pendingVersionId = await insertSynthesis({
      userId: ownerId,
      nodeId,
      content: "Pending Summary",
      status: "pending",
      baseVersionId: currentVersionId,
    });
    const embed = vi.fn(async () => embedding());

    for (const [userId, synthesisVersionId] of [
      [ownerId, pendingVersionId],
      [ownerId, randomUUID()],
      [foreignOwnerId, currentVersionId],
    ]) {
      await expect(refreshApprovedSynthesisEmbeddingForUser(userId, {
        nodeId,
        synthesisVersionId,
        embed,
      })).resolves.toEqual({ status: "skipped", reason: "not-current" });
    }
    expect(embed).not.toHaveBeenCalled();
  });

  it("rejects a slow stale install after a real concurrent approval", async () => {
    const userId = await insertUser();
    const nodeId = await insertNode(userId);
    const originalVersionId = await insertSynthesis({
      userId,
      nodeId,
      content: "Original approved Summary",
      status: "approved",
    });
    const replacementProposalId = await insertSynthesis({
      userId,
      nodeId,
      content: "Replacement pending Summary",
      status: "pending",
      baseVersionId: originalVersionId,
    });
    let providerEntered!: () => void;
    let releaseProvider!: (value: number[]) => void;
    const providerStarted = new Promise<void>((resolve) => {
      providerEntered = resolve;
    });
    const providerResult = new Promise<number[]>((resolve) => {
      releaseProvider = resolve;
    });

    const refresh = refreshApprovedSynthesisEmbeddingForUser(userId, {
      nodeId,
      synthesisVersionId: originalVersionId,
      embed: async () => {
        providerEntered();
        return providerResult;
      },
    });
    await providerStarted;
    await expect(approveSynthesisProposalForUser(userId, {
      nodeId,
      proposalId: replacementProposalId,
    })).resolves.toMatchObject({ id: replacementProposalId, status: "approved" });
    releaseProvider(embedding());

    await expect(refresh).resolves.toEqual({ status: "skipped", reason: "not-current" });
    expect((await pool.query(`select 1 from node_embeddings where node_id = $1`, [nodeId])).rowCount)
      .toBe(0);
  });

  it("invalidates the prior vector transactionally and leaves publication intact on refresh failure", async () => {
    const userId = await insertUser();
    const nodeId = await insertNode(userId);
    const originalVersionId = await insertSynthesis({
      userId,
      nodeId,
      content: "Original approved Summary",
      status: "approved",
    });
    await refreshApprovedSynthesisEmbeddingForUser(userId, {
      nodeId,
      synthesisVersionId: originalVersionId,
      embed: async () => embedding(),
    });
    const proposalId = await insertSynthesis({
      userId,
      nodeId,
      baseVersionId: originalVersionId,
      content: "New approved Summary",
      status: "pending",
    });

    await expect(approveSynthesisProposalForUser(userId, { nodeId, proposalId }))
      .resolves.toMatchObject({ id: proposalId, status: "approved" });
    expect((await pool.query(`select 1 from node_embeddings where node_id = $1`, [nodeId])).rowCount)
      .toBe(0);

    await expect(refreshApprovedSynthesisEmbeddingForUser(userId, {
      nodeId,
      synthesisVersionId: proposalId,
      embed: async () => {
        throw new OpenAIEmbeddingError("generation-failed");
      },
    })).resolves.toEqual({ status: "failed", reason: "generation-failed" });
    const node = await pool.query<{ published_synthesis_version_id: string }>(
      `select published_synthesis_version_id from nodes where user_id = $1 and id = $2`,
      [userId, nodeId],
    );
    expect(node.rows[0]?.published_synthesis_version_id).toBe(proposalId);
    expect((await pool.query(`select 1 from node_embeddings where node_id = $1`, [nodeId])).rowCount)
      .toBe(0);
  });

  it("invalidates the prior vector for a legacy direct publication update", async () => {
    const userId = await insertUser();
    const nodeId = await insertNode(userId);
    const originalVersionId = await insertSynthesis({
      userId,
      nodeId,
      content: "Original legacy Summary",
      status: "approved",
    });
    await refreshApprovedSynthesisEmbeddingForUser(userId, {
      nodeId,
      synthesisVersionId: originalVersionId,
      embed: async () => embedding(),
    });
    const proposalId = await insertSynthesis({
      userId,
      nodeId,
      baseVersionId: originalVersionId,
      content: "Replacement legacy Summary",
      status: "pending",
    });

    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `update synthesis_versions
         set status = 'approved', decided_at = now(), updated_at = now()
         where user_id = $1 and node_id = $2 and id = $3`,
        [userId, nodeId, proposalId],
      );
      await client.query(
        `update nodes
         set published_synthesis_version_id = $1, updated_at = now()
         where user_id = $2 and id = $3`,
        [proposalId, userId, nodeId],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }

    expect((await pool.query(
      `select 1 from node_embeddings where user_id = $1 and node_id = $2`,
      [userId, nodeId],
    )).rowCount).toBe(0);
    expect((await pool.query<{ published_synthesis_version_id: string }>(
      `select published_synthesis_version_id from nodes where user_id = $1 and id = $2`,
      [userId, nodeId],
    )).rows).toEqual([{ published_synthesis_version_id: proposalId }]);
  });

  it("enforces current approved fixed-profile provenance and cascades with node deletion", async () => {
    const ownerId = await insertUser();
    const foreignOwnerId = await insertUser();
    const nodeId = await insertNode(ownerId);
    const sourceVersionId = await insertSynthesis({
      userId: ownerId,
      nodeId,
      content: "Owned Summary",
      status: "approved",
    });
    const foreignNodeId = await insertNode(foreignOwnerId);
    const foreignVersionId = await insertSynthesis({
      userId: foreignOwnerId,
      nodeId: foreignNodeId,
      content: "Foreign Summary",
      status: "approved",
    });
    const pendingVersionId = await insertSynthesis({
      userId: ownerId,
      nodeId,
      content: "Pending owned Summary",
      status: "pending",
      baseVersionId: sourceVersionId,
    });
    const vectorLiteral = `[${embedding().join(",")}]`;

    await expect(pool.query(
      `insert into node_embeddings
         (user_id, node_id, source_synthesis_version_id, model, dimensions, embedding)
      values ($1, $2, $3, 'text-embedding-3-large', 3072, $4::vector)`,
      [ownerId, nodeId, foreignVersionId, vectorLiteral],
    )).rejects.toMatchObject({
      code: "23514",
      constraint: "node_embeddings_approved_source_check",
    });
    await expect(pool.query(
      `insert into node_embeddings
         (user_id, node_id, source_synthesis_version_id, model, dimensions, embedding)
       values ($1, $2, $3, 'text-embedding-3-large', 3072, $4::vector)`,
      [ownerId, nodeId, pendingVersionId, vectorLiteral],
    )).rejects.toMatchObject({
      code: "23514",
      constraint: "node_embeddings_approved_source_check",
    });
    await expect(pool.query(
      `insert into node_embeddings
         (user_id, node_id, source_synthesis_version_id, model, dimensions, embedding)
       values ($1, $2, $3, 'text-embedding-3-small', 3072, $4::vector)`,
      [ownerId, nodeId, sourceVersionId, vectorLiteral],
    )).rejects.toMatchObject({
      code: "23514",
      constraint: "node_embeddings_profile_check",
    });

    await refreshApprovedSynthesisEmbeddingForUser(ownerId, {
      nodeId,
      synthesisVersionId: sourceVersionId,
      embed: async () => embedding(),
    });
    await pool.query(`delete from node_embeddings where user_id = $1 and node_id = $2`, [
      ownerId,
      nodeId,
    ]);
    const replacementVersionId = await insertSynthesis({
      userId: ownerId,
      nodeId,
      content: "Replacement approved Summary",
      status: "approved",
    });
    await expect(pool.query(
      `insert into node_embeddings
         (user_id, node_id, source_synthesis_version_id, model, dimensions, embedding)
       values ($1, $2, $3, 'text-embedding-3-large', 3072, $4::vector)`,
      [ownerId, nodeId, sourceVersionId, vectorLiteral],
    )).rejects.toMatchObject({
      code: "23503",
      constraint: "node_embeddings_current_owner_fk",
    });
    await refreshApprovedSynthesisEmbeddingForUser(ownerId, {
      nodeId,
      synthesisVersionId: replacementVersionId,
      embed: async () => embedding(),
    });
    await pool.query(`delete from nodes where user_id = $1 and id = $2`, [ownerId, nodeId]);
    expect((await pool.query(`select 1 from node_embeddings where node_id = $1`, [nodeId])).rowCount)
      .toBe(0);
  });
});
