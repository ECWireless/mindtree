import { randomUUID } from "node:crypto";

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { Pool } from "pg";

import {
  persistChatTurnContentPrefixForUser,
  cancelChatTurnForUser,
  ChatServiceError,
  completeChatTurnForUser,
  createChatTurnForUser,
  failChatTurnForUser,
  getChatMessagesForUser,
  getChatTurnForUser,
  recordChatTurnContextForUser,
  recordChatTurnProviderResponseForUser,
  retryChatTurnForUser,
  startChatTurnForUser,
} from "../../src/lib/server/chat-service";
import type { FailChatTurnInput } from "../../src/lib/chat/contracts";
import { prepareChatContextForUser } from "../../src/lib/server/chat-context";
import { deleteNodeForUser } from "../../src/lib/server/node-service";

const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL or DATABASE_URL_UNPOOLED is required for integration tests.");
}

const pool = new Pool({ connectionString });
const userIds = new Set<string>();

async function insertUser() {
  const userId = `chat-user-${randomUUID()}`;
  userIds.add(userId);
  await pool.query(
    `insert into "user" (id, name, email, email_verified)
     values ($1, 'Synthetic Chat User', $2, true)`,
    [userId, `${randomUUID()}@example.test`],
  );
  return userId;
}

async function insertNode(userId: string, title = "Chat node", parentId: string | null = null) {
  const positionResult = await pool.query<{ position: number }>(
    `select coalesce(max(position), -1)::int + 1 as position
     from nodes
     where user_id = $1 and parent_id is not distinct from $2`,
    [userId, parentId],
  );
  const nodeId = randomUUID();
  await pool.query(
    `insert into nodes (id, user_id, parent_id, position, title)
     values ($1, $2, $3, $4, $5)`,
    [nodeId, userId, parentId, positionResult.rows[0]?.position ?? 0, title],
  );
  return nodeId;
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

describe("persistent chat ledger", () => {
  it("atomically claims generation and recovers abandoned active turns after the lease", async () => {
    const userId = await insertUser();
    const nodeId = await insertNode(userId);
    const clientMessageId = randomUUID();
    const claimed = await createChatTurnForUser(userId, {
      nodeId,
      clientMessageId,
      content: "Claim this once",
      webSearchAuthorized: false,
    }, { claimAssistant: true });
    expect(claimed).toMatchObject({
      generationClaimed: true,
      assistantMessage: { status: "streaming" },
    });
    const replayed = await createChatTurnForUser(userId, {
      nodeId,
      clientMessageId,
      content: "Claim this once",
      webSearchAuthorized: false,
    }, { claimAssistant: true });
    expect(replayed).toMatchObject({
      replayed: true,
      generationClaimed: false,
      assistantMessage: { status: "streaming" },
    });

    await pool.query(
      `update chat_messages set updated_at = now() - interval '6 minutes'
       where user_id = $1 and node_id = $2 and client_message_id = $3 and role = 'assistant'`,
      [userId, nodeId, clientMessageId],
    );
    const recovered = await getChatMessagesForUser(userId, { nodeId });
    expect(recovered.messages.find((message) => message.role === "assistant")).toMatchObject({
      status: "failed",
      failureCode: "stream-disconnected",
    });
  });

  it("builds and records a bounded deterministic context snapshot for the claimed turn", async () => {
    const userId = await insertUser();
    const rootId = await insertNode(userId, "Context root");
    const nodeId = await insertNode(userId, "Context leaf", rootId);
    const priorClientMessageId = randomUUID();
    await createChatTurnForUser(userId, {
      nodeId,
      clientMessageId: priorClientMessageId,
      content: "Earlier owner message",
      webSearchAuthorized: false,
    }, { claimAssistant: true });
    await persistChatTurnContentPrefixForUser(userId, {
      nodeId,
      clientMessageId: priorClientMessageId,
      contentPrefix: "Earlier assistant response",
    });
    await completeChatTurnForUser(userId, { nodeId, clientMessageId: priorClientMessageId });

    const clientMessageId = randomUUID();
    await createChatTurnForUser(userId, {
      nodeId,
      clientMessageId,
      content: "Current owner request",
      webSearchAuthorized: false,
    }, { claimAssistant: true });

    const prepared = await prepareChatContextForUser(userId, { nodeId, clientMessageId });
    const repeated = await prepareChatContextForUser(userId, { nodeId, clientMessageId });
    expect(prepared.snapshot).toMatchObject({
      version: 1,
      node: {
        id: nodeId,
        title: "Context leaf",
        breadcrumb: {
          items: [
            { id: rootId, title: "Context root" },
            { id: nodeId, title: "Context leaf" },
          ],
          hasOmittedAncestors: false,
        },
        publishedSynthesis: { state: "none" },
      },
      messages: [
        { role: "user", content: "Earlier owner message" },
        { role: "assistant", content: "Earlier assistant response" },
        { role: "user", content: "Current owner request" },
      ],
    });
    expect(prepared.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(repeated.fingerprint).toBe(prepared.fingerprint);
    expect(prepared.input.at(-1)).toEqual({
      role: "user",
      content: "Current owner request",
    });

    await recordChatTurnContextForUser(userId, {
      nodeId,
      clientMessageId,
      model: "gpt-5.6-sol",
      contextFingerprint: prepared.fingerprint,
    });
    await recordChatTurnProviderResponseForUser(userId, {
      nodeId,
      clientMessageId,
      providerResponseId: "resp_synthetic",
    });
    const stored = await pool.query<{
      context_fingerprint: string;
      model: string;
      provider_response_id: string;
    }>(
      `select context_fingerprint, model, provider_response_id
       from chat_messages
       where user_id = $1 and node_id = $2 and client_message_id = $3 and role = 'assistant'`,
      [userId, nodeId, clientMessageId],
    );
    expect(stored.rows).toEqual([{
      context_fingerprint: prepared.fingerprint,
      model: "gpt-5.6-sol",
      provider_response_id: "resp_synthetic",
    }]);
  });

  it("bounds a deep breadcrumb while accounting for omitted ancestors", async () => {
    const userId = await insertUser();
    const nodeIds: string[] = [];
    let parentId: string | null = null;
    for (let depth = 0; depth < 70; depth += 1) {
      parentId = await insertNode(userId, `Context depth ${depth}`, parentId);
      nodeIds.push(parentId);
    }
    const nodeId = nodeIds.at(-1)!;
    const clientMessageId = randomUUID();
    await createChatTurnForUser(userId, {
      nodeId,
      clientMessageId,
      content: "Use bounded ancestors",
      webSearchAuthorized: false,
    }, { claimAssistant: true });

    const prepared = await prepareChatContextForUser(userId, { nodeId, clientMessageId });

    expect(prepared.snapshot.node.breadcrumb.items).toHaveLength(64);
    expect(prepared.snapshot.node.breadcrumb.items[0]).toEqual({
      id: nodeIds[6],
      title: "Context depth 6",
    });
    expect(prepared.snapshot.node.breadcrumb.items.at(-1)).toEqual({
      id: nodeId,
      title: "Context depth 69",
    });
    expect(prepared.snapshot.node.breadcrumb.hasOmittedAncestors).toBe(true);
  });

  it("persists bounded streaming, completion, cancellation, and retry transitions", async () => {
    const userId = await insertUser();
    const nodeId = await insertNode(userId);
    const completedClientMessageId = randomUUID();
    await createChatTurnForUser(userId, {
      nodeId,
      clientMessageId: completedClientMessageId,
      content: "Complete this",
      webSearchAuthorized: false,
    });
    await startChatTurnForUser(userId, { nodeId, clientMessageId: completedClientMessageId });
    await expect(
      startChatTurnForUser(userId, { nodeId, clientMessageId: completedClientMessageId }),
    ).rejects.toEqual(new ChatServiceError("retry-unavailable"));
    await persistChatTurnContentPrefixForUser(userId, {
      nodeId,
      clientMessageId: completedClientMessageId,
      contentPrefix: "A partial ",
    });
    await persistChatTurnContentPrefixForUser(userId, {
      nodeId,
      clientMessageId: completedClientMessageId,
      contentPrefix: "A partial ",
    });
    await persistChatTurnContentPrefixForUser(userId, {
      nodeId,
      clientMessageId: completedClientMessageId,
      contentPrefix: "A partial answer.",
    });
    await expect(persistChatTurnContentPrefixForUser(userId, {
      nodeId,
      clientMessageId: completedClientMessageId,
      contentPrefix: "A divergent response.",
    })).rejects.toEqual(new ChatServiceError("retry-unavailable"));
    const afterDivergentPrefix = await getChatTurnForUser(userId, {
      nodeId,
      clientMessageId: completedClientMessageId,
    });
    expect(
      afterDivergentPrefix.find((message) => message.role === "assistant")?.content,
    ).toBe("A partial answer.");
    await persistChatTurnContentPrefixForUser(userId, {
      nodeId,
      clientMessageId: completedClientMessageId,
      contentPrefix: "A partial ",
    });
    const completed = await completeChatTurnForUser(userId, {
      nodeId,
      clientMessageId: completedClientMessageId,
    });
    expect(completed).toMatchObject({ status: "completed", content: "A partial answer." });
    expect(completed.completedAt).not.toBeNull();

    const cancelledClientMessageId = randomUUID();
    await createChatTurnForUser(userId, {
      nodeId,
      clientMessageId: cancelledClientMessageId,
      content: "Stop this",
      webSearchAuthorized: false,
    });
    await startChatTurnForUser(userId, { nodeId, clientMessageId: cancelledClientMessageId });
    const cancelled = await cancelChatTurnForUser(userId, {
      nodeId,
      clientMessageId: cancelledClientMessageId,
    });
    expect(cancelled).toMatchObject({ status: "cancelled", content: "" });
    const retriedCancelled = await retryChatTurnForUser(userId, {
      nodeId,
      clientMessageId: cancelledClientMessageId,
    });
    expect(retriedCancelled.assistantMessage).toMatchObject({ status: "pending" });

    const failedClientMessageId = randomUUID();
    await createChatTurnForUser(userId, {
      nodeId,
      clientMessageId: failedClientMessageId,
      content: "Retry this",
      webSearchAuthorized: false,
    });
    await startChatTurnForUser(userId, { nodeId, clientMessageId: failedClientMessageId });
    await failChatTurnForUser(userId, {
      nodeId,
      clientMessageId: failedClientMessageId,
      failureCode: "generation-failed",
    });
    const retried = await retryChatTurnForUser(userId, {
      nodeId,
      clientMessageId: failedClientMessageId,
    });
    expect(retried.assistantMessage).toMatchObject({ status: "pending", content: "", failureCode: null });
  });

  it("creates one replay-safe user and assistant row per client message", async () => {
    const userId = await insertUser();
    const nodeId = await insertNode(userId);
    const clientMessageId = randomUUID();
    const input = {
      nodeId,
      clientMessageId,
      content: "Develop the core idea.",
      webSearchAuthorized: true,
    };

    const created = await createChatTurnForUser(userId, input);
    const replayed = await createChatTurnForUser(userId, input);

    expect(created).toMatchObject({
      replayed: false,
      userMessage: {
        role: "user",
        status: "completed",
        content: input.content,
        webSearchAuthorized: true,
      },
      assistantMessage: {
        role: "assistant",
        status: "pending",
        content: "",
        webSearchAuthorized: false,
      },
    });
    expect(replayed).toMatchObject({
      replayed: true,
      userMessage: { id: created.userMessage.id },
      assistantMessage: { id: created.assistantMessage.id },
    });
    const stored = await pool.query<{ count: number }>(
      `select count(*)::int as count
       from chat_messages
       where user_id = $1 and node_id = $2 and client_message_id = $3`,
      [userId, nodeId, clientMessageId],
    );
    expect(stored.rows[0]?.count).toBe(2);

    await expect(
      createChatTurnForUser(userId, { ...input, content: "Different replay content" }),
    ).rejects.toEqual(new ChatServiceError("turn-conflict"));
  });

  it("does not distinguish foreign nodes from missing nodes", async () => {
    const userId = await insertUser();
    const otherUserId = await insertUser();
    const foreignNodeId = await insertNode(otherUserId, "Foreign chat node");
    const missingNodeId = randomUUID();
    const clientMessageId = randomUUID();

    await expect(
      createChatTurnForUser(userId, {
        nodeId: foreignNodeId,
        clientMessageId,
        content: "Private?",
        webSearchAuthorized: false,
      }),
    ).rejects.toEqual(new ChatServiceError("node-not-found"));
    await expect(
      createChatTurnForUser(userId, {
        nodeId: missingNodeId,
        clientMessageId,
        content: "Missing?",
        webSearchAuthorized: false,
      }),
    ).rejects.toEqual(new ChatServiceError("node-not-found"));
    await expect(getChatMessagesForUser(userId, { nodeId: foreignNodeId })).rejects.toEqual(
      new ChatServiceError("node-not-found"),
    );
    await expect(getChatMessagesForUser(userId, { nodeId: missingNodeId })).rejects.toEqual(
      new ChatServiceError("node-not-found"),
    );
    await expect(
      getChatTurnForUser(userId, { nodeId: foreignNodeId, clientMessageId }),
    ).rejects.toEqual(new ChatServiceError("node-not-found"));
    await expect(
      getChatTurnForUser(userId, { nodeId: missingNodeId, clientMessageId }),
    ).rejects.toEqual(new ChatServiceError("node-not-found"));
  });

  it("paginates one node in stable order without mixing another conversation", async () => {
    const userId = await insertUser();
    const nodeId = await insertNode(userId, "Paginated chat");
    const otherNodeId = await insertNode(userId, "Other chat");
    for (const content of ["First", "Second", "Third"]) {
      await createChatTurnForUser(userId, {
        nodeId,
        clientMessageId: randomUUID(),
        content,
        webSearchAuthorized: false,
      });
    }
    await pool.query(
      `update chat_messages set created_at = '2026-08-04T00:00:00.000Z'
       where user_id = $1 and node_id = $2`,
      [userId, nodeId],
    );
    await createChatTurnForUser(userId, {
      nodeId: otherNodeId,
      clientMessageId: randomUUID(),
      content: "Other node message",
      webSearchAuthorized: false,
    });

    const firstPage = await getChatMessagesForUser(userId, { nodeId, limit: 2 });
    const secondPage = await getChatMessagesForUser(userId, {
      nodeId,
      limit: 2,
      cursor: firstPage.nextCursor ?? undefined,
    });
    const thirdPage = await getChatMessagesForUser(userId, {
      nodeId,
      limit: 2,
      cursor: secondPage.nextCursor ?? undefined,
    });
    const messages = [
      ...thirdPage.messages,
      ...secondPage.messages,
      ...firstPage.messages,
    ];

    expect(firstPage.nextCursor).not.toBeNull();
    expect(secondPage.nextCursor).not.toBeNull();
    expect(thirdPage.nextCursor).toBeNull();
    expect(new Set(messages.map(({ id }) => id)).size).toBe(6);
    expect(messages.filter(({ role }) => role === "user").map(({ content }) => content)).toEqual([
      "First",
      "Second",
      "Third",
    ]);
    expect(messages.every((message) => message.nodeId === nodeId)).toBe(true);
    await expect(
      getChatMessagesForUser(userId, { nodeId, cursor: "not-a-cursor" }),
    ).rejects.toEqual(new ChatServiceError("invalid-cursor"));
    const validCursor = firstPage.nextCursor;
    expect(validCursor).not.toBeNull();
    await expect(
      getChatMessagesForUser(userId, { nodeId, cursor: `${validCursor}$` }),
    ).rejects.toEqual(new ChatServiceError("invalid-cursor"));
    await expect(
      getChatMessagesForUser(userId, { nodeId, cursor: `${validCursor}===` }),
    ).rejects.toEqual(new ChatServiceError("invalid-cursor"));
    const malformedSequenceCursor = Buffer.from(
      JSON.stringify({ sequence: -1 }),
      "utf8",
    ).toString("base64url");
    await expect(
      getChatMessagesForUser(userId, { nodeId, cursor: malformedSequenceCursor }),
    ).rejects.toEqual(new ChatServiceError("invalid-cursor"));
    const outOfRangeSequenceCursor = Buffer.from(
      JSON.stringify({ sequence: "9223372036854775808" }),
      "utf8",
    ).toString("base64url");
    await expect(
      getChatMessagesForUser(userId, { nodeId, cursor: outOfRangeSequenceCursor }),
    ).rejects.toEqual(new ChatServiceError("invalid-cursor"));
    await expect(
      getChatMessagesForUser(userId, { nodeId, cursor: "x".repeat(129) }),
    ).rejects.toEqual(new ChatServiceError("invalid-cursor"));
  });

  it("allocates adjacent per-node sequence values across concurrent turns", async () => {
    const userId = await insertUser();
    const nodeId = await insertNode(userId, "Concurrent chat");

    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        createChatTurnForUser(userId, {
          nodeId,
          clientMessageId: randomUUID(),
          content: `Concurrent ${index}`,
          webSearchAuthorized: false,
        }),
      ),
    );

    const stored = await pool.query<{
      client_message_id: string;
      role: "assistant" | "user";
      sequence: string;
    }>(
      `select client_message_id, role, sequence::text
       from chat_messages
       where user_id = $1 and node_id = $2
       order by chat_messages.sequence`,
      [userId, nodeId],
    );
    expect(stored.rows.map(({ sequence }) => Number(sequence))).toEqual(
      Array.from({ length: 16 }, (_, index) => index),
    );
    for (let index = 0; index < stored.rows.length; index += 2) {
      expect(stored.rows[index]?.role).toBe("user");
      expect(stored.rows[index + 1]?.role).toBe("assistant");
      expect(stored.rows[index]?.client_message_id).toBe(
        stored.rows[index + 1]?.client_message_id,
      );
    }
  });

  it("preserves pagination and allocation above the safe integer range", async () => {
    const userId = await insertUser();
    const nodeId = await insertNode(userId, "High sequence chat");
    const existingClientMessageId = randomUUID();
    const createdAt = new Date();
    await pool.query(
      `insert into chat_messages
         (user_id, node_id, client_message_id, sequence, role, status, content,
          web_search_authorized, created_at, updated_at, completed_at)
       values
         ($1, $2, $3, $4, 'user', 'completed', 'High user message', false, $6, $6, $6),
         ($1, $2, $3, $5, 'assistant', 'completed', 'High assistant message', false, $6, $6, $6)`,
      [
        userId,
        nodeId,
        existingClientMessageId,
        "9007199254740992",
        "9007199254740993",
        createdAt,
      ],
    );

    const firstPage = await getChatMessagesForUser(userId, { nodeId, limit: 1 });
    expect(firstPage.messages).toMatchObject([
      { role: "assistant", content: "High assistant message" },
    ]);
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = await getChatMessagesForUser(userId, {
      nodeId,
      limit: 1,
      cursor: firstPage.nextCursor ?? undefined,
    });
    expect(secondPage.messages).toMatchObject([
      { role: "user", content: "High user message" },
    ]);

    const nextClientMessageId = randomUUID();
    await createChatTurnForUser(userId, {
      nodeId,
      clientMessageId: nextClientMessageId,
      content: "Continue exactly",
      webSearchAuthorized: false,
    });
    const stored = await pool.query<{ sequence: string }>(
      `select sequence::text
       from chat_messages
       where user_id = $1 and node_id = $2 and client_message_id = $3
       order by sequence`,
      [userId, nodeId, nextClientMessageId],
    );
    expect(stored.rows.map(({ sequence }) => sequence)).toEqual([
      "9007199254740994",
      "9007199254740995",
    ]);
  });

  it("retries a failed assistant placeholder without duplicating the user turn", async () => {
    const userId = await insertUser();
    const nodeId = await insertNode(userId);
    const clientMessageId = randomUUID();
    const created = await createChatTurnForUser(userId, {
      nodeId,
      clientMessageId,
      content: "Please try this once.",
      webSearchAuthorized: false,
    });

    const failed = await failChatTurnForUser(userId, {
      nodeId,
      clientMessageId,
      failureCode: "provider-timeout",
    });
    expect(failed).toMatchObject({
      id: created.assistantMessage.id,
      status: "failed",
      failureCode: "provider-timeout",
    });

    const retried = await retryChatTurnForUser(userId, { nodeId, clientMessageId });
    expect(retried).toMatchObject({
      userMessage: { id: created.userMessage.id, content: "Please try this once." },
      assistantMessage: {
        id: created.assistantMessage.id,
        status: "pending",
        content: "",
        failureCode: null,
      },
    });
    await expect(retryChatTurnForUser(userId, { nodeId, clientMessageId })).rejects.toEqual(
      new ChatServiceError("retry-unavailable"),
    );
    await expect(
      failChatTurnForUser(userId, {
        nodeId,
        clientMessageId,
        failureCode: "provider-request-id",
      } as unknown as FailChatTurnInput),
    ).rejects.toEqual(new ChatServiceError("invalid-failure-code"));
    const stored = await pool.query<{ count: number }>(
      `select count(*)::int as count
       from chat_messages
       where user_id = $1 and node_id = $2 and client_message_id = $3`,
      [userId, nodeId, clientMessageId],
    );
    expect(stored.rows[0]?.count).toBe(2);
  });

  it("cascades every conversation row with confirmed subtree deletion", async () => {
    const userId = await insertUser();
    const rootId = await insertNode(userId, "Doomed root");
    const childId = await insertNode(userId, "Doomed child", rootId);
    for (const nodeId of [rootId, childId]) {
      await createChatTurnForUser(userId, {
        nodeId,
        clientMessageId: randomUUID(),
        content: `Message for ${nodeId}`,
        webSearchAuthorized: false,
      });
    }

    await deleteNodeForUser(userId, { id: rootId });

    const remaining = await pool.query<{ count: number }>(
      `select count(*)::int as count from chat_messages where user_id = $1`,
      [userId],
    );
    expect(remaining.rows[0]?.count).toBe(0);
  });
});
