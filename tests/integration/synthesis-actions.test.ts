import { randomUUID } from "node:crypto";

import { makeSignature } from "better-auth/crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";

import { AuthorizationError } from "../../src/lib/auth/policy";

const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!connectionString) throw new Error("A PostgreSQL test database is required.");

const authSecret = "synthetic-synthesis-action-secret-at-least-32-chars";
const allowedEmail = "synthesis-action-user@example.test";
const pool = new Pool({ connectionString });
const userIds = new Set<string>();
let requestHeaders = new Headers();
let approveSynthesisProposal:
  typeof import("../../src/app/actions/synthesis").approveSynthesisProposal;
let rejectSynthesisProposal:
  typeof import("../../src/app/actions/synthesis").rejectSynthesisProposal;

vi.mock("next/headers", () => ({ headers: async () => requestHeaders }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

async function seedAuthorizedSession() {
  const userId = `synthesis-action-${randomUUID()}`;
  const token = `synthesis-action-token-${randomUUID()}`;
  userIds.add(userId);
  await pool.query(
    `insert into "user" (id, name, email, email_verified)
     values ($1, 'Synthetic Synthesis Action User', $2, true)`,
    [userId, allowedEmail],
  );
  await pool.query(
    `insert into "session" (id, user_id, token, expires_at)
     values ($1, $2, $3, now() + interval '1 hour')`,
    [`synthesis-action-session-${randomUUID()}`, userId, token],
  );
  requestHeaders = new Headers({
    cookie: `better-auth.session_token=${token}.${await makeSignature(token, authSecret)}`,
  });
  return userId;
}

async function insertNode(userId: string, position: number) {
  const nodeId = randomUUID();
  await pool.query(
    `insert into nodes (id, user_id, parent_id, position, title)
     values ($1, $2, null, $3, 'Synthesis action node')`,
    [nodeId, userId, position],
  );
  return nodeId;
}

async function insertPendingProposal(userId: string, nodeId: string) {
  const messageId = randomUUID();
  await pool.query(
    `insert into chat_messages
       (id, user_id, node_id, client_message_id, sequence, role, status, content,
        model, context_fingerprint, completed_at)
     values ($1, $2, $3, $4, 0, 'assistant', 'completed', 'Synthetic response',
       'gpt-5.6-sol', $5, now())`,
    [messageId, userId, nodeId, randomUUID(), "a".repeat(64)],
  );
  const proposalId = randomUUID();
  await pool.query(
    `insert into synthesis_versions
       (id, user_id, node_id, status, content, model, reasoning_mode,
        reasoning_effort, input_fingerprint, generating_message_id)
     values ($1, $2, $3, 'pending', 'Synthetic proposal', 'gpt-5.6-sol',
       'pro', 'high', $4, $5)`,
    [proposalId, userId, nodeId, "b".repeat(64), messageId],
  );
  return proposalId;
}

describe("synthesis decision Server Actions", () => {
  beforeAll(async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", authSecret);
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
    vi.stubEnv("GOOGLE_CLIENT_ID", "synthetic-google-client-id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "synthetic-google-client-secret");
    vi.stubEnv("ALLOWED_EMAIL", allowedEmail);
    ({ approveSynthesisProposal, rejectSynthesisProposal } = await import(
      "../../src/app/actions/synthesis"
    ));
  });

  afterEach(async () => {
    requestHeaders = new Headers();
    if (userIds.size > 0) {
      await pool.query(`delete from "user" where id = any($1::text[])`, [[...userIds]]);
      userIds.clear();
    }
  });

  afterAll(async () => {
    try {
      await pool.end();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("authorizes before validating or exposing synthesis decision details", async () => {
    await expect(approveSynthesisProposal({ nodeId: "invalid", proposalId: "invalid" }))
      .rejects.toEqual(new AuthorizationError("missing-session"));
    await expect(rejectSynthesisProposal({ nodeId: "invalid", proposalId: "invalid" }))
      .rejects.toEqual(new AuthorizationError("missing-session"));
  });

  it("validates input and performs authorized approval and rejection", async () => {
    const userId = await seedAuthorizedSession();
    expect(await approveSynthesisProposal({ nodeId: "invalid", proposalId: "invalid" }))
      .toEqual({ ok: false, message: "That synthesis proposal is invalid." });

    const approvedNodeId = await insertNode(userId, 0);
    const approvedProposalId = await insertPendingProposal(userId, approvedNodeId);
    expect(await approveSynthesisProposal({
      nodeId: approvedNodeId,
      proposalId: approvedProposalId,
    })).toEqual({
      ok: true,
      nodeId: approvedNodeId,
      proposalId: approvedProposalId,
      status: "approved",
    });

    const rejectedNodeId = await insertNode(userId, 1);
    const rejectedProposalId = await insertPendingProposal(userId, rejectedNodeId);
    expect(await rejectSynthesisProposal({
      nodeId: rejectedNodeId,
      proposalId: rejectedProposalId,
    })).toEqual({
      ok: true,
      nodeId: rejectedNodeId,
      proposalId: rejectedProposalId,
      status: "rejected",
    });
  });

  it("returns the same bounded result for missing and foreign proposals", async () => {
    const userId = await seedAuthorizedSession();
    const nodeId = await insertNode(userId, 0);
    const foreignUserId = `foreign-synthesis-action-${randomUUID()}`;
    userIds.add(foreignUserId);
    await pool.query(
      `insert into "user" (id, name, email, email_verified)
       values ($1, 'Foreign Synthesis Action User', $2, true)`,
      [foreignUserId, `${randomUUID()}@example.test`],
    );
    const foreignNodeId = await insertNode(foreignUserId, 0);
    const foreignProposalId = await insertPendingProposal(foreignUserId, foreignNodeId);
    const expected = { ok: false, message: "That synthesis proposal is no longer available." };

    expect(await approveSynthesisProposal({ nodeId, proposalId: randomUUID() }))
      .toEqual(expected);
    expect(await approveSynthesisProposal({ nodeId, proposalId: foreignProposalId }))
      .toEqual(expected);
  });
});
