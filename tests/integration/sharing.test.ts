import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { Pool } from "pg";

import {
  BRANCH_SHARE_SECRET_LENGTH,
  MAX_PUBLIC_TRAIL_NODES,
  MAX_PUBLIC_TRAIL_SERIALIZED_BYTES,
} from "../../src/lib/sharing/contracts";
import {
  digestBranchShareSecret,
  generateBranchShareSecret,
} from "../../src/lib/server/share-capability";
import {
  BranchShareServiceError,
  createBranchShareLinkForUser,
  getBranchShareLinkStateForUser,
  getPublicThoughtTrail,
  revokeBranchShareLinkForUser,
} from "../../src/lib/server/share-service";

const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL or DATABASE_URL_UNPOOLED is required.");
}

const pool = new Pool({ connectionString });
const userIds = new Set<string>();

async function insertUser() {
  const userId = `share-user-${randomUUID()}`;
  userIds.add(userId);
  await pool.query(
    `insert into "user" (id, name, email, email_verified)
     values ($1, 'Synthetic Share User', $2, true)`,
    [userId, `${randomUUID()}@example.test`],
  );
  return userId;
}

async function insertNode(input: {
  userId: string;
  title: string;
  parentId?: string | null;
  position?: number;
  archived?: boolean;
}) {
  const nodeId = randomUUID();
  await pool.query(
    `insert into nodes (id, user_id, parent_id, position, title, archived_at)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      nodeId,
      input.userId,
      input.parentId ?? null,
      input.position ?? 0,
      input.title,
      input.archived ? new Date() : null,
    ],
  );
  return nodeId;
}

async function insertApprovedSummary(input: {
  userId: string;
  nodeId: string;
  content: string;
  citations?: Array<
    | {
        kind: "internal";
        ordinal: number;
        startUtf16: number;
        endUtf16: number;
        targetNodeId: string;
        targetTitle: string;
        targetParentId: string | null;
        targetSynthesisVersionId: string;
      }
    | {
        kind: "external";
        ordinal: number;
        startUtf16: number;
        title: string;
        url: string;
      }
  >;
}) {
  const messageId = randomUUID();
  const summaryId = randomUUID();
  await pool.query(
    `insert into chat_messages
       (id, user_id, node_id, client_message_id, sequence, role, status,
        content, model, context_fingerprint, completed_at)
     values ($1, $2, $3, $4, 0, 'assistant', 'completed',
       'Synthetic public Summary', 'gpt-5.6-sol', $5, now())`,
    [messageId, input.userId, input.nodeId, randomUUID(), "a".repeat(64)],
  );
  await pool.query(
    `insert into synthesis_versions
       (id, user_id, node_id, status, content, model, reasoning_mode,
        reasoning_effort, input_fingerprint, generating_message_id)
     values ($1, $2, $3, 'pending', $4, 'gpt-5.6-sol', 'pro', 'high', $5, $6)`,
    [
      summaryId,
      input.userId,
      input.nodeId,
      input.content,
      "b".repeat(64),
      messageId,
    ],
  );
  for (const citation of input.citations ?? []) {
    if (citation.kind === "internal") {
      await pool.query(
        `insert into citations
           (user_id, owner_node_id, synthesis_version_id, kind, ordinal,
            start_utf16, end_utf16, live_target_node_id,
            live_target_synthesis_version_id, target_node_id_snapshot,
            target_title_snapshot, target_parent_id_snapshot,
            target_synthesis_version_id_snapshot)
         values ($1, $2, $3, 'internal', $4, $5, $6, $7, $8, $7, $9, $10, $8)`,
        [
          input.userId,
          input.nodeId,
          summaryId,
          citation.ordinal,
          citation.startUtf16,
          citation.endUtf16,
          citation.targetNodeId,
          citation.targetSynthesisVersionId,
          citation.targetTitle,
          citation.targetParentId,
        ],
      );
    } else {
      await pool.query(
        `insert into citations
           (user_id, owner_node_id, synthesis_version_id, kind, ordinal,
            start_utf16, end_utf16, external_url, external_title)
         values ($1, $2, $3, 'external', $4, $5, $5, $6, $7)`,
        [
          input.userId,
          input.nodeId,
          summaryId,
          citation.ordinal,
          citation.startUtf16,
          citation.url,
          citation.title,
        ],
      );
    }
  }
  await pool.query(
    `update synthesis_versions
     set status = 'approved', decided_at = now(), updated_at = now()
     where id = $1`,
    [summaryId],
  );
  await pool.query(
    `update nodes set published_synthesis_version_id = $1 where id = $2`,
    [summaryId, input.nodeId],
  );
  return summaryId;
}

async function insertBranchOutline(input: {
  userId: string;
  nodeId: string;
  baseSynthesisVersionId: string | null;
  content: string;
}) {
  const outlineId = randomUUID();
  await pool.query(
    `insert into branch_outline_versions
       (id, user_id, node_id, client_request_id, base_synthesis_version_id,
        status, content, model, reasoning_mode, reasoning_effort,
        input_fingerprint, completed_at)
     values ($1, $2, $3, $4, $5, 'completed', $6, 'gpt-5.6-sol',
       'pro', 'high', $7, now())`,
    [
      outlineId,
      input.userId,
      input.nodeId,
      randomUUID(),
      input.baseSynthesisVersionId,
      input.content,
      "c".repeat(64),
    ],
  );
  await pool.query(
    `update nodes set current_branch_outline_version_id = $1 where id = $2`,
    [outlineId, input.nodeId],
  );
  return outlineId;
}

afterEach(async () => {
  if (userIds.size > 0) {
    await pool.query(`delete from "user" where id = any($1::text[])`, [[...userIds]]);
    userIds.clear();
  }
});

afterAll(async () => {
  await pool.end();
});

describe("branch share capability lifecycle", () => {
  it("stores only one digest-backed capability and revokes it idempotently", async () => {
    const userId = await insertUser();
    const rootNodeId = await insertNode({ userId, title: "Shared root" });

    const generated = generateBranchShareSecret();
    expect(generated).toHaveLength(BRANCH_SHARE_SECRET_LENGTH);
    expect(digestBranchShareSecret(generated)).toMatch(/^[0-9a-f]{64}$/);
    expect(digestBranchShareSecret("malformed")).toBeNull();

    const created = await createBranchShareLinkForUser(userId, rootNodeId);
    expect(created.secret).toHaveLength(BRANCH_SHARE_SECRET_LENGTH);
    expect(created.link).toMatchObject({ rootNodeId });
    const stored = await pool.query<{
      secret_digest: string;
      secret_present: boolean;
    }>(
      `select secret_digest,
        exists(
          select 1 from information_schema.columns
          where table_name = 'branch_share_links' and column_name = 'secret'
        ) as secret_present
       from branch_share_links where id = $1`,
      [created.link.id],
    );
    expect(stored.rows).toEqual([{
      secret_digest: digestBranchShareSecret(created.secret),
      secret_present: false,
    }]);
    expect(await getBranchShareLinkStateForUser(userId, rootNodeId)).toEqual(
      created.link,
    );
    await expect(createBranchShareLinkForUser(userId, rootNodeId)).rejects.toEqual(
      new BranchShareServiceError("link-exists"),
    );

    expect(await revokeBranchShareLinkForUser(userId, rootNodeId)).toEqual({
      nodeId: rootNodeId,
      revoked: true,
    });
    expect(await revokeBranchShareLinkForUser(userId, rootNodeId)).toEqual({
      nodeId: rootNodeId,
      revoked: false,
    });
    await expect(getPublicThoughtTrail(created.secret)).rejects.toEqual(
      new BranchShareServiceError("not-found"),
    );
  });

  it("keeps creation owner-scoped and refuses archived roots", async () => {
    const ownerId = await insertUser();
    const otherOwnerId = await insertUser();
    const foreignNodeId = await insertNode({
      userId: otherOwnerId,
      title: "Foreign root",
    });
    const archivedNodeId = await insertNode({
      userId: ownerId,
      title: "Archived root",
      archived: true,
    });
    await expect(
      createBranchShareLinkForUser(ownerId, foreignNodeId),
    ).rejects.toEqual(new BranchShareServiceError("node-not-found"));
    await expect(
      createBranchShareLinkForUser(ownerId, randomUUID()),
    ).rejects.toEqual(new BranchShareServiceError("node-not-found"));
    await expect(
      createBranchShareLinkForUser(ownerId, archivedNodeId),
    ).rejects.toEqual(new BranchShareServiceError("archived-root"));
    await expect(
      getBranchShareLinkStateForUser(ownerId, foreignNodeId),
    ).rejects.toEqual(new BranchShareServiceError("node-not-found"));
    await expect(
      revokeBranchShareLinkForUser(ownerId, foreignNodeId),
    ).rejects.toEqual(new BranchShareServiceError("node-not-found"));
  });
});

describe("dynamic public thought-trail read boundary", () => {
  it("returns only current active subtree fields and filters internal targets", async () => {
    const userId = await insertUser();
    const privateSiblingId = await insertNode({
      userId,
      title: "Private sibling",
      position: 0,
    });
    const rootId = await insertNode({ userId, title: "Public root", position: 1 });
    const outsideId = await insertNode({ userId, title: "Private outside", position: 2 });
    const archivedChildId = await insertNode({
      userId,
      title: "Archived child",
      parentId: rootId,
      position: 0,
      archived: true,
    });
    const childId = await insertNode({
      userId,
      title: "Public child",
      parentId: rootId,
      position: 1,
    });
    const childSummaryId = await insertApprovedSummary({
      userId,
      nodeId: childId,
      content: "Current child Summary",
    });
    const outsideSummaryId = await insertApprovedSummary({
      userId,
      nodeId: outsideId,
      content: "Private outside Summary",
    });
    const content = "Public child informs Private outside.";
    const rootSummaryId = await insertApprovedSummary({
      userId,
      nodeId: rootId,
      content,
      citations: [
        {
          kind: "internal",
          ordinal: 1,
          startUtf16: content.indexOf("Public child"),
          endUtf16: content.indexOf("Public child") + "Public child".length,
          targetNodeId: childId,
          targetTitle: "Public child",
          targetParentId: rootId,
          targetSynthesisVersionId: childSummaryId,
        },
        {
          kind: "internal",
          ordinal: 2,
          startUtf16: content.indexOf("Private outside"),
          endUtf16: content.indexOf("Private outside") + "Private outside".length,
          targetNodeId: outsideId,
          targetTitle: "Private outside",
          targetParentId: null,
          targetSynthesisVersionId: outsideSummaryId,
        },
        {
          kind: "external",
          ordinal: 1,
          startUtf16: content.length,
          title: "Synthetic   public source",
          url: "https://example.test/source#private-fragment",
        },
      ],
    });
    await insertBranchOutline({
      userId,
      nodeId: rootId,
      baseSynthesisVersionId: rootSummaryId,
      content: "- **Public child:** Current child relationship",
    });

    const created = await createBranchShareLinkForUser(userId, rootId);
    const trail = await getPublicThoughtTrail(created.secret, childId);
    expect(trail).toEqual({
      rootNodeId: rootId,
      selectedNodeId: childId,
      nodes: [
        {
          id: rootId,
          parentId: null,
          position: 0,
          title: "Public root",
          summary: {
            content,
            citations: [
              expect.objectContaining({ kind: "internal", targetNodeId: childId }),
              expect.objectContaining({ kind: "internal", targetNodeId: null }),
              expect.objectContaining({
                kind: "external",
                title: "Synthetic public source",
                url: "https://example.test/source",
              }),
            ],
          },
          branchOutline: {
            content: "- **Public child:** Current child relationship",
          },
        },
        {
          id: childId,
          parentId: rootId,
          position: 0,
          title: "Public child",
          summary: { content: "Current child Summary", citations: [] },
          branchOutline: null,
        },
      ],
    });
    expect(JSON.stringify(trail)).not.toContain(archivedChildId);
    expect(JSON.stringify(trail)).not.toContain(privateSiblingId);
    expect(JSON.stringify(trail)).not.toContain(outsideId);
    expect(JSON.stringify(trail)).not.toContain("Private outside Summary");

    await pool.query(
      `update nodes set parent_id = null, position = 3 where id = $1`,
      [childId],
    );
    const afterMoveOut = await getPublicThoughtTrail(created.secret);
    expect(afterMoveOut.nodes.map(({ id }) => id)).toEqual([rootId]);
    await expect(getPublicThoughtTrail(created.secret, childId)).rejects.toEqual(
      new BranchShareServiceError("not-found"),
    );

    await pool.query(
      `update nodes set parent_id = $1, position = 1 where id = $2`,
      [rootId, childId],
    );
    expect((await getPublicThoughtTrail(created.secret)).nodes.map(({ id }) => id))
      .toEqual([rootId, childId]);

    await pool.query(
      `update nodes set parent_id = $1, position = 0 where id = $2`,
      [outsideId, rootId],
    );
    const afterRootMove = await getPublicThoughtTrail(created.secret);
    expect(afterRootMove.nodes[0]?.parentId).toBeNull();
    expect(JSON.stringify(afterRootMove)).not.toContain(outsideId);

    await pool.query(`update nodes set archived_at = now() where id = $1`, [rootId]);
    await expect(getPublicThoughtTrail(created.secret)).rejects.toEqual(
      new BranchShareServiceError("not-found"),
    );
    await pool.query(`update nodes set archived_at = null where id = $1`, [rootId]);
    await expect(getPublicThoughtTrail(created.secret)).resolves.toMatchObject({
      rootNodeId: rootId,
    });

    await pool.query(`delete from nodes where id = $1`, [rootId]);
    await expect(getPublicThoughtTrail(created.secret)).rejects.toEqual(
      new BranchShareServiceError("not-found"),
    );
  });

  it("fails closed when the active shared response exceeds its node bound", async () => {
    const userId = await insertUser();
    const rootId = await insertNode({ userId, title: "Oversized root" });
    await pool.query(
      `insert into nodes (id, user_id, parent_id, position, title)
       select gen_random_uuid(), $1, $2, generated.position,
         'Synthetic child ' || generated.position
       from generate_series(0, $3::int) as generated(position)`,
      [userId, rootId, MAX_PUBLIC_TRAIL_NODES - 1],
    );
    const created = await createBranchShareLinkForUser(userId, rootId);
    await expect(getPublicThoughtTrail(created.secret)).rejects.toEqual(
      new BranchShareServiceError("oversized"),
    );
  });

  it("preflights the serialized content bound before returning large bodies", async () => {
    const userId = await insertUser();
    const nodeIds = Array.from({ length: 65 }, () => randomUUID());
    const messageIds = nodeIds.map(() => randomUUID());
    const clientMessageIds = nodeIds.map(() => randomUUID());
    const summaryIds = nodeIds.map(() => randomUUID());
    const outlineIds = nodeIds.map(() => randomUUID());
    const positions = nodeIds.map((_, index) => index === 0 ? 0 : index - 1);
    const titles = nodeIds.map((_, index) => `Bounded node ${index}`);
    const parentIds = nodeIds.map((_, index) => index === 0 ? null : nodeIds[0]!);
    await pool.query(
      `insert into nodes (id, user_id, parent_id, position, title)
       select input.id, $1, input.parent_id, input.position, input.title
       from unnest($2::uuid[], $3::uuid[], $4::int[], $5::text[])
         as input(id, parent_id, position, title)`,
      [userId, nodeIds, parentIds, positions, titles],
    );
    await pool.query(
      `insert into chat_messages
         (id, user_id, node_id, client_message_id, sequence, role, status,
          content, model, context_fingerprint, completed_at)
       select input.message_id, $1, input.node_id, input.client_message_id,
         0, 'assistant', 'completed', 'Synthetic bounded response',
         'gpt-5.6-sol', $2, now()
       from unnest($3::uuid[], $4::uuid[], $5::uuid[])
         as input(message_id, node_id, client_message_id)`,
      [userId, "d".repeat(64), messageIds, nodeIds, clientMessageIds],
    );
    await pool.query(
      `insert into synthesis_versions
         (id, user_id, node_id, status, content, model, reasoning_mode,
          reasoning_effort, input_fingerprint, generating_message_id, decided_at)
       select input.summary_id, $1, input.node_id, 'approved', $2,
         'gpt-5.6-sol', 'pro', 'high', $3, input.message_id, now()
       from unnest($4::uuid[], $5::uuid[], $6::uuid[])
         as input(summary_id, node_id, message_id)`,
      [
        userId,
        "s".repeat(32_000),
        "e".repeat(64),
        summaryIds,
        nodeIds,
        messageIds,
      ],
    );
    await pool.query(
      `insert into branch_outline_versions
         (id, user_id, node_id, client_request_id, base_synthesis_version_id,
          status, content, model, reasoning_mode, reasoning_effort,
          input_fingerprint, completed_at)
       select input.outline_id, $1, input.node_id, input.client_request_id,
         input.summary_id, 'completed', $2, 'gpt-5.6-sol', 'pro', 'high', $3, now()
       from unnest($4::uuid[], $5::uuid[], $6::uuid[], $7::uuid[])
         as input(outline_id, node_id, client_request_id, summary_id)`,
      [
        userId,
        "o".repeat(32_000),
        "f".repeat(64),
        outlineIds,
        nodeIds,
        nodeIds.map(() => randomUUID()),
        summaryIds,
      ],
    );
    await pool.query(
      `update nodes
       set published_synthesis_version_id = input.summary_id,
           current_branch_outline_version_id = input.outline_id
       from unnest($1::uuid[], $2::uuid[], $3::uuid[])
         as input(node_id, summary_id, outline_id)
       where nodes.id = input.node_id`,
      [nodeIds, summaryIds, outlineIds],
    );
    const created = await createBranchShareLinkForUser(userId, nodeIds[0]!);
    const underLimit = await getPublicThoughtTrail(created.secret);
    expect(Buffer.byteLength(JSON.stringify(underLimit), "utf8"))
      .toBeLessThanOrEqual(MAX_PUBLIC_TRAIL_SERIALIZED_BYTES);

    const finalNodeId = await insertNode({
      userId,
      title: "Bounded node 65",
      parentId: nodeIds[0]!,
      position: 64,
    });
    const finalSummaryId = await insertApprovedSummary({
      userId,
      nodeId: finalNodeId,
      content: "s".repeat(32_000),
    });
    await insertBranchOutline({
      userId,
      nodeId: finalNodeId,
      baseSynthesisVersionId: finalSummaryId,
      content: "o".repeat(32_000),
    });
    await expect(getPublicThoughtTrail(created.secret)).rejects.toEqual(
      new BranchShareServiceError("oversized"),
    );
  });

  it("fails closed when stored external citation metadata is not canonical", async () => {
    const userId = await insertUser();
    const rootId = await insertNode({ userId, title: "Invalid source root" });
    const content = "Credential-bearing source.";
    await insertApprovedSummary({
      userId,
      nodeId: rootId,
      content,
      citations: [{
        kind: "external",
        ordinal: 1,
        startUtf16: content.length,
        title: "Invalid credential source",
        url: "https://synthetic:secret@example.test/source",
      }],
    });
    const created = await createBranchShareLinkForUser(userId, rootId);
    await expect(getPublicThoughtTrail(created.secret)).rejects.toEqual(
      new BranchShareServiceError("unavailable"),
    );
  });

  it("rejects a citation-dominated payload before loading public citation rows", async () => {
    const userId = await insertUser();
    const nodeIds = Array.from({ length: 54 }, () => randomUUID());
    const messageIds = nodeIds.map(() => randomUUID());
    const clientMessageIds = nodeIds.map(() => randomUUID());
    const summaryIds = nodeIds.map(() => randomUUID());
    const parentIds = nodeIds.map((_, index) => index === 0 ? null : nodeIds[0]!);
    const positions = nodeIds.map((_, index) => index === 0 ? 0 : index - 1);
    const titles = nodeIds.map((_, index) => `Citation-heavy node ${index}`);
    await pool.query(
      `insert into nodes (id, user_id, parent_id, position, title)
       select input.id, $1, input.parent_id, input.position, input.title
       from unnest($2::uuid[], $3::uuid[], $4::int[], $5::text[])
         as input(id, parent_id, position, title)`,
      [userId, nodeIds, parentIds, positions, titles],
    );
    await pool.query(
      `insert into chat_messages
         (id, user_id, node_id, client_message_id, sequence, role, status,
          content, model, context_fingerprint, completed_at)
       select input.message_id, $1, input.node_id, input.client_message_id,
         0, 'assistant', 'completed', 'Synthetic citation-heavy response',
         'gpt-5.6-sol', $2, now()
       from unnest($3::uuid[], $4::uuid[], $5::uuid[])
         as input(message_id, node_id, client_message_id)`,
      [userId, "1".repeat(64), messageIds, nodeIds, clientMessageIds],
    );
    await pool.query(
      `insert into synthesis_versions
         (id, user_id, node_id, status, content, model, reasoning_mode,
          reasoning_effort, input_fingerprint, generating_message_id)
       select input.summary_id, $1, input.node_id, 'pending', $2,
         'gpt-5.6-sol', 'pro', 'high', $3, input.message_id
       from unnest($4::uuid[], $5::uuid[], $6::uuid[])
         as input(summary_id, node_id, message_id)`,
      [
        userId,
        "c".repeat(64),
        "2".repeat(64),
        summaryIds,
        nodeIds,
        messageIds,
      ],
    );
    await pool.query(
      `insert into citations
         (user_id, owner_node_id, synthesis_version_id, kind, ordinal,
          start_utf16, end_utf16, external_url, external_title)
       select $1, input.node_id, input.summary_id, 'external', source.ordinal,
         source.ordinal, source.ordinal,
         'https://example.test/' || repeat('a', 1980) ||
           lpad(source.ordinal::text, 2, '0'),
         repeat('t', 498) || lpad(source.ordinal::text, 2, '0')
       from unnest($2::uuid[], $3::uuid[]) as input(summary_id, node_id)
       cross join generate_series(1, 32) as source(ordinal)`,
      [userId, summaryIds, nodeIds],
    );
    await pool.query(
      `update synthesis_versions
       set status = 'approved', decided_at = now(), updated_at = now()
       where id = any($1::uuid[])`,
      [summaryIds],
    );
    await pool.query(
      `update nodes
       set published_synthesis_version_id = input.summary_id
       from unnest($1::uuid[], $2::uuid[]) as input(node_id, summary_id)
       where nodes.id = input.node_id`,
      [nodeIds, summaryIds],
    );
    const created = await createBranchShareLinkForUser(userId, nodeIds[0]!);
    await expect(getPublicThoughtTrail(created.secret)).rejects.toEqual(
      new BranchShareServiceError("oversized"),
    );
  });

  it("makes revocation wait for the production public-read lock and denies later reads", async () => {
    const userId = await insertUser();
    const rootId = await insertNode({ userId, title: "Concurrent root" });
    const created = await createBranchShareLinkForUser(userId, rootId);
    let signalReadLocked!: () => void;
    let releaseRead!: () => void;
    const readLocked = new Promise<void>((resolve) => { signalReadLocked = resolve; });
    const readRelease = new Promise<void>((resolve) => { releaseRead = resolve; });
    const admittedRead = getPublicThoughtTrail(created.secret, undefined, {
      afterLinkLocked: async () => {
        signalReadLocked();
        await readRelease;
      },
    });
    await readLocked;
    const revocation = revokeBranchShareLinkForUser(userId, rootId);
    try {
      let waitingOnReadLock = false;
      for (let attempt = 0; attempt < 40 && !waitingOnReadLock; attempt += 1) {
        const waiting = await pool.query<{ waiting: boolean }>(
          `select exists(
             select 1 from pg_stat_activity
             where datname = current_database()
               and wait_event_type = 'Lock'
               and query like 'delete from "branch_share_links"%'
           ) as waiting`,
        );
        waitingOnReadLock = waiting.rows[0]?.waiting ?? false;
        if (!waitingOnReadLock) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      expect(waitingOnReadLock).toBe(true);
      releaseRead();
      await expect(admittedRead).resolves.toMatchObject({ rootNodeId: rootId });
      await expect(revocation).resolves.toEqual({ nodeId: rootId, revoked: true });
    } finally {
      releaseRead();
    }
    await expect(getPublicThoughtTrail(created.secret)).rejects.toEqual(
      new BranchShareServiceError("not-found"),
    );
  });
});
