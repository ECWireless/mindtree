import { randomUUID } from "node:crypto";

import { makeSignature } from "better-auth/crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";

import { AuthorizationError } from "../../src/lib/auth/policy";

const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL or DATABASE_URL_UNPOOLED is required for integration tests.");
}

const authSecret = "synthetic-node-action-secret-only";
const allowedEmail = "node-action-user@example.test";
const pool = new Pool({ connectionString });
const userIds = new Set<string>();
let requestHeaders = new Headers();
let createNode: typeof import("../../src/app/actions/nodes").createNode;
let moveNode: typeof import("../../src/app/actions/nodes").moveNode;
let renameNode: typeof import("../../src/app/actions/nodes").renameNode;

vi.mock("next/headers", () => ({
  headers: async () => requestHeaders,
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

async function seedAuthorizedSession() {
  const userId = `node-action-user-${randomUUID()}`;
  const token = `node-action-token-${randomUUID()}`;
  userIds.add(userId);
  await pool.query(
    `insert into "user" (id, name, email, email_verified)
     values ($1, 'Synthetic Node Action User', $2, true)`,
    [userId, allowedEmail],
  );
  await pool.query(
    `insert into "session" (id, user_id, token, expires_at)
     values ($1, $2, $3, now() + interval '1 hour')`,
    [`node-action-session-${randomUUID()}`, userId, token],
  );

  const signature = await makeSignature(token, authSecret);
  requestHeaders = new Headers({
    cookie: `better-auth.session_token=${token}.${signature}`,
  });
  return userId;
}

describe("node Server Actions", () => {
  beforeAll(async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", authSecret);
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
    vi.stubEnv("GOOGLE_CLIENT_ID", "synthetic-google-client-id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "synthetic-google-client-secret");
    vi.stubEnv("ALLOWED_EMAIL", allowedEmail);

    ({ createNode, moveNode, renameNode } = await import("../../src/app/actions/nodes"));
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

  it("authorizes before exposing validation details or mutating nodes", async () => {
    const before = await pool.query<{ count: string }>("select count(*) from nodes");
    await expect(createNode({ title: "" })).rejects.toEqual(
      new AuthorizationError("missing-session"),
    );
    await expect(
      moveNode({ id: "not-a-uuid", parentId: null }),
    ).rejects.toEqual(new AuthorizationError("missing-session"));
    await expect(
      renameNode({ id: "not-a-uuid", title: "" }),
    ).rejects.toEqual(new AuthorizationError("missing-session"));
    const after = await pool.query<{ count: string }>("select count(*) from nodes");
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });

  it("returns bounded validation failures and performs authorized mutations", async () => {
    const userId = await seedAuthorizedSession();
    expect(await createNode({ title: "   " })).toMatchObject({
      ok: false,
      fieldErrors: { title: ["Enter a title."] },
    });

    const root = await createNode({ title: "  Root  " });
    const destination = await createNode({ title: "Destination" });
    expect(root.ok && destination.ok).toBe(true);
    if (!root.ok || !destination.ok) {
      throw new Error("Expected node creation to succeed.");
    }

    expect(await renameNode({ id: root.nodeId, title: "Renamed" })).toEqual({
      ok: true,
      nodeId: root.nodeId,
    });
    expect(await moveNode({ id: root.nodeId, parentId: destination.nodeId })).toEqual({
      ok: true,
      nodeId: root.nodeId,
    });

    const stored = await pool.query<{ parent_id: string; title: string }>(
      `select parent_id, title from nodes where user_id = $1 and id = $2`,
      [userId, root.nodeId],
    );
    expect(stored.rows[0]).toEqual({ parent_id: destination.nodeId, title: "Renamed" });

    expect(await renameNode({ id: root.nodeId, title: "x".repeat(201) })).toMatchObject({
      ok: false,
      fieldErrors: { title: ["Use 200 characters or fewer."] },
    });
    expect(await moveNode({ id: root.nodeId, parentId: destination.nodeId, position: -1 })).toMatchObject({
      ok: false,
      fieldErrors: { position: expect.any(Array) },
    });
    expect(await moveNode({ id: root.nodeId, parentId: destination.nodeId, position: 0.5 })).toMatchObject({
      ok: false,
      fieldErrors: { position: expect.any(Array) },
    });
  });

  it("does not distinguish foreign nodes from missing nodes", async () => {
    const userId = await seedAuthorizedSession();
    const foreignUserId = `foreign-node-user-${randomUUID()}`;
    const foreignNodeId = randomUUID();
    const missingNodeId = randomUUID();
    userIds.add(foreignUserId);
    await pool.query(
      `insert into "user" (id, name, email, email_verified)
       values ($1, 'Synthetic Foreign User', $2, true)`,
      [foreignUserId, `${randomUUID()}@example.test`],
    );
    await pool.query(
      `insert into nodes (id, user_id, parent_id, position, title)
       values ($1, $2, null, 0, 'Foreign node')`,
      [foreignNodeId, foreignUserId],
    );
    const owned = await createNode({ title: "Owned" });
    if (!owned.ok) {
      throw new Error("Expected owned node creation to succeed.");
    }

    expect(await createNode({ title: "Child", parentId: foreignNodeId })).toEqual(
      await createNode({ title: "Child", parentId: missingNodeId }),
    );
    expect(await renameNode({ id: foreignNodeId, title: "Renamed" })).toEqual(
      await renameNode({ id: missingNodeId, title: "Renamed" }),
    );
    expect(await moveNode({ id: foreignNodeId, parentId: null })).toEqual(
      await moveNode({ id: missingNodeId, parentId: null }),
    );
    expect(await moveNode({ id: owned.nodeId, parentId: foreignNodeId })).toEqual(
      await moveNode({ id: owned.nodeId, parentId: missingNodeId }),
    );

    const ownedRows = await pool.query<{ parent_id: string | null }>(
      `select parent_id from nodes where user_id = $1 and id = $2`,
      [userId, owned.nodeId],
    );
    expect(ownedRows.rows).toEqual([{ parent_id: null }]);
  });
});
