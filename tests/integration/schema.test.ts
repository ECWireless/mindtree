import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";

const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL or DATABASE_URL_UNPOOLED is required for integration tests.");
}

const pool = new Pool({ connectionString });
let client: PoolClient;

describe("initial authentication schema", () => {
  beforeAll(async () => {
    const result = await pool.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public' order by tablename",
    );

    expect(result.rows.map((row) => row.tablename)).toEqual([
      "account",
      "session",
      "user",
      "verification",
    ]);
  });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("begin");
  });

  afterEach(async () => {
    await client.query("rollback");
    client.release();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("enforces unique user emails and session tokens", async () => {
    const firstUserId = `user-${randomUUID()}`;
    const secondUserId = `user-${randomUUID()}`;
    const email = `${randomUUID()}@example.test`;

    await client.query(
      `insert into "user" (id, name, email, email_verified)
       values ($1, 'Synthetic User', $2, true)`,
      [firstUserId, email],
    );

    await expect(
      client.query(
        `insert into "user" (id, name, email, email_verified)
         values ($1, 'Synthetic User', $2, true)`,
        [secondUserId, email],
      ),
    ).rejects.toMatchObject({ code: "23505", constraint: "user_email_unique" });

    await client.query("rollback");
    await client.query("begin");
    await client.query(
      `insert into "user" (id, name, email, email_verified)
       values ($1, 'Synthetic User', $2, true)`,
      [firstUserId, email],
    );
    const token = `token-${randomUUID()}`;
    await client.query(
      `insert into "session" (id, user_id, token, expires_at)
       values ($1, $2, $3, now() + interval '1 hour')`,
      [`session-${randomUUID()}`, firstUserId, token],
    );

    await expect(
      client.query(
        `insert into "session" (id, user_id, token, expires_at)
         values ($1, $2, $3, now() + interval '1 hour')`,
        [`session-${randomUUID()}`, firstUserId, token],
      ),
    ).rejects.toMatchObject({ code: "23505", constraint: "session_token_unique" });
  });

  it("cascades owned account and session records when a user is deleted", async () => {
    const userId = `user-${randomUUID()}`;
    await client.query(
      `insert into "user" (id, name, email, email_verified)
       values ($1, 'Synthetic User', $2, true)`,
      [userId, `${randomUUID()}@example.test`],
    );
    await client.query(
      `insert into "account" (id, account_id, provider_id, user_id)
       values ($1, $2, 'google', $3)`,
      [`account-${randomUUID()}`, `google-${randomUUID()}`, userId],
    );
    await client.query(
      `insert into "session" (id, user_id, token, expires_at)
       values ($1, $2, $3, now() + interval '1 hour')`,
      [`session-${randomUUID()}`, userId, `token-${randomUUID()}`],
    );

    await client.query(`delete from "user" where id = $1`, [userId]);

    const result = await client.query<{ accounts: number; sessions: number }>(
      `select
         (select count(*)::int from "account" where user_id = $1) as accounts,
         (select count(*)::int from "session" where user_id = $1) as sessions`,
      [userId],
    );
    expect(result.rows[0]).toEqual({ accounts: 0, sessions: 0 });
  });
});
