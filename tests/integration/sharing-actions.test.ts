import { randomUUID } from "node:crypto";

import { makeSignature } from "better-auth/crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";

import { AuthorizationError } from "../../src/lib/auth/policy";
import { digestBranchShareSecret } from "../../src/lib/server/share-capability";

const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL or DATABASE_URL_UNPOOLED is required.");
}

const authSecret = "synthetic-share-action-secret-only";
const allowedEmail = "share-action-user@example.test";
const pool = new Pool({ connectionString });
const userIds = new Set<string>();
let requestHeaders = new Headers();
let createBranchShareLink:
  typeof import("../../src/app/actions/sharing").createBranchShareLink;
let revokeBranchShareLink:
  typeof import("../../src/app/actions/sharing").revokeBranchShareLink;

vi.mock("next/headers", () => ({
  headers: async () => requestHeaders,
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

async function seedAuthorizedSession() {
  const userId = `share-action-user-${randomUUID()}`;
  const token = `share-action-token-${randomUUID()}`;
  userIds.add(userId);
  await pool.query(
    `insert into "user" (id, name, email, email_verified)
     values ($1, 'Synthetic Share Action User', $2, true)`,
    [userId, allowedEmail],
  );
  await pool.query(
    `insert into "session" (id, user_id, token, expires_at)
     values ($1, $2, $3, now() + interval '1 hour')`,
    [`share-action-session-${randomUUID()}`, userId, token],
  );
  const signature = await makeSignature(token, authSecret);
  requestHeaders = new Headers({
    cookie: `better-auth.session_token=${token}.${signature}`,
  });
  return userId;
}

async function insertNode(userId: string, archived = false) {
  const nodeId = randomUUID();
  await pool.query(
    `insert into nodes (id, user_id, parent_id, position, title, archived_at)
     values ($1, $2, null, 0, 'Synthetic share action root', $3)`,
    [nodeId, userId, archived ? new Date() : null],
  );
  return nodeId;
}

describe("branch sharing Server Actions", () => {
  beforeAll(async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", authSecret);
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
    vi.stubEnv("GOOGLE_CLIENT_ID", "synthetic-google-client-id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "synthetic-google-client-secret");
    vi.stubEnv("ALLOWED_EMAIL", allowedEmail);
    ({ createBranchShareLink, revokeBranchShareLink } = await import(
      "../../src/app/actions/sharing"
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

  it("authorizes before revealing share input validation", async () => {
    await expect(createBranchShareLink({ nodeId: "not-a-node" })).rejects.toEqual(
      new AuthorizationError("missing-session"),
    );
    await expect(revokeBranchShareLink({ nodeId: "not-a-node" })).rejects.toEqual(
      new AuthorizationError("missing-session"),
    );
  });

  it("returns a capability once, reports duplicate state, and revokes safely", async () => {
    const userId = await seedAuthorizedSession();
    const nodeId = await insertNode(userId);

    expect(await createBranchShareLink({ nodeId: "not-a-node" })).toEqual({
      ok: false,
      message: "That thought is invalid.",
    });
    const created = await createBranchShareLink({ nodeId });
    expect(created).toMatchObject({
      ok: true,
      link: { rootNodeId: nodeId },
      secret: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    if (!created.ok) throw new Error("Expected a share link to be created.");
    const stored = await pool.query<{ secret_digest: string }>(
      `select secret_digest from branch_share_links where root_node_id = $1`,
      [nodeId],
    );
    expect(stored.rows).toEqual([{
      secret_digest: digestBranchShareSecret(created.secret),
    }]);

    expect(await createBranchShareLink({ nodeId })).toEqual({
      ok: false,
      message: "This thought already has a share link. Revoke it before creating another.",
    });
    expect(await revokeBranchShareLink({ nodeId })).toEqual({
      ok: true,
      nodeId,
      revoked: true,
    });
    expect(await revokeBranchShareLink({ nodeId })).toEqual({
      ok: true,
      nodeId,
      revoked: false,
    });
  });

  it("does not create public capability records for archived roots", async () => {
    const userId = await seedAuthorizedSession();
    const nodeId = await insertNode(userId, true);
    expect(await createBranchShareLink({ nodeId })).toEqual({
      ok: false,
      message: "Unarchive this thought before sharing its trail.",
    });
    const rows = await pool.query(
      `select id from branch_share_links where root_node_id = $1`,
      [nodeId],
    );
    expect(rows.rows).toEqual([]);
  });
});
