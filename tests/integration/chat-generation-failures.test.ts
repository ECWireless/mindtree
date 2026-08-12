import { randomUUID } from "node:crypto";

import { makeSignature } from "better-auth/crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";

const runtime = vi.hoisted(() => ({
  invocations: 0,
  generationMode: "deterministic-fixture" as "deterministic-fixture" | "openai",
  pdfFetchFailure: false,
  pdfFetchInvocations: [] as Array<{ alias: string; title: string; url: string }>,
  externalPdfSources: [] as Array<null | {
    alias: string;
    fileData: string;
    filename: string;
    title: string;
    url: string;
  }>,
  beforeRouteComplete: null as null | (() => Promise<void>),
  scenarios: [] as Array<
    | "disconnect-after-delta"
    | "generic-failure"
    | "provider-refusal"
    | "proposal-success"
    | "route-synthesis"
    | "route-synthesis-at-content-limit"
    | "silent-end"
    | "success"
    | "timeout"
    | "wait-for-abort"
    | "web-provider-refusal"
    | "web-wait-for-abort"
    | "web-success"
    | "web-timeout"
  >,
}));

vi.mock("@/lib/server/external-pdf-source", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/external-pdf-source")>(
    "@/lib/server/external-pdf-source",
  );
  return {
    ...actual,
    fetchAuthorizedExternalPdf: async (source: {
      alias: "W1";
      title: string;
      url: string;
    }) => {
      runtime.pdfFetchInvocations.push(source);
      if (runtime.pdfFetchFailure) {
        throw new Error("synthetic secure PDF fetch failure");
      }
      return {
        ...source,
        fileData: "data:application/pdf;base64,JVBERi0xLjQK",
        filename: source.title,
      };
    },
  };
});

vi.mock("@/lib/server/chat-stream", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/chat-stream")>(
    "@/lib/server/chat-stream",
  );
  return {
    ...actual,
    scheduleChatStreamHeartbeats: (
      emit: Parameters<typeof actual.scheduleChatStreamHeartbeats>[0],
    ) => actual.scheduleChatStreamHeartbeats(
      emit,
      runtime.scenarios[0] === "web-wait-for-abort"
        ? 10
        : actual.CHAT_STREAM_HEARTBEAT_MS,
    ),
  };
});

vi.mock("@/lib/server/chat-runtime", async () => {
  const { OpenAIChatAbortError, OpenAIChatError } = await vi.importActual<
    typeof import("@/lib/server/openai-chat")
  >("@/lib/server/openai-chat");

  return {
    createOpenAISafetyIdentifier: () => "mt_synthetic_failure_test",
    getChatGenerationMode: () => runtime.generationMode,
    streamChatResponse: (input: {
      phase: "conversation" | "synthesis";
      signal: AbortSignal;
      webSearchAuthorized?: boolean;
      externalPdfSource?: null | {
        alias: string;
        fileData: string;
        filename: string;
        title: string;
        url: string;
      };
    }) => {
      runtime.invocations += 1;
      runtime.externalPdfSources.push(input.externalPdfSource ?? null);
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
        if (scenario.startsWith("web-")) {
          if (input.phase !== "conversation" || input.webSearchAuthorized !== true) {
            throw new Error("unexpected web research profile");
          }
          yield { type: "research-status" as const, status: "searching" as const };
          if (scenario === "web-provider-refusal") {
            throw new OpenAIChatError("provider-refusal");
          }
          if (scenario === "web-timeout") {
            throw new OpenAIChatError("provider-timeout");
          }
          if (scenario === "web-wait-for-abort") {
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
          const content = "A completed synthetic research claim.";
          yield { type: "text-delta" as const, content };
          yield {
            type: "completed" as const,
            providerResponseId,
            synthesisRequested: false,
            proposal: null,
            externalCitations: [{
              kind: "external" as const,
              ordinal: 1,
              startUtf16: content.length,
              endUtf16: content.length,
              title: input.externalPdfSource?.title ?? "Synthetic retry source",
              url: input.externalPdfSource?.url ?? "https://example.test/retry-source",
            }],
          };
          return;
        }
        if (
          scenario === "route-synthesis" ||
          scenario === "route-synthesis-at-content-limit"
        ) {
          if (input.phase !== "conversation") throw new Error("unexpected routing phase");
          if (scenario === "route-synthesis-at-content-limit") {
            yield { type: "text-delta" as const, content: "x".repeat(64_000) };
          }
          await runtime.beforeRouteComplete?.();
          yield {
            type: "completed" as const,
            providerResponseId,
            synthesisRequested: true,
            proposal: null,
          };
          return;
        }
        if (scenario === "proposal-success" && input.phase !== "synthesis") {
          throw new Error("unexpected proposal phase");
        }
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
        yield {
          type: "completed" as const,
          providerResponseId,
          synthesisRequested: false,
          proposal: scenario === "proposal-success"
            ? {
                content: "# Synthetic proposal\n\nA bounded synthesis draft.",
                citations: [],
              }
            : null,
        };
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
let deleteChat: typeof import("../../src/app/api/chat/route").DELETE;
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

function stop(body: object) {
  return deleteChat(new Request("http://127.0.0.1:3189/api/chat", {
    method: "DELETE",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify(body),
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
    web_search_authorized: boolean;
  }>(
    `select id, role, status, content, failure_code, provider_response_id, model,
            context_fingerprint, web_search_authorized
     from chat_messages
     where user_id = $1 and node_id = $2 and client_message_id = $3
     order by sequence`,
    [userId, nodeId, clientMessageId],
  );
  return result.rows;
}

async function installBranchOutline(stale = false) {
  const outlineId = randomUUID();
  await pool.query(
    `insert into branch_outline_versions
       (id, user_id, node_id, client_request_id, status, content, model,
        reasoning_mode, reasoning_effort, input_fingerprint, completed_at)
     values ($1, $2, $3, $4, 'completed', '# Branch Outline\n\nSynthetic recursive context',
       'gpt-5.6-sol', 'pro', 'high', $5, now())`,
    [outlineId, userId, nodeId, randomUUID(), "d".repeat(64)],
  );
  await pool.query(
    `update nodes
     set current_branch_outline_version_id = $1,
         branch_outline_stale_at = case when $2 then now() else null end,
         branch_outline_stale_reason = case when $2 then 'branch-content-changed' else null end
     where user_id = $3 and id = $4`,
    [outlineId, stale, userId, nodeId],
  );
  return outlineId;
}

async function createPendingProposalViaRoute() {
  runtime.scenarios.push("route-synthesis", "proposal-success");
  const clientMessageId = randomUUID();
  const events = await readEvents(await post({
    nodeId,
    clientMessageId,
    content: "Create a pending synthesis for refinement",
    webSearchAuthorized: false,
  }));
  expect(events.at(-1)).toMatchObject({ type: "completed" });
  const proposal = await pool.query<{ id: string }>(
    `select id from synthesis_versions
     where user_id = $1 and node_id = $2 and status = 'pending'`,
    [userId, nodeId],
  );
  expect(proposal.rows).toHaveLength(1);
  return proposal.rows[0]!.id;
}

describe("chat generation failure boundaries", () => {
  beforeAll(async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", authSecret);
    vi.stubEnv("BETTER_AUTH_URL", "http://127.0.0.1:3189");
    vi.stubEnv("GOOGLE_CLIENT_ID", "synthetic-google-client-id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "synthetic-google-client-secret");
    vi.stubEnv("ALLOWED_EMAIL", allowedEmail);
    ({ DELETE: deleteChat, POST: postChat } = await import("../../src/app/api/chat/route"));

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
    runtime.generationMode = "deterministic-fixture";
    runtime.pdfFetchFailure = false;
    runtime.pdfFetchInvocations.length = 0;
    runtime.externalPdfSources.length = 0;
    runtime.beforeRouteComplete = null;
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

  it.each([
    ["web-provider-refusal", "provider-refusal"],
    ["web-timeout", "provider-timeout"],
  ] as const)(
    "fails closed for %s without persisting buffered research or citations",
    async (scenario, failureCode) => {
      runtime.scenarios.push(scenario);
      const clientMessageId = randomUUID();
      const events = await readEvents(await post({
        nodeId,
        clientMessageId,
        content: "Research a synthetic failure",
        webSearchAuthorized: true,
      }));

      expect(events.map(({ type }) => type)).toEqual([
        "turn",
        "research-status",
        "failed",
      ]);
      expect(events.at(-1)).toMatchObject({
        type: "failed",
        assistantMessage: { status: "failed", failureCode, content: "" },
      });
      expect(await storedTurn(clientMessageId)).toMatchObject([
        { role: "user", web_search_authorized: true },
        { role: "assistant", status: "failed", content: "" },
      ]);
      const citationCount = await pool.query<{ count: number }>(
        `select count(*)::int as count from citations
         where user_id = $1 and owner_node_id = $2`,
        [userId, nodeId],
      );
      const proposalCount = await pool.query<{ count: number }>(
        `select count(*)::int as count from synthesis_versions
         where user_id = $1 and node_id = $2`,
        [userId, nodeId],
      );
      expect(citationCount.rows).toEqual([{ count: 0 }]);
      expect(proposalCount.rows).toEqual([{ count: 0 }]);
    },
  );

  it("retries failed web research on the same ledger row with its original authorization", async () => {
    runtime.scenarios.push("web-provider-refusal", "web-success");
    const clientMessageId = randomUUID();
    const createBody = {
      nodeId,
      clientMessageId,
      content: "Research a synthetic retry",
      webSearchAuthorized: true,
    };
    const failedEvents = await readEvents(await post(createBody));
    const failedAssistant = (await storedTurn(clientMessageId))
      .find(({ role }) => role === "assistant");
    expect(failedEvents.at(-1)).toMatchObject({
      type: "failed",
      assistantMessage: { id: failedAssistant?.id, failureCode: "provider-refusal" },
    });

    const retriedEvents = await readEvents(await post({
      nodeId,
      clientMessageId,
      retry: true,
    }));
    expect(retriedEvents.map(({ type }) => type)).toEqual([
      "turn",
      "research-status",
      "delta",
      "completed",
    ]);
    expect(retriedEvents.at(-1)).toMatchObject({
      type: "completed",
      proposalCreated: false,
      assistantMessage: {
        id: failedAssistant?.id,
        status: "completed",
        content: "A completed synthetic research claim.",
        citations: [{
          kind: "external",
          ordinal: 1,
          title: "Synthetic retry source",
          url: "https://example.test/retry-source",
        }],
      },
    });
    expect(await storedTurn(clientMessageId)).toMatchObject([
      { role: "user", web_search_authorized: true },
      {
        id: failedAssistant?.id,
        role: "assistant",
        status: "completed",
        failure_code: null,
      },
    ]);
    const citations = await pool.query<{
      assistant_message_id: string;
      title: string;
      url: string;
    }>(
      `select assistant_message_id, external_title as title, external_url as url
       from citations where user_id = $1 and owner_node_id = $2`,
      [userId, nodeId],
    );
    expect(citations.rows).toEqual([{
      assistant_message_id: failedAssistant?.id,
      title: "Synthetic retry source",
      url: "https://example.test/retry-source",
    }]);
    expect(runtime.invocations).toBe(2);

    const replayed = await readEvents(await post(createBody));
    expect(replayed.map(({ type }) => type)).toEqual(["turn", "completed"]);
    expect(runtime.invocations).toBe(2);
  });

  it("passes only the explicitly supplied current-turn PDF to the provider and persists its provenance", async () => {
    runtime.generationMode = "openai";
    runtime.scenarios.push("web-success");
    const clientMessageId = randomUUID();
    const url = "https://example.test/papers/rosenblatt-1957.pdf";
    const events = await readEvents(await post({
      nodeId,
      clientMessageId,
      content: `Give me one short supported claim from ${url}`,
      webSearchAuthorized: true,
    }));

    expect(runtime.externalPdfSources).toEqual([{
      alias: "W1",
      fileData: "data:application/pdf;base64,JVBERi0xLjQK",
      filename: "rosenblatt-1957.pdf",
      title: "rosenblatt-1957.pdf",
      url,
    }]);
    expect(runtime.pdfFetchInvocations).toEqual([{
      alias: "W1",
      title: "rosenblatt-1957.pdf",
      url,
    }]);
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      assistantMessage: {
        citations: [{ title: "rosenblatt-1957.pdf", url }],
      },
    });
  });

  it("fails an invalid direct PDF before incurring provider cost", async () => {
    const clientMessageId = randomUUID();
    const events = await readEvents(await post({
      nodeId,
      clientMessageId,
      content: "Read http://example.test/private.pdf",
      webSearchAuthorized: true,
    }));

    expect(events.at(-1)).toMatchObject({
      type: "failed",
      assistantMessage: { failureCode: "response-invalid" },
    });
    expect(runtime.invocations).toBe(0);
    expect(runtime.externalPdfSources).toEqual([]);
  });

  it("fails a direct PDF that cannot be fetched safely before incurring provider cost", async () => {
    runtime.generationMode = "openai";
    runtime.pdfFetchFailure = true;
    const clientMessageId = randomUUID();
    const url = "https://example.test/private-after-resolution.pdf";
    const events = await readEvents(await post({
      nodeId,
      clientMessageId,
      content: `Read ${url}`,
      webSearchAuthorized: true,
    }));

    expect(events.at(-1)).toMatchObject({
      type: "failed",
      assistantMessage: { failureCode: "response-invalid" },
    });
    expect(runtime.pdfFetchInvocations).toEqual([{
      alias: "W1",
      title: "private-after-resolution.pdf",
      url,
    }]);
    expect(runtime.invocations).toBe(0);
    expect(runtime.externalPdfSources).toEqual([]);
  });

  it("persists a requested synthesis proposal without publishing it", async () => {
    const outlineId = await installBranchOutline();
    runtime.scenarios.push("route-synthesis", "proposal-success");
    const clientMessageId = randomUUID();
    const createBody = {
      nodeId,
      clientMessageId,
      content: "Propose a synthesis from the supplied context",
      webSearchAuthorized: false,
    };
    const events = await readEvents(await post(createBody));

    expect(events.at(-1)).toMatchObject({
      type: "completed",
      assistantMessage: { status: "completed" },
    });

    const proposalResult = await pool.query<{
      id: string;
      base_version_id: string | null;
      content: string;
      generating_message_id: string;
      reasoning_effort: string;
      reasoning_mode: string;
      status: string;
    }>(
      `select id, base_version_id, content, generating_message_id, reasoning_effort,
              reasoning_mode, status
       from synthesis_versions
       where user_id = $1 and node_id = $2`,
      [userId, nodeId],
    );
    const pointerResult = await pool.query<{ published_synthesis_version_id: string | null }>(
      `select published_synthesis_version_id
       from nodes
       where user_id = $1 and id = $2`,
      [userId, nodeId],
    );
    const assistantId = (await storedTurn(clientMessageId))
      .find(({ role }) => role === "assistant")?.id;
    expect((await storedTurn(clientMessageId)).find(({ role }) => role === "assistant"))
      .toMatchObject({ provider_response_id: "resp_proposal-success" });

    expect(proposalResult.rows).toEqual([{
      id: expect.any(String),
      base_version_id: null,
      content: "# Synthetic proposal\n\nA bounded synthesis draft.",
      generating_message_id: assistantId,
      reasoning_effort: "high",
      reasoning_mode: "pro",
      status: "pending",
    }]);
    expect(pointerResult.rows).toEqual([{ published_synthesis_version_id: null }]);
    const recordedInputs = await pool.query<{
      source_branch_outline_version_id: string | null;
      relation: string;
      position: number;
    }>(
      `select source_branch_outline_version_id, relation, position
       from synthesis_inputs where synthesis_version_id = $1`,
      [proposalResult.rows[0]!.id],
    );
    expect(recordedInputs.rows).toEqual([{
      source_branch_outline_version_id: outlineId,
      relation: "outline",
      position: 0,
    }]);
    expect(runtime.invocations).toBe(2);

    const replayEvents = await readEvents(await post(createBody));
    expect(replayEvents.map(({ type }) => type)).toEqual(["turn", "completed"]);
    expect(replayEvents.at(-1)).toMatchObject({ proposalCreated: true });
    expect(runtime.invocations).toBe(2);

    const originalProposalId = proposalResult.rows[0]!.id;
    runtime.scenarios.push("route-synthesis", "proposal-success");
    const refinementClientMessageId = randomUUID();
    const refinementEvents = await readEvents(await post({
      nodeId,
      clientMessageId: refinementClientMessageId,
      content: "Refine the exact pending synthesis",
      webSearchAuthorized: false,
    }));
    expect(refinementEvents.at(-1)).toMatchObject({ type: "completed" });

    const versions = await pool.query<{
      id: string;
      status: string;
      decided_at: Date | null;
    }>(
      `select id, status, decided_at
       from synthesis_versions where user_id = $1 and node_id = $2 order by created_at`,
      [userId, nodeId],
    );
    expect(versions.rows).toHaveLength(2);
    expect(versions.rows.find(({ id }) => id === originalProposalId)).toMatchObject({
      status: "superseded",
      decided_at: expect.any(Date),
    });
    expect(versions.rows.find(({ status }) => status === "pending")).toBeDefined();
    const refinementIntent = await pool.query<{ refinement_proposal_id: string | null }>(
      `select refinement_proposal_id from chat_messages
       where user_id = $1 and node_id = $2 and client_message_id = $3 and role = 'user'`,
      [userId, nodeId, refinementClientMessageId],
    );
    expect(refinementIntent.rows).toEqual([{
      refinement_proposal_id: originalProposalId,
    }]);
    expect(runtime.invocations).toBe(4);
  });

  it("keeps a stale Branch Outline available for discussion but blocks Summary generation", async () => {
    await installBranchOutline(true);
    runtime.scenarios.push("route-synthesis");
    const clientMessageId = randomUUID();
    const events = await readEvents(await post({
      nodeId,
      clientMessageId,
      content: "Create a new Summary using this branch",
      webSearchAuthorized: false,
    }));

    expect(events.at(-1)).toMatchObject({
      type: "completed",
      proposalCreated: false,
      assistantMessage: {
        status: "completed",
        content: expect.stringContaining("Regenerate the stale Branch Outline"),
      },
    });
    expect(runtime.invocations).toBe(1);
    expect(runtime.scenarios).toHaveLength(0);
    const proposals = await pool.query<{ count: number }>(
      `select count(*)::int as count from synthesis_versions
       where user_id = $1 and node_id = $2`,
      [userId, nodeId],
    );
    expect(proposals.rows).toEqual([{ count: 0 }]);

    const replay = await readEvents(await post({
      nodeId,
      clientMessageId,
      content: "Create a new Summary using this branch",
      webSearchAuthorized: false,
    }));
    expect(replay.at(-1)).toMatchObject({
      type: "completed",
      proposalCreated: false,
    });
    expect(runtime.invocations).toBe(1);
  });

  it("rechecks a current outline after routing and avoids an obsolete synthesis call", async () => {
    await installBranchOutline();
    runtime.beforeRouteComplete = async () => {
      await pool.query(
        `update nodes
         set branch_outline_stale_at = now(),
             branch_outline_stale_reason = 'branch-content-changed'
         where user_id = $1 and id = $2`,
        [userId, nodeId],
      );
      runtime.beforeRouteComplete = null;
    };
    runtime.scenarios.push("route-synthesis");
    const clientMessageId = randomUUID();
    const events = await readEvents(await post({
      nodeId,
      clientMessageId,
      content: "Create a Summary after checking the current branch",
      webSearchAuthorized: false,
    }));

    expect(events.at(-1)).toMatchObject({
      type: "completed",
      proposalCreated: false,
      assistantMessage: {
        content: expect.stringContaining("Regenerate the stale Branch Outline"),
      },
    });
    expect(runtime.invocations).toBe(1);
    expect(runtime.scenarios).toHaveLength(0);
  });

  it("keeps provider provenance empty when a stale-outline retry is blocked before a call", async () => {
    runtime.scenarios.push("route-synthesis", "generic-failure");
    const clientMessageId = randomUUID();
    const failed = await readEvents(await post({
      nodeId,
      clientMessageId,
      content: "Create a Summary that will need a retry",
      webSearchAuthorized: false,
    }));
    expect(failed.at(-1)).toMatchObject({
      type: "failed",
      assistantMessage: { status: "failed" },
    });
    expect(runtime.invocations).toBe(2);

    await installBranchOutline(true);
    const retried = await readEvents(await post({ nodeId, clientMessageId, retry: true }));
    expect(retried.at(-1)).toMatchObject({
      type: "completed",
      proposalCreated: false,
      assistantMessage: {
        status: "completed",
        content: expect.stringContaining("Regenerate the stale Branch Outline"),
      },
    });
    expect(runtime.invocations).toBe(2);
    expect((await storedTurn(clientMessageId)).find(({ role }) => role === "assistant"))
      .toMatchObject({
        model: null,
        provider_response_id: null,
        context_fingerprint: null,
      });
  });

  it("bounds combined conversational routing and synthesis output before a second call", async () => {
    runtime.scenarios.push("route-synthesis-at-content-limit", "proposal-success");
    const clientMessageId = randomUUID();
    const events = await readEvents(await post({
      nodeId,
      clientMessageId,
      content: "Propose a synthesis after a maximal routing response",
      webSearchAuthorized: false,
    }));

    expect(events.at(-1)).toMatchObject({
      type: "failed",
      assistantMessage: {
        status: "failed",
        failureCode: "response-invalid",
      },
    });
    expect(runtime.invocations).toBe(1);
    const proposals = await pool.query<{ count: number }>(
      `select count(*)::int as count from synthesis_versions
       where user_id = $1 and node_id = $2`,
      [userId, nodeId],
    );
    expect(proposals.rows).toEqual([{ count: 0 }]);
  });

  it("retries a failed refinement against its immutable pending target", async () => {
    const originalProposalId = await createPendingProposalViaRoute();
    runtime.scenarios.push(
      "route-synthesis",
      "generic-failure",
      "proposal-success",
    );
    const clientMessageId = randomUUID();
    const failedEvents = await readEvents(await post({
      nodeId,
      clientMessageId,
      content: "Refine this proposal and retry if needed",
      webSearchAuthorized: false,
    }));
    expect(failedEvents.at(-1)).toMatchObject({
      type: "failed",
      assistantMessage: { status: "failed" },
    });

    const retryEvents = await readEvents(await post({
      nodeId,
      clientMessageId,
      retry: true,
    }));
    expect(retryEvents.at(-1)).toMatchObject({
      type: "completed",
      assistantMessage: { status: "completed" },
    });
    const versions = await pool.query<{ id: string; status: string }>(
      `select id, status from synthesis_versions
       where user_id = $1 and node_id = $2 order by created_at`,
      [userId, nodeId],
    );
    expect(versions.rows.find(({ id }) => id === originalProposalId)?.status)
      .toBe("superseded");
    expect(versions.rows.filter(({ status }) => status === "pending")).toHaveLength(1);
    expect(runtime.invocations).toBe(5);
  });

  it("rejects a failed refinement retry without provider cost after its target is decided", async () => {
    const originalProposalId = await createPendingProposalViaRoute();
    runtime.scenarios.push("route-synthesis", "generic-failure");
    const clientMessageId = randomUUID();
    await readEvents(await post({
      nodeId,
      clientMessageId,
      content: "Refine a proposal that will be decided",
      webSearchAuthorized: false,
    }));
    expect(runtime.invocations).toBe(4);
    await pool.query(
      `update synthesis_versions
       set status = 'rejected', decided_at = now(), updated_at = now()
       where id = $1`,
      [originalProposalId],
    );

    const retryResponse = await post({ nodeId, clientMessageId, retry: true });
    expect(retryResponse.status).toBe(409);
    await expect(retryResponse.json()).resolves.toEqual({
      message: "The message could not be started.",
    });
    expect(runtime.invocations).toBe(4);
    expect(await storedTurn(clientMessageId)).toMatchObject([
      { role: "user", status: "completed" },
      { role: "assistant", status: "failed" },
    ]);
  });

  it("persists a web request abortion as an interrupted retryable failure", async () => {
    runtime.scenarios.push("web-wait-for-abort");
    const clientMessageId = randomUUID();
    const requestAbortController = new AbortController();
    const response = await post({
      nodeId,
      clientMessageId,
      content: "Interrupt this synthetic web turn",
      webSearchAuthorized: true,
    }, requestAbortController.signal);

    requestAbortController.abort();
    const events = await readEvents(response);
    expect(events.map(({ type }) => type)).not.toContain("completed");
    expect(events.at(-1)).toMatchObject({
      type: "failed",
      assistantMessage: {
        status: "failed",
        failureCode: "stream-disconnected",
      },
    });
    expect(await storedTurn(clientMessageId)).toMatchObject([
      { role: "user", status: "completed", web_search_authorized: true },
      {
        role: "assistant",
        status: "failed",
        failure_code: "stream-disconnected",
      },
    ]);
    expect(runtime.invocations).toBe(1);
  });

  it("keeps an explicit Stop cancelled when the POST stream subsequently aborts", async () => {
    runtime.scenarios.push("wait-for-abort");
    const clientMessageId = randomUUID();
    const response = await post({
      nodeId,
      clientMessageId,
      content: "Stop this synthetic turn explicitly",
      webSearchAuthorized: false,
    });
    const reader = response.body!.getReader();
    await reader.read();

    const stopped = await stop({ nodeId, clientMessageId });
    expect(stopped.status).toBe(200);
    await expect(stopped.json()).resolves.toMatchObject({
      assistantMessage: { status: "cancelled", failureCode: null },
    });
    await reader.cancel();
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

  it("emits heartbeats and persists downstream interruption as retryable failure", async () => {
    runtime.scenarios.push("web-wait-for-abort");
    const clientMessageId = randomUUID();
    const response = await post({
      nodeId,
      clientMessageId,
      content: "Research until the downstream reader disconnects",
      webSearchAuthorized: true,
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const events: Array<{ type: string }> = [];
    let buffer = "";

    while (
      !events.some(({ type }) => type === "heartbeat") ||
      !events.some(({ type }) => type === "research-status")
    ) {
      const { done, value } = await reader.read();
      expect(done).toBe(false);
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      events.push(...lines.filter(Boolean).map((line) => JSON.parse(line)));
    }

    expect(events[0]).toMatchObject({ type: "turn" });
    expect(events.map(({ type }) => type)).toContain("research-status");
    expect(events.map(({ type }) => type)).toContain("heartbeat");
    await reader.cancel();
    expect(await storedTurn(clientMessageId)).toMatchObject([
      { role: "user", status: "completed", web_search_authorized: true },
      {
        role: "assistant",
        status: "failed",
        failure_code: "stream-disconnected",
      },
    ]);
    expect(runtime.invocations).toBe(1);
  });
});
