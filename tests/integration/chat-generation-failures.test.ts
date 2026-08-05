import { randomUUID } from "node:crypto";

import { makeSignature } from "better-auth/crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";

const runtime = vi.hoisted(() => ({
  invocations: 0,
  scenarios: [] as Array<
    | "disconnect-after-delta"
    | "generic-failure"
    | "provider-refusal"
    | "silent-end"
    | "success"
    | "timeout"
    | "wait-for-abort"
  >,
}));

vi.mock("@/lib/server/chat-runtime", async () => {
  const { OpenAIChatAbortError, OpenAIChatError } = await vi.importActual<
    typeof import("@/lib/server/openai-chat")
  >("@/lib/server/openai-chat");

  return {
    createOpenAISafetyIdentifier: () => "mt_synthetic_failure_test",
    getChatGenerationMode: () => "deterministic-fixture",
    streamChatResponse: (input: { signal: AbortSignal }) => {
      runtime.invocations += 1;
      const scenario = runtime.scenarios.shift();
      return (async function* () {
        if (scenario === "timeout") {
          throw new OpenAIChatError("provider-timeout");
        }
        if (scenario === "generic-failure") {
          throw new Error("synthetic unclassified generation failure");
        }
        if (!scenario) {
          throw new Error("missing synthetic generation scenario");
        }

        const providerResponseId = `resp_${scenario}`;
        yield { type: "started" as const, providerResponseId };
        if (scenario === "provider-refusal") {
          yield { type: "text-delta" as const, content: "Partial refusal prefix." };
          throw new OpenAIChatError("provider-refusal");
        }
        if (scenario === "disconnect-after-delta") {
          yield { type: "text-delta" as const, content: "Partial disconnected prefix." };
          throw new OpenAIChatError("stream-disconnected");
        }
        if (scenario === "silent-end") {
          yield { type: "text-delta" as const, content: "Partial malformed prefix." };
          return;
        }
        if (scenario === "wait-for-abort") {
          yield { type: "text-delta" as const, content: "Partial cancelled prefix." };
          await new Promise<never>((_resolve, reject) => {
            if (input.signal.aborted) {
              reject(new OpenAIChatAbortError());
              return;
            }
            input.signal.addEventListener(
              "abort",
              () => reject(new OpenAIChatAbortError()),
              { once: true },
            );
          });
        }

        yield { type: "text-delta" as const, content: "Synthetic completed response." };
        yield { type: "completed" as const, providerResponseId };
      })();
    },
  };
});

const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL or DATABASE_URL_UNPOOLED is required.");
}

const pool = new Pool({ connectionString });
const authSecret = "synthetic-generation-failure-secret-at-least-32-chars";
const allowedEmail = "chat-generation-failure@example.test";
let postChat: typeof import("../../src/app/api/chat/route").POST;
let userId = "";
let cookie = "";
let nodeId = "";

function post(body: object, signal?: AbortSignal) {
  return postChat(new Request("http://127.0.0.1:3189/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify(body),
    signal,
  }));
}

async function readEvents(response: Response) {
  const text = await response.text();
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function storedTurn(clientMessageId: string) {
  const result = await pool.query<{
    id: string;
    role: "assistant" | "user";
    status: string;
    content: string;
    failure_code: string | null;
    provider_response_id: string | null;
    model: string | null;
    context_fingerprint: string | null;
  }>(
    `select id, role, status, content, failure_code, provider_response_id, model,
            context_fingerprint
     from chat_messages
     where user_id = $1 and node_id = $2 and client_message_id = $3
     order by sequence`,
    [userId, nodeId, clientMessageId],
  );
  return result.rows;
}

describe("chat generation failure boundaries", () => {
  beforeAll(async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", authSecret);
    vi.stubEnv("BETTER_AUTH_URL", "http://127.0.0.1:3189");
    vi.stubEnv("GOOGLE_CLIENT_ID", "synthetic-google-client-id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "synthetic-google-client-secret");
    vi.stubEnv("ALLOWED_EMAIL", allowedEmail);
    ({ POST: postChat } = await import("../../src/app/api/chat/route"));

    userId = `chat-generation-failure-${randomUUID()}`;
    const token = `chat-generation-failure-token-${randomUUID()}`;
    await pool.query(
      `insert into "user" (id, name, email, email_verified)
       values ($1, 'Synthetic Generation Failure', $2, true)`,
      [userId, allowedEmail],
    );
    await pool.query(
      `insert into "session" (id, user_id, token, expires_at)
       values ($1, $2, $3, now() + interval '1 hour')`,
      [`chat-generation-failure-session-${randomUUID()}`, userId, token],
    );
    cookie = `better-auth.session_token=${token}.${await makeSignature(token, authSecret)}`;
  });

  beforeEach(async () => {
    runtime.scenarios.length = 0;
    runtime.invocations = 0;
    await pool.query(`delete from nodes where user_id = $1`, [userId]);
    nodeId = randomUUID();
    await pool.query(
      `insert into nodes (id, user_id, parent_id, position, title)
       values ($1, $2, null, 0, 'Synthetic generation failure node')`,
      [nodeId, userId],
    );
  });

  afterAll(async () => {
    try {
      if (userId) {
        await pool.query(`delete from "user" where id = $1`, [userId]);
      }
      await pool.end();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    ["provider-refusal", "provider-refusal", "Partial refusal prefix."],
    ["timeout", "provider-timeout", ""],
    ["disconnect-after-delta", "stream-disconnected", "Partial disconnected prefix."],
    ["generic-failure", "generation-failed", ""],
    ["silent-end", "response-invalid", "Partial malformed prefix."],
  ] as const)(
    "persists %s as a failed turn without emitting completion",
    async (scenario, failureCode, expectedContent) => {
      runtime.scenarios.push(scenario);
      const clientMessageId = randomUUID();
      const response = await post({
        nodeId,
        clientMessageId,
        content: "Exercise a synthetic provider failure",
        webSearchAuthorized: false,
      });
      const events = await readEvents(response);

      expect(response.status).toBe(200);
      expect(events.map(({ type }) => type)).not.toContain("completed");
      expect(events.at(-1)).toMatchObject({
        type: "failed",
        assistantMessage: { status: "failed", failureCode, content: expectedContent },
      });
      expect(await storedTurn(clientMessageId)).toMatchObject([
        { role: "user", status: "completed" },
        {
          role: "assistant",
          status: "failed",
          failure_code: failureCode,
          content: expectedContent,
        },
      ]);
      expect(runtime.invocations).toBe(1);
    },
  );

  it("retries the same ledger row once, rejects a duplicate retry claim, and replays completion", async () => {
    runtime.scenarios.push("disconnect-after-delta", "success");
    const clientMessageId = randomUUID();
    const createBody = {
      nodeId,
      clientMessageId,
      content: "Retry this synthetic turn",
      webSearchAuthorized: false,
    };
    const firstEvents = await readEvents(await post(createBody));
    expect(firstEvents.at(-1)).toMatchObject({
      type: "failed",
      assistantMessage: {
        status: "failed",
        failureCode: "stream-disconnected",
        content: "Partial disconnected prefix.",
      },
    });
    const failedRows = await storedTurn(clientMessageId);
    const failedAssistantId = failedRows.find(({ role }) => role === "assistant")?.id;

    const retryBody = { nodeId, clientMessageId, retry: true };
    const acceptedRetry = await post(retryBody);
    const duplicateRetry = await post(retryBody);
    expect(duplicateRetry.status).toBe(409);
    await expect(duplicateRetry.json()).resolves.toEqual({
      message: "The message could not be started.",
    });
    const retryEvents = await readEvents(acceptedRetry);
    expect(retryEvents.at(-1)).toMatchObject({
      type: "completed",
      assistantMessage: {
        id: failedAssistantId,
        status: "completed",
        content: "Synthetic completed response.",
        failureCode: null,
        providerResponseId: "resp_success",
      },
    });

    const completedRows = await storedTurn(clientMessageId);
    expect(completedRows).toHaveLength(2);
    expect(completedRows.find(({ role }) => role === "assistant")).toMatchObject({
      id: failedAssistantId,
      status: "completed",
      content: "Synthetic completed response.",
      failure_code: null,
      provider_response_id: "resp_success",
      model: "gpt-5.6-sol",
    });
    expect(completedRows.find(({ role }) => role === "assistant")?.context_fingerprint)
      .toMatch(/^[0-9a-f]{64}$/);
    expect(runtime.invocations).toBe(2);

    const replayEvents = await readEvents(await post(createBody));
    expect(replayEvents.map(({ type }) => type)).toEqual(["turn", "completed"]);
    expect(runtime.invocations).toBe(2);
  });

  it("persists request abortion as cancellation and never completes the turn", async () => {
    runtime.scenarios.push("wait-for-abort");
    const clientMessageId = randomUUID();
    const requestAbortController = new AbortController();
    const response = await post({
      nodeId,
      clientMessageId,
      content: "Cancel this synthetic turn",
      webSearchAuthorized: false,
    }, requestAbortController.signal);

    requestAbortController.abort();
    const events = await readEvents(response);
    expect(events.map(({ type }) => type)).not.toContain("completed");
    expect(events.map(({ type }) => type)).not.toContain("failed");
    expect(await storedTurn(clientMessageId)).toMatchObject([
      { role: "user", status: "completed" },
      {
        role: "assistant",
        status: "cancelled",
        failure_code: null,
      },
    ]);
    expect(runtime.invocations).toBe(1);
  });
});
