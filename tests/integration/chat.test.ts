import { randomUUID } from "node:crypto";

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { Pool } from "pg";

import {
  ChatServiceError,
  createChatTurnForUser,
  failChatTurnForUser,
  getChatMessagesForUser,
  retryChatTurnForUser,
} from "../../src/lib/server/chat-service";
import type { FailChatTurnInput } from "../../src/lib/chat/contracts";
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
    const malformedSequenceCursor = Buffer.from(
      JSON.stringify({ sequence: -1 }),
      "utf8",
    ).toString("base64url");
    await expect(
      getChatMessagesForUser(userId, { nodeId, cursor: malformedSequenceCursor }),
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
