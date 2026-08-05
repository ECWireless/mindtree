import { randomUUID } from "node:crypto";

import { makeSignature } from "better-auth/crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";

const runtimeState = vi.hoisted(() => ({
  calls: 0,
  content: "## Generated branch\n\n- Connect the direct child.",
  lastInput: "",
  mode: "deterministic-fixture" as "deterministic-fixture" | "unavailable",
}));
const serviceState = vi.hoisted(() => ({ recoverCalls: 0, skipLookupOnce: false }));

vi.mock("@/lib/server/branch-outline-runtime", () => ({
  getBranchOutlineGenerationMode: () => runtimeState.mode,
  isBranchOutlineGenerationEnabled: () => true,
  streamBranchOutlineResponse: async function* (input: {
    messages: Array<{ role: "user"; content: string }>;
  }) {
    runtimeState.calls += 1;
    runtimeState.lastInput = input.messages[0]?.content ?? "";
    const providerResponseId = `fixture-outline-${runtimeState.calls}`;
    yield { type: "started", providerResponseId };
    yield { type: "text-delta", content: runtimeState.content };
    yield {
      type: "completed",
      providerResponseId,
      content: runtimeState.content,
    };
  },
}));

vi.mock("@/lib/server/branch-outline-service", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../src/lib/server/branch-outline-service")
  >();
  return {
    ...actual,
    getBranchOutlineGenerationForRequestForUser: async (
      ...args: Parameters<typeof actual.getBranchOutlineGenerationForRequestForUser>
    ) => {
      if (serviceState.skipLookupOnce) {
        serviceState.skipLookupOnce = false;
        return null;
      }
      return actual.getBranchOutlineGenerationForRequestForUser(...args);
    },
    recoverAbandonedBranchOutlineGenerationForUser: async (
      ...args: Parameters<typeof actual.recoverAbandonedBranchOutlineGenerationForUser>
    ) => {
      serviceState.recoverCalls += 1;
      return actual.recoverAbandonedBranchOutlineGenerationForUser(...args);
    },
  };
});

const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL or DATABASE_URL_UNPOOLED is required.");
const pool = new Pool({ connectionString });
const authSecret = "synthetic-outline-route-secret-at-least-32-chars";
const allowedEmail = "outline-route@example.test";
let cookie = "";
let userId = "";
let foreignUserId = "";
let postBranchOutline: typeof import("../../src/app/api/branch-outline/route").POST;
let getBranchOutline: typeof import("../../src/app/api/branch-outline/route").GET;

async function insertNode(ownerId: string, title: string, parentId: string | null = null) {
  const position = await pool.query<{ value: number }>(
    `select coalesce(max(position), -1)::int + 1 as value
     from nodes where user_id = $1 and parent_id is not distinct from $2`,
    [ownerId, parentId],
  );
  const id = randomUUID();
  await pool.query(
    `insert into nodes (id, user_id, parent_id, position, title)
     values ($1, $2, $3, $4, $5)`,
    [id, ownerId, parentId, position.rows[0]?.value ?? 0, title],
  );
  return id;
}

async function insertApprovedSummary(ownerId: string, nodeId: string, content: string) {
  const messageId = randomUUID();
  const sequence = await pool.query<{ value: string }>(
    `select (coalesce(max(sequence), -1) + 1)::text as value
     from chat_messages where user_id = $1 and node_id = $2`,
    [ownerId, nodeId],
  );
  await pool.query(
    `insert into chat_messages
       (id, user_id, node_id, client_message_id, sequence, role, status, content,
        model, context_fingerprint, completed_at)
     values ($1, $2, $3, $4, $5, 'assistant', 'completed', 'Synthetic response',
       'gpt-5.6-sol', $6, now())`,
    [messageId, ownerId, nodeId, randomUUID(), sequence.rows[0]?.value ?? "0", "a".repeat(64)],
  );
  const summaryId = randomUUID();
  await pool.query(
    `insert into synthesis_versions
       (id, user_id, node_id, status, content, model, reasoning_mode,
        reasoning_effort, input_fingerprint, generating_message_id, decided_at)
     values ($1, $2, $3, 'approved', $4, 'gpt-5.6-sol', 'pro', 'high', $5, $6, now())`,
    [summaryId, ownerId, nodeId, content, "b".repeat(64), messageId],
  );
  await pool.query(
    `update nodes set published_synthesis_version_id = $1 where id = $2`,
    [summaryId, nodeId],
  );
  return summaryId;
}

async function insertCurrentOutline(
  ownerId: string,
  nodeId: string,
  baseSynthesisVersionId: string | null,
  content: string,
) {
  const outlineId = randomUUID();
  await pool.query(
    `insert into branch_outline_versions
       (id, user_id, node_id, client_request_id, base_synthesis_version_id,
        status, content, model, reasoning_mode, reasoning_effort,
        input_fingerprint, completed_at)
     values ($1, $2, $3, $4, $5, 'completed', $6, 'gpt-5.6-sol', 'pro', 'high',
       $7, now())`,
    [outlineId, ownerId, nodeId, randomUUID(), baseSynthesisVersionId, content, "c".repeat(64)],
  );
  await pool.query(
    `update nodes set current_branch_outline_version_id = $1 where id = $2`,
    [outlineId, nodeId],
  );
  return outlineId;
}

function request(nodeId: string, clientRequestId = randomUUID(), requestCookie = cookie) {
  return new Request("http://127.0.0.1:3188/api/branch-outline", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: requestCookie },
    body: JSON.stringify({ nodeId, clientRequestId }),
  });
}

async function events(response: Response) {
  const text = await response.text();
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

describe("Branch Outline generation route", () => {
  beforeAll(async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", authSecret);
    vi.stubEnv("BETTER_AUTH_URL", "http://127.0.0.1:3188");
    vi.stubEnv("GOOGLE_CLIENT_ID", "synthetic-google-client-id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "synthetic-google-client-secret");
    vi.stubEnv("ALLOWED_EMAIL", allowedEmail);
    userId = `outline-route-${randomUUID()}`;
    foreignUserId = `foreign-outline-route-${randomUUID()}`;
    const token = `outline-route-token-${randomUUID()}`;
    await pool.query(
      `insert into "user" (id, name, email, email_verified) values
       ($1, 'Synthetic Outline Route', $2, true),
       ($3, 'Foreign Outline Route', $4, true)`,
      [userId, allowedEmail, foreignUserId, `${randomUUID()}@example.test`],
    );
    await pool.query(
      `insert into "session" (id, user_id, token, expires_at)
       values ($1, $2, $3, now() + interval '1 hour')`,
      [`outline-route-session-${randomUUID()}`, userId, token],
    );
    const signature = await makeSignature(token, authSecret);
    cookie = `better-auth.session_token=${token}.${signature}`;
    ({
      POST: postBranchOutline,
      GET: getBranchOutline,
    } = await import("../../src/app/api/branch-outline/route"));
  });

  beforeEach(() => {
    runtimeState.calls = 0;
    runtimeState.content = "## Generated branch\n\n- Connect the direct child.";
    runtimeState.lastInput = "";
    runtimeState.mode = "deterministic-fixture";
    serviceState.skipLookupOnce = false;
    serviceState.recoverCalls = 0;
  });

  afterAll(async () => {
    try {
      await pool.query(`delete from "user" where id = any($1::text[])`, [[userId, foreignUserId]]);
      await pool.end();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("authenticates before validation and does not distinguish foreign nodes", async () => {
    const unauthorized = await postBranchOutline(request("invalid", randomUUID(), ""));
    expect(unauthorized.status).toBe(401);
    const unauthorizedStatus = await getBranchOutline(new Request(
      "http://127.0.0.1:3188/api/branch-outline?nodeId=invalid",
    ));
    expect(unauthorizedStatus.status).toBe(401);
    const invalid = await postBranchOutline(request("invalid"));
    expect(invalid.status).toBe(400);
    const oversized = await postBranchOutline(new Request(
      "http://127.0.0.1:3188/api/branch-outline",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": "16001",
          cookie,
        },
        body: "{}",
      },
    ));
    expect(oversized.status).toBe(413);

    const foreignNodeId = await insertNode(foreignUserId, "Foreign branch");
    const missingNodeId = randomUUID();
    const foreign = await postBranchOutline(request(foreignNodeId));
    const missing = await postBranchOutline(request(missingNodeId));
    expect({ status: foreign.status, body: await foreign.json() }).toEqual({
      status: missing.status,
      body: await missing.json(),
    });
    expect(runtimeState.calls).toBe(0);
  });

  it("uses exact server-derived child inputs, installs once, and replays without another call", async () => {
    const nodeId = await insertNode(userId, "Route target");
    const childId = await insertNode(userId, "Route child", nodeId);
    const targetSummaryId = await insertApprovedSummary(userId, nodeId, "Target Summary");
    const childSummaryId = await insertApprovedSummary(userId, childId, "Child Summary");
    const childOutlineId = await insertCurrentOutline(
      userId,
      childId,
      childSummaryId,
      "Deeper child context",
    );
    const staleChildId = await insertNode(userId, "Stale route child", nodeId);
    const staleOutlineId = await insertCurrentOutline(
      userId,
      staleChildId,
      null,
      "Stale content must not reach the provider",
    );
    await pool.query(
      `update nodes
       set branch_outline_stale_at = now(), branch_outline_stale_reason = 'branch-content-changed'
       where id = $1`,
      [staleChildId],
    );
    const clientRequestId = randomUUID();

    const response = await postBranchOutline(request(nodeId, clientRequestId));
    expect(response.status).toBe(200);
    const streamed = await events(response);
    expect(streamed.map(({ type }) => type)).toEqual([
      "generation",
      "delta",
      "completed",
    ]);
    const completed = streamed.at(-1);
    expect(completed).toMatchObject({
      type: "completed",
      installed: true,
      generation: {
        status: "completed",
        content: runtimeState.content,
        providerResponseId: "fixture-outline-1",
      },
    });
    expect(runtimeState.calls).toBe(1);
    expect(runtimeState.lastInput).toContain("Target Summary");
    expect(runtimeState.lastInput).toContain("Child Summary");
    expect(runtimeState.lastInput).toContain("Deeper child context");
    expect(runtimeState.lastInput).toContain('"outline":{"state":"stale"}');
    expect(runtimeState.lastInput).not.toContain("Stale content must not reach the provider");
    expect(runtimeState.lastInput).not.toContain(nodeId);
    expect(runtimeState.lastInput.indexOf("Route child")).toBeLessThan(
      runtimeState.lastInput.indexOf("Stale route child"),
    );

    const replay = await postBranchOutline(request(nodeId, clientRequestId));
    expect(replay.status).toBe(200);
    expect((await events(replay)).map(({ type }) => type)).toEqual([
      "generation",
      "completed",
    ]);
    expect(runtimeState.calls).toBe(1);

    const stored = await pool.query<{
      current_branch_outline_version_id: string;
      published_synthesis_version_id: string;
      source_synthesis_version_id: string | null;
      source_branch_outline_version_id: string | null;
    }>(
      `select n.current_branch_outline_version_id, n.published_synthesis_version_id,
              i.source_synthesis_version_id, i.source_branch_outline_version_id
       from nodes n
       join branch_outline_inputs i
         on i.outline_version_id = n.current_branch_outline_version_id
       where n.id = $1
       order by i.position`,
      [nodeId],
    );
    expect(stored.rows).toEqual([
      {
        current_branch_outline_version_id: completed.generation.id,
        published_synthesis_version_id: targetSummaryId,
        source_synthesis_version_id: childSummaryId,
        source_branch_outline_version_id: childOutlineId,
      },
      {
        current_branch_outline_version_id: completed.generation.id,
        published_synthesis_version_id: targetSummaryId,
        source_synthesis_version_id: null,
        source_branch_outline_version_id: staleOutlineId,
      },
    ]);
  });

  it("makes only one provider call for concurrent duplicate requests", async () => {
    const nodeId = await insertNode(userId, "Duplicate route");
    const clientRequestId = randomUUID();
    const responses = await Promise.all([
      postBranchOutline(request(nodeId, clientRequestId)),
      postBranchOutline(request(nodeId, clientRequestId)),
    ]);
    await Promise.all(responses.filter(({ status }) => status === 200).map(events));
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 409]);
    expect(runtimeState.calls).toBe(1);
    const count = await pool.query<{ value: number }>(
      `select count(*)::int as value from branch_outline_versions
       where user_id = $1 and node_id = $2 and client_request_id = $3`,
      [userId, nodeId, clientRequestId],
    );
    expect(count.rows[0]?.value).toBe(1);
  });

  it("replays terminal requests without provider availability", async () => {
    const nodeId = await insertNode(userId, "Offline replay route");
    const clientRequestId = randomUUID();
    await events(await postBranchOutline(request(nodeId, clientRequestId)));
    expect(runtimeState.calls).toBe(1);
    runtimeState.mode = "unavailable";

    const replay = await postBranchOutline(request(nodeId, clientRequestId));
    expect(replay.status).toBe(200);
    expect((await events(replay)).at(-1)).toMatchObject({
      type: "completed",
      installed: true,
    });
    expect(runtimeState.calls).toBe(1);
    const fresh = await postBranchOutline(request(nodeId));
    expect(fresh.status).toBe(503);
  });

  it("reports a replayed completed version as uninstalled after regeneration", async () => {
    const nodeId = await insertNode(userId, "Superseded replay route");
    const firstRequestId = randomUUID();
    const first = (await events(
      await postBranchOutline(request(nodeId, firstRequestId)),
    )).at(-1)?.generation.id as string;
    const second = (await events(
      await postBranchOutline(request(nodeId)),
    )).at(-1)?.generation.id as string;
    expect(second).not.toBe(first);

    serviceState.skipLookupOnce = true;
    const replay = await postBranchOutline(request(nodeId, firstRequestId));
    expect((await events(replay)).at(-1)).toMatchObject({
      type: "completed",
      installed: false,
      generation: { id: first },
    });
    expect(runtimeState.calls).toBe(2);
    const node = await pool.query<{ current_id: string }>(
      `select current_branch_outline_version_id as current_id from nodes where id = $1`,
      [nodeId],
    );
    expect(node.rows[0]?.current_id).toBe(second);
  });

  it("reconciles and fails an abandoned pending generation without a provider call", async () => {
    const nodeId = await insertNode(userId, "Abandoned route");
    const generationId = randomUUID();
    await pool.query(
      `insert into branch_outline_versions
         (id, user_id, node_id, client_request_id, status, model, reasoning_mode,
          reasoning_effort, input_fingerprint, updated_at)
       values ($1, $2, $3, $4, 'pending', 'gpt-5.6-sol', 'pro', 'high', $5,
         now() - interval '151 seconds')`,
      [generationId, userId, nodeId, randomUUID(), "d".repeat(64)],
    );
    const response = await getBranchOutline(new Request(
      `http://127.0.0.1:3188/api/branch-outline?nodeId=${nodeId}`,
      { headers: { cookie } },
    ));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      pending: null,
      latestFailure: {
        id: generationId,
        status: "failed",
        failureCode: "stream-disconnected",
      },
    });
    expect(runtimeState.calls).toBe(0);
    expect(serviceState.recoverCalls).toBe(1);
  });

  it("polls a fresh pending generation without taking the recovery lock", async () => {
    const nodeId = await insertNode(userId, "Fresh pending route");
    const generationId = randomUUID();
    await pool.query(
      `insert into branch_outline_versions
         (id, user_id, node_id, client_request_id, status, model, reasoning_mode,
          reasoning_effort, input_fingerprint)
       values ($1, $2, $3, $4, 'pending', 'gpt-5.6-sol', 'pro', 'high', $5)`,
      [generationId, userId, nodeId, randomUUID(), "e".repeat(64)],
    );
    const response = await getBranchOutline(new Request(
      `http://127.0.0.1:3188/api/branch-outline?nodeId=${nodeId}`,
      { headers: { cookie } },
    ));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      pending: { id: generationId, status: "pending" },
      latestFailure: null,
    });
    expect(serviceState.recoverCalls).toBe(0);
  });

  it("preserves the current outline when a later provider result is invalid", async () => {
    const nodeId = await insertNode(userId, "Invalid output route");
    const first = await postBranchOutline(request(nodeId));
    const firstEvents = await events(first);
    const firstId = firstEvents.at(-1)?.generation.id as string;

    runtimeState.content = "<script>unsafe</script>";
    const invalid = await postBranchOutline(request(nodeId));
    expect(invalid.status).toBe(200);
    expect((await events(invalid)).at(-1)).toMatchObject({
      type: "failed",
      generation: { status: "failed", failureCode: "response-invalid" },
    });
    const node = await pool.query<{ current_branch_outline_version_id: string }>(
      `select current_branch_outline_version_id from nodes where id = $1`,
      [nodeId],
    );
    expect(node.rows[0]?.current_branch_outline_version_id).toBe(firstId);
  });
});
