import { randomUUID } from "node:crypto";

import { makeSignature } from "better-auth/crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";

import { AuthorizationError } from "../../src/lib/auth/policy";

const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL or DATABASE_URL_UNPOOLED is required.");
const pool = new Pool({ connectionString });
const authSecret = "synthetic-chat-boundary-secret-at-least-32-chars";
const allowedEmail = "chat-boundary@example.test";
let requestHeaders = new Headers();
let loadChatMessages: typeof import("../../src/app/actions/chat").loadChatMessages;
let postChat: typeof import("../../src/app/api/chat/route").POST;
let deleteChat: typeof import("../../src/app/api/chat/route").DELETE;
let userId = "";
let foreignUserId = "";

vi.mock("next/headers", () => ({ headers: async () => requestHeaders }));

describe("chat authorization boundaries", () => {
  beforeAll(async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", authSecret);
    vi.stubEnv("BETTER_AUTH_URL", "http://127.0.0.1:3188");
    vi.stubEnv("GOOGLE_CLIENT_ID", "synthetic-google-client-id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "synthetic-google-client-secret");
    vi.stubEnv("ALLOWED_EMAIL", allowedEmail);
    vi.stubEnv("MINDTREE_TEST_CHAT_FIXTURE", "1");
    ({ loadChatMessages } = await import("../../src/app/actions/chat"));
    ({ POST: postChat, DELETE: deleteChat } = await import("../../src/app/api/chat/route"));
  });

  afterAll(async () => {
    try {
      if (userId || foreignUserId) {
        await pool.query(`delete from "user" where id = any($1::text[])`, [[userId, foreignUserId].filter(Boolean)]);
      }
      await pool.end();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("authorizes before parsing and returns bounded validation errors after authorization", async () => {
    await expect(loadChatMessages({ nodeId: "invalid", cursor: "" })).rejects.toEqual(
      new AuthorizationError("missing-session"),
    );
    const unauthorized = await postChat(new Request("http://127.0.0.1:3188/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeId: "invalid" }),
    }));
    expect(unauthorized.status).toBe(401);

    userId = `chat-boundary-${randomUUID()}`;
    const token = `chat-boundary-token-${randomUUID()}`;
    await pool.query(
      `insert into "user" (id, name, email, email_verified) values ($1, 'Synthetic Chat Boundary', $2, true)`,
      [userId, allowedEmail],
    );
    await pool.query(
      `insert into "session" (id, user_id, token, expires_at) values ($1, $2, $3, now() + interval '1 hour')`,
      [`chat-boundary-session-${randomUUID()}`, userId, token],
    );
    const signature = await makeSignature(token, authSecret);
    const cookie = `better-auth.session_token=${token}.${signature}`;
    requestHeaders = new Headers({ cookie });

    await expect(loadChatMessages({ nodeId: "invalid", cursor: "" })).resolves.toEqual({
      ok: false,
      message: "Older messages could not be loaded.",
    });
    const invalid = await postChat(new Request("http://127.0.0.1:3188/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ nodeId: "invalid" }),
    }));
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual({ message: "The message is invalid." });

    const oversized = await postChat(new Request("http://127.0.0.1:3188/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": "128001", cookie },
      body: "{}",
    }));
    expect(oversized.status).toBe(413);
    const streamedOversized = await postChat(new Request("http://127.0.0.1:3188/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: "x".repeat(128_001),
    }));
    expect(streamedOversized.status).toBe(413);

    const ownedNodeId = randomUUID();
    await pool.query(
      `insert into nodes (id, user_id, parent_id, position, title)
       values ($1, $2, null, 0, 'Owned chat')`,
      [ownedNodeId, userId],
    );
    const webRequest = await postChat(new Request("http://127.0.0.1:3188/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({
        nodeId: ownedNodeId,
        clientMessageId: randomUUID(),
        content: "Search the web",
        webSearchAuthorized: true,
      }),
    }));
    expect(webRequest.status).toBe(200);
    const webEvents = (await webRequest.text()).trim().split("\n").map((line) =>
      JSON.parse(line) as { type: string; status?: string; assistantMessage?: { citations?: unknown[] } }
    );
    expect(webEvents.some(({ type, status }) =>
      type === "research-status" && status === "searching"
    )).toBe(true);
    expect(webEvents.at(-1)).toMatchObject({
      type: "completed",
      assistantMessage: {
        citations: [{
          kind: "external",
          ordinal: 1,
          title: "Synthetic research source",
          url: "https://example.test/research",
        }],
      },
    });
    const persistedWebRows = await pool.query<{ count: number }>(
      `select count(*)::int as count from chat_messages where user_id = $1 and node_id = $2`,
      [userId, ownedNodeId],
    );
    expect(persistedWebRows.rows[0]?.count).toBe(2);
    const persistedCitations = await pool.query<{ count: number }>(
      `select count(*)::int as count from citations where user_id = $1 and owner_node_id = $2`,
      [userId, ownedNodeId],
    );
    expect(persistedCitations.rows[0]?.count).toBe(1);

    foreignUserId = `foreign-chat-boundary-${randomUUID()}`;
    const foreignNodeId = randomUUID();
    const missingNodeId = randomUUID();
    const clientMessageId = randomUUID();
    await pool.query(
      `insert into "user" (id, name, email, email_verified) values ($1, 'Foreign Chat Boundary', $2, true)`,
      [foreignUserId, `${randomUUID()}@example.test`],
    );
    await pool.query(
      `insert into nodes (id, user_id, parent_id, position, title) values ($1, $2, null, 0, 'Foreign chat')`,
      [foreignNodeId, foreignUserId],
    );
    await pool.query(
      `insert into chat_messages
        (user_id, node_id, client_message_id, sequence, role, status, content, completed_at, failure_code)
       values
        ($1, $2, $3, 0, 'user', 'completed', 'Foreign turn', now(), null),
        ($1, $2, $3, 1, 'assistant', 'failed', '', null, 'generation-failed')`,
      [foreignUserId, foreignNodeId, clientMessageId],
    );
    const mutation = (method: "POST" | "DELETE", nodeId: string) =>
      (method === "POST" ? postChat : deleteChat)(new Request("http://127.0.0.1:3188/api/chat", {
        method,
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({ nodeId, clientMessageId, ...(method === "POST" ? { retry: true } : {}) }),
      }));
    const foreignRetry = await mutation("POST", foreignNodeId);
    const missingRetry = await mutation("POST", missingNodeId);
    expect({ status: foreignRetry.status, body: await foreignRetry.json() }).toEqual({
      status: missingRetry.status,
      body: await missingRetry.json(),
    });
    const foreignDelete = await mutation("DELETE", foreignNodeId);
    const missingDelete = await mutation("DELETE", missingNodeId);
    expect({ status: foreignDelete.status, body: await foreignDelete.json() }).toEqual({
      status: missingDelete.status,
      body: await missingDelete.json(),
    });
    const unchanged = await pool.query<{ status: string }>(
      `select status from chat_messages where user_id = $1 and node_id = $2 and role = 'assistant'`,
      [foreignUserId, foreignNodeId],
    );
    expect(unchanged.rows).toEqual([{ status: "failed" }]);

    vi.stubEnv("MINDTREE_TEST_CHAT_FIXTURE", "0");
    const unavailable = await postChat(new Request("http://127.0.0.1:3188/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ nodeId: randomUUID() }),
    }));
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toEqual({
      message: "Assistant replies are not available yet.",
    });
  });
});
