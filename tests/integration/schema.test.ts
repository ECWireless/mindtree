import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";

const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL or DATABASE_URL_UNPOOLED is required for integration tests.");
}

const pool = new Pool({ connectionString });
let client: PoolClient;

async function expectConstraintViolation(
  operation: () => Promise<unknown>,
  constraint: string,
) {
  await client.query("savepoint constraint_check");
  await expect(operation()).rejects.toMatchObject({ code: expect.any(String), constraint });
  await client.query("rollback to savepoint constraint_check");
  await client.query("release savepoint constraint_check");
}

describe("initial authentication schema", () => {
  beforeAll(async () => {
    const result = await pool.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public' order by tablename",
    );

    expect(result.rows.map((row) => row.tablename)).toEqual([
      "account",
      "nodes",
      "session",
      "user",
      "verification",
    ]);
  });

  it("defines the owner-scoped deferrable node hierarchy constraints", async () => {
    const constraints = await client.query<{
      condeferrable: boolean;
      conname: string;
      definition: string;
    }>(
      `select conname, condeferrable, pg_get_constraintdef(oid) as definition
       from pg_constraint
       where conname in (
         'nodes_parent_owner_fk',
         'nodes_sibling_position_unique',
         'nodes_not_own_parent_check',
         'nodes_position_non_negative_check',
         'nodes_title_trimmed_length_check'
       )
       order by conname`,
    );

    expect(constraints.rows.map(({ conname }) => conname)).toEqual([
      "nodes_not_own_parent_check",
      "nodes_parent_owner_fk",
      "nodes_position_non_negative_check",
      "nodes_sibling_position_unique",
      "nodes_title_trimmed_length_check",
    ]);
    expect(
      constraints.rows.find(({ conname }) => conname === "nodes_sibling_position_unique"),
    ).toMatchObject({
      condeferrable: true,
      definition: expect.stringContaining("NULLS NOT DISTINCT"),
    });
    expect(
      constraints.rows.find(({ conname }) => conname === "nodes_parent_owner_fk")?.definition,
    ).toContain("FOREIGN KEY (user_id, parent_id) REFERENCES nodes(user_id, id) ON DELETE CASCADE");
  });

  it("enforces node ownership, title, position, sibling, and subtree constraints", async () => {
    const ownerId = `node-owner-${randomUUID()}`;
    const otherOwnerId = `node-owner-${randomUUID()}`;
    await client.query(
      `insert into "user" (id, name, email, email_verified)
       values
         ($1, 'Synthetic Node Owner', $2, true),
         ($3, 'Synthetic Other Owner', $4, true)`,
      [
        ownerId,
        `${randomUUID()}@example.test`,
        otherOwnerId,
        `${randomUUID()}@example.test`,
      ],
    );

    const rootId = randomUUID();
    await client.query(
      `insert into nodes (id, user_id, parent_id, position, title)
       values ($1, $2, null, 0, 'Root')`,
      [rootId, ownerId],
    );

    await expectConstraintViolation(
      () =>
        client.query(
          `insert into nodes (user_id, parent_id, position, title)
           values ($1, null, 0, 'Duplicate root position')`,
          [ownerId],
        ),
      "nodes_sibling_position_unique",
    );
    await expectConstraintViolation(
      () =>
        client.query(
          `insert into nodes (user_id, parent_id, position, title)
           values ($1, null, -1, 'Negative position')`,
          [ownerId],
        ),
      "nodes_position_non_negative_check",
    );
    for (const invalidTitle of [" Padded", "\tTabbed"]) {
      await expectConstraintViolation(
        () =>
          client.query(
            `insert into nodes (user_id, parent_id, position, title)
             values ($1, null, 1, $2)`,
            [ownerId, invalidTitle],
          ),
        "nodes_title_trimmed_length_check",
      );
    }
    await client.query("savepoint title_length_check");
    await expect(
      client.query(
        `insert into nodes (user_id, parent_id, position, title)
         values ($1, null, 1, $2)`,
        [ownerId, "x".repeat(201)],
      ),
    ).rejects.toMatchObject({ code: "22001" });
    await client.query("rollback to savepoint title_length_check");
    await client.query("release savepoint title_length_check");
    await expectConstraintViolation(
      () => client.query(`update nodes set parent_id = id where id = $1`, [rootId]),
      "nodes_not_own_parent_check",
    );
    await expectConstraintViolation(
      () =>
        client.query(
          `insert into nodes (user_id, parent_id, position, title)
           values ($1, $2, 0, 'Cross-owner child')`,
          [otherOwnerId, rootId],
        ),
      "nodes_parent_owner_fk",
    );

    const childId = randomUUID();
    const grandchildId = randomUUID();
    await client.query(
      `insert into nodes (id, user_id, parent_id, position, title)
       values ($1, $2, $3, 0, 'Child')`,
      [childId, ownerId, rootId],
    );
    await expectConstraintViolation(
      () =>
        client.query(
          `insert into nodes (user_id, parent_id, position, title)
           values ($1, $2, 0, 'Duplicate child position')`,
          [ownerId, rootId],
        ),
      "nodes_sibling_position_unique",
    );
    await client.query(
      `insert into nodes (id, user_id, parent_id, position, title)
       values ($1, $2, $3, 0, 'Grandchild')`,
      [grandchildId, ownerId, childId],
    );

    await client.query(`delete from nodes where id = $1`, [rootId]);
    const remaining = await client.query<{ count: number }>(
      `select count(*)::int as count from nodes where id = any($1::uuid[])`,
      [[rootId, childId, grandchildId]],
    );
    expect(remaining.rows[0]?.count).toBe(0);
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
