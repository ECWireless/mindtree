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
      "chat_messages",
      "nodes",
      "session",
      "synthesis_versions",
      "user",
      "verification",
    ]);
  });

  it("defines the owner-scoped persistent chat ledger constraints", async () => {
    const constraints = await client.query<{
      conname: string;
      definition: string;
    }>(
      `select conname, pg_get_constraintdef(oid) as definition
       from pg_constraint
       where conname like 'chat_messages_%'
       order by conname`,
    );

    expect(constraints.rows.map(({ conname }) => conname)).toEqual([
      "chat_messages_completion_check",
      "chat_messages_content_length_check",
      "chat_messages_context_fingerprint_check",
      "chat_messages_failure_code_check",
      "chat_messages_node_owner_fk",
      "chat_messages_node_sequence_unique",
      "chat_messages_pkey",
      "chat_messages_role_check",
      "chat_messages_role_state_check",
      "chat_messages_status_check",
      "chat_messages_turn_role_unique",
      "chat_messages_user_node_id_unique",
    ]);
    expect(
      constraints.rows.find(({ conname }) => conname === "chat_messages_node_owner_fk")
        ?.definition,
    ).toContain(
      "FOREIGN KEY (user_id, node_id) REFERENCES nodes(user_id, id) ON DELETE CASCADE",
    );

    const indexes = await client.query<{ indexdef: string; indexname: string }>(
      `select indexname, indexdef
       from pg_indexes
       where tablename = 'chat_messages'
       order by indexname`,
    );
    expect(indexes.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          indexname: "chat_messages_node_sequence_unique",
          indexdef: expect.stringContaining("(user_id, node_id, sequence)"),
        }),
        expect.objectContaining({ indexname: "chat_messages_turn_role_unique" }),
      ]),
    );
  });

  it("enforces chat ownership, replay, lifecycle, and content constraints", async () => {
    const ownerId = `chat-owner-${randomUUID()}`;
    const otherOwnerId = `chat-owner-${randomUUID()}`;
    const nodeId = randomUUID();
    await client.query(
      `insert into "user" (id, name, email, email_verified)
       values
         ($1, 'Synthetic Chat Owner', $2, true),
         ($3, 'Synthetic Other Chat Owner', $4, true)`,
      [
        ownerId,
        `${randomUUID()}@example.test`,
        otherOwnerId,
        `${randomUUID()}@example.test`,
      ],
    );
    await client.query(
      `insert into nodes (id, user_id, parent_id, position, title)
       values ($1, $2, null, 0, 'Chat node')`,
      [nodeId, ownerId],
    );

    const clientMessageId = randomUUID();
    await client.query(
      `insert into chat_messages
         (user_id, node_id, client_message_id, sequence, role, status, content,
          web_search_authorized, completed_at)
       values ($1, $2, $3, 0, 'user', 'completed', 'Question', true, now())`,
      [ownerId, nodeId, clientMessageId],
    );
    await client.query(
      `insert into chat_messages
         (user_id, node_id, client_message_id, sequence, role, status, content)
       values ($1, $2, $3, 1, 'assistant', 'pending', '')`,
      [ownerId, nodeId, clientMessageId],
    );

    await expectConstraintViolation(
      () =>
        client.query(
          `insert into chat_messages
             (user_id, node_id, client_message_id, sequence, role, status, content)
           values ($1, $2, $3, 2, 'assistant', 'pending', '')`,
          [ownerId, nodeId, clientMessageId],
        ),
      "chat_messages_turn_role_unique",
    );
    await expectConstraintViolation(
      () =>
        client.query(
          `insert into chat_messages
             (user_id, node_id, client_message_id, sequence, role, status, content,
              web_search_authorized, completed_at)
           values ($1, $2, $3, 0, 'user', 'completed', 'Cross owner', false, now())`,
          [otherOwnerId, nodeId, randomUUID()],
        ),
      "chat_messages_node_owner_fk",
    );
    await expectConstraintViolation(
      () =>
        client.query(
          `insert into chat_messages
             (user_id, node_id, client_message_id, sequence, role, status, content, completed_at)
           values ($1, $2, $3, 2, 'user', 'completed', '   ', now())`,
          [ownerId, nodeId, randomUUID()],
        ),
      "chat_messages_content_length_check",
    );
    await expectConstraintViolation(
      () =>
        client.query(
          `insert into chat_messages
             (user_id, node_id, client_message_id, sequence, role, status, content,
              model, completed_at)
           values ($1, $2, $3, 2, 'user', 'completed', 'Question', 'model', now())`,
          [ownerId, nodeId, randomUUID()],
        ),
      "chat_messages_role_state_check",
    );
    await expectConstraintViolation(
      () =>
        client.query(
          `insert into chat_messages
             (user_id, node_id, client_message_id, sequence, role, status, content,
              context_fingerprint, completed_at)
           values ($1, $2, $3, 2, 'user', 'completed', 'Question', $4, now())`,
          [ownerId, nodeId, randomUUID(), "a".repeat(64)],
        ),
      "chat_messages_role_state_check",
    );
    await expectConstraintViolation(
      () =>
        client.query(
          `insert into chat_messages
             (user_id, node_id, client_message_id, sequence, role, status, content,
              context_fingerprint)
           values ($1, $2, $3, 2, 'assistant', 'pending', '', 'not-a-fingerprint')`,
          [ownerId, nodeId, randomUUID()],
        ),
      "chat_messages_context_fingerprint_check",
    );
    await expectConstraintViolation(
      () =>
        client.query(
          `insert into chat_messages
             (user_id, node_id, client_message_id, sequence, role, status, content,
              web_search_authorized)
           values ($1, $2, $3, 2, 'assistant', 'pending', '', true)`,
          [ownerId, nodeId, randomUUID()],
        ),
      "chat_messages_role_state_check",
    );
    await expectConstraintViolation(
      () =>
        client.query(
          `insert into chat_messages
             (user_id, node_id, client_message_id, sequence, role, status, content)
           values ($1, $2, $3, 2, 'assistant', 'failed', '')`,
          [ownerId, nodeId, randomUUID()],
        ),
      "chat_messages_completion_check",
    );
    await expectConstraintViolation(
      () =>
        client.query(
          `insert into chat_messages
             (user_id, node_id, client_message_id, sequence, role, status, content, failure_code)
           values ($1, $2, $3, 2, 'assistant', 'failed', '', 'provider-request-id')`,
          [ownerId, nodeId, randomUUID()],
        ),
      "chat_messages_failure_code_check",
    );
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
         'nodes_published_synthesis_owner_fk',
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
      "nodes_published_synthesis_owner_fk",
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
    expect(
      constraints.rows.find(
        ({ conname }) => conname === "nodes_published_synthesis_owner_fk",
      ),
    ).toMatchObject({
      condeferrable: true,
      definition: expect.stringContaining(
        "FOREIGN KEY (user_id, id, published_synthesis_version_id) REFERENCES synthesis_versions(user_id, node_id, id) DEFERRABLE INITIALLY DEFERRED",
      ),
    });
  });

  it("defines owner-scoped immutable synthesis proposal constraints", async () => {
    const constraints = await client.query<{
      conname: string;
      definition: string;
    }>(
      `select conname, pg_get_constraintdef(oid) as definition
       from pg_constraint
       where conname like 'synthesis_versions_%'
       order by conname`,
    );
    expect(constraints.rows.map(({ conname }) => conname)).toEqual([
      "synthesis_versions_base_owner_fk",
      "synthesis_versions_content_length_check",
      "synthesis_versions_decision_state_check",
      "synthesis_versions_generating_message_unique",
      "synthesis_versions_input_fingerprint_check",
      "synthesis_versions_message_owner_fk",
      "synthesis_versions_node_owner_fk",
      "synthesis_versions_pkey",
      "synthesis_versions_profile_check",
      "synthesis_versions_status_check",
      "synthesis_versions_user_node_id_unique",
    ]);
    expect(
      constraints.rows.find(({ conname }) => conname === "synthesis_versions_node_owner_fk")
        ?.definition,
    ).toContain("FOREIGN KEY (user_id, node_id) REFERENCES nodes(user_id, id) ON DELETE CASCADE");

    const indexes = await client.query<{ indexdef: string; indexname: string }>(
      `select indexname, indexdef
       from pg_indexes
       where tablename = 'synthesis_versions'
       order by indexname`,
    );
    expect(indexes.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        indexname: "synthesis_versions_one_pending_per_node",
        indexdef: expect.stringContaining("WHERE ((status)::text = 'pending'::text)"),
      }),
    ]));
  });

  it("enforces owner- and node-scoped synthesis provenance links", async () => {
    const ownerId = `synthesis-provenance-${randomUUID()}`;
    const otherOwnerId = `synthesis-provenance-${randomUUID()}`;
    const nodeId = randomUUID();
    const siblingNodeId = randomUUID();
    const otherNodeId = randomUUID();
    await client.query(
      `insert into "user" (id, name, email, email_verified)
       values
         ($1, 'Synthetic Provenance Owner', $2, true),
         ($3, 'Synthetic Other Provenance Owner', $4, true)`,
      [
        ownerId,
        `${randomUUID()}@example.test`,
        otherOwnerId,
        `${randomUUID()}@example.test`,
      ],
    );
    await client.query(
      `insert into nodes (id, user_id, parent_id, position, title)
       values
         ($1, $2, null, 0, 'Provenance node'),
         ($3, $2, null, 1, 'Sibling provenance node'),
         ($4, $5, null, 0, 'Other provenance node')`,
      [nodeId, ownerId, siblingNodeId, otherNodeId, otherOwnerId],
    );

    const baseMessageId = randomUUID();
    const revisionMessageId = randomUUID();
    const siblingMessageId = randomUUID();
    const otherMessageId = randomUUID();
    for (const [messageId, messageUserId, messageNodeId, sequence] of [
      [baseMessageId, ownerId, nodeId, 0],
      [revisionMessageId, ownerId, nodeId, 1],
      [siblingMessageId, ownerId, siblingNodeId, 0],
      [otherMessageId, otherOwnerId, otherNodeId, 0],
    ] as const) {
      await client.query(
        `insert into chat_messages
           (id, user_id, node_id, client_message_id, sequence, role, status, content,
            model, context_fingerprint, completed_at)
         values ($1, $2, $3, $4, $5, 'assistant', 'completed', 'Synthetic response',
           'gpt-5.6-sol', $6, now())`,
        [
          messageId,
          messageUserId,
          messageNodeId,
          randomUUID(),
          sequence,
          "a".repeat(64),
        ],
      );
    }

    const baseVersionId = randomUUID();
    await client.query(
      `insert into synthesis_versions
         (id, user_id, node_id, status, content, model, reasoning_mode,
          reasoning_effort, input_fingerprint, generating_message_id, decided_at)
       values ($1, $2, $3, 'approved', 'Approved base', 'gpt-5.6-sol',
         'pro', 'high', $4, $5, now())`,
      [baseVersionId, ownerId, nodeId, "a".repeat(64), baseMessageId],
    );
    await client.query(
      `insert into synthesis_versions
         (user_id, node_id, base_version_id, status, content, model, reasoning_mode,
          reasoning_effort, input_fingerprint, generating_message_id)
       values ($1, $2, $3, 'pending', 'Valid same-node revision', 'gpt-5.6-sol',
         'pro', 'high', $4, $5)`,
      [ownerId, nodeId, baseVersionId, "b".repeat(64), revisionMessageId],
    );

    await expectConstraintViolation(
      () => client.query(
        `insert into synthesis_versions
           (user_id, node_id, base_version_id, status, content, model, reasoning_mode,
            reasoning_effort, input_fingerprint, generating_message_id, decided_at)
         values ($1, $2, $3, 'rejected', 'Cross-node base', 'gpt-5.6-sol',
           'pro', 'high', $4, $5, now())`,
        [ownerId, siblingNodeId, baseVersionId, "c".repeat(64), siblingMessageId],
      ),
      "synthesis_versions_base_owner_fk",
    );
    await expectConstraintViolation(
      () => client.query(
        `insert into synthesis_versions
           (user_id, node_id, status, content, model, reasoning_mode,
            reasoning_effort, input_fingerprint, generating_message_id, decided_at)
         values ($1, $2, 'rejected', 'Cross-owner message', 'gpt-5.6-sol',
           'pro', 'high', $3, $4, now())`,
        [ownerId, nodeId, "d".repeat(64), otherMessageId],
      ),
      "synthesis_versions_message_owner_fk",
    );
  });

  it("enforces synthesis ownership, pending uniqueness, decision state, and pointer integrity", async () => {
    const ownerId = `synthesis-owner-${randomUUID()}`;
    const otherOwnerId = `synthesis-owner-${randomUUID()}`;
    const nodeId = randomUUID();
    const otherNodeId = randomUUID();
    await client.query(
      `insert into "user" (id, name, email, email_verified)
       values
         ($1, 'Synthetic Synthesis Owner', $2, true),
         ($3, 'Synthetic Other Synthesis Owner', $4, true)`,
      [
        ownerId,
        `${randomUUID()}@example.test`,
        otherOwnerId,
        `${randomUUID()}@example.test`,
      ],
    );
    await client.query(
      `insert into nodes (id, user_id, parent_id, position, title)
       values
         ($1, $2, null, 0, 'Synthesis node'),
         ($3, $4, null, 0, 'Other synthesis node')`,
      [nodeId, ownerId, otherNodeId, otherOwnerId],
    );

    const messageId = randomUUID();
    await client.query(
      `insert into chat_messages
         (id, user_id, node_id, client_message_id, sequence, role, status, content,
          model, context_fingerprint, completed_at)
       values ($1, $2, $3, $4, 0, 'assistant', 'completed', 'Synthetic response',
         'gpt-5.6-sol', $5, now())`,
      [messageId, ownerId, nodeId, randomUUID(), "a".repeat(64)],
    );
    const proposalId = randomUUID();
    await client.query(
      `insert into synthesis_versions
         (id, user_id, node_id, status, content, model, reasoning_mode,
          reasoning_effort, input_fingerprint, generating_message_id)
       values ($1, $2, $3, 'pending', 'Synthetic proposal', 'gpt-5.6-sol',
         'pro', 'high', $4, $5)`,
      [proposalId, ownerId, nodeId, "a".repeat(64), messageId],
    );

    await expectConstraintViolation(
      () => client.query(
        `insert into synthesis_versions
           (user_id, node_id, status, content, model, reasoning_mode,
            reasoning_effort, input_fingerprint, generating_message_id)
         values ($1, $2, 'pending', 'Second pending proposal', 'gpt-5.6-sol',
           'pro', 'high', $3, $4)`,
        [ownerId, nodeId, "b".repeat(64), randomUUID()],
      ),
      "synthesis_versions_one_pending_per_node",
    );
    await expectConstraintViolation(
      () => client.query(
        `insert into synthesis_versions
           (user_id, node_id, status, content, model, reasoning_mode,
            reasoning_effort, input_fingerprint, generating_message_id, decided_at)
         values ($1, $2, 'rejected', 'Missing decision', 'gpt-5.6-sol',
           'pro', 'high', $3, $4, null)`,
        [ownerId, nodeId, "b".repeat(64), randomUUID()],
      ),
      "synthesis_versions_decision_state_check",
    );
    await expectConstraintViolation(
      () => client.query(
        `insert into synthesis_versions
           (user_id, node_id, status, content, model, reasoning_mode,
            reasoning_effort, input_fingerprint, generating_message_id, decided_at)
         values ($1, $2, 'rejected', 'Wrong profile', 'gpt-5.6-sol',
           'standard', 'high', $3, $4, now())`,
        [ownerId, nodeId, "b".repeat(64), randomUUID()],
      ),
      "synthesis_versions_profile_check",
    );
    await expectConstraintViolation(
      () => client.query(
        `insert into synthesis_versions
           (user_id, node_id, status, content, model, reasoning_mode,
            reasoning_effort, input_fingerprint, generating_message_id, decided_at)
         values ($1, $2, 'rejected', '', 'gpt-5.6-sol',
           'pro', 'high', $3, $4, now())`,
        [ownerId, nodeId, "b".repeat(64), randomUUID()],
      ),
      "synthesis_versions_content_length_check",
    );

    await expectConstraintViolation(
      async () => {
        await client.query(
          `update nodes set published_synthesis_version_id = $1 where id = $2`,
          [proposalId, otherNodeId],
        );
        await client.query("set constraints nodes_published_synthesis_owner_fk immediate");
      },
      "nodes_published_synthesis_owner_fk",
    );

    await client.query(
      `update synthesis_versions set status = 'approved', decided_at = now() where id = $1`,
      [proposalId],
    );
    await client.query(
      `update nodes set published_synthesis_version_id = $1 where id = $2`,
      [proposalId, nodeId],
    );
    await client.query(`delete from nodes where id = $1`, [nodeId]);
    await client.query("set constraints nodes_published_synthesis_owner_fk immediate");
    const remaining = await client.query<{ messages: number; proposals: number }>(
      `select
         (select count(*)::int from chat_messages where node_id = $1) as messages,
         (select count(*)::int from synthesis_versions where node_id = $1) as proposals`,
      [nodeId],
    );
    expect(remaining.rows[0]).toEqual({ messages: 0, proposals: 0 });
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
