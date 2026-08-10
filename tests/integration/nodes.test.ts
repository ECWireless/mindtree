import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL or DATABASE_URL_UNPOOLED is required for integration tests.");
}

const pool = new Pool({ connectionString });
const userIds = new Set<string>();

let createNodeForUser: typeof import("../../src/lib/server/node-service").createNodeForUser;
let deleteNodeForUser: typeof import("../../src/lib/server/node-service").deleteNodeForUser;
let archiveNodeForUser: typeof import(
  "../../src/lib/server/node-service"
).archiveNodeForUser;
let getNodeTreeForUser: typeof import(
  "../../src/lib/server/node-service"
).getNodeTreeForUser;
let moveNodeForUser: typeof import("../../src/lib/server/node-service").moveNodeForUser;
let NodeMutationError: typeof import("../../src/lib/server/node-service").NodeMutationError;
let renameNodeForUser: typeof import(
  "../../src/lib/server/node-service"
).renameNodeForUser;
let unarchiveNodeForUser: typeof import(
  "../../src/lib/server/node-service"
).unarchiveNodeForUser;

async function insertUser() {
  const userId = `node-user-${randomUUID()}`;
  userIds.add(userId);
  await pool.query(
    `insert into "user" (id, name, email, email_verified)
     values ($1, 'Synthetic Node User', $2, true)`,
    [userId, `${userId}@example.test`],
  );
  return userId;
}

async function siblingPositions(userId: string, parentId: string | null) {
  const result = await pool.query<{ id: string; position: number }>(
    `select id, position
     from nodes
     where user_id = $1 and parent_id is not distinct from $2::uuid
     order by position, id`,
    [userId, parentId],
  );
  return result.rows;
}

async function installArtifacts(userId: string, nodeId: string) {
  const messageId = randomUUID();
  const summaryId = randomUUID();
  const outlineId = randomUUID();
  await pool.query(
    `insert into chat_messages
       (id, user_id, node_id, client_message_id, sequence, role, status, content,
        model, context_fingerprint, completed_at)
     values ($1, $2, $3, $4, 0, 'assistant', 'completed', 'Synthetic artifact response',
       'gpt-5.6-sol', $5, now())`,
    [messageId, userId, nodeId, randomUUID(), "a".repeat(64)],
  );
  await pool.query(
    `insert into synthesis_versions
       (id, user_id, node_id, base_version_id, status, content, model,
        reasoning_mode, reasoning_effort, input_fingerprint, generating_message_id, decided_at)
     values ($1, $2, $3, null, 'approved', 'Synthetic Summary', 'gpt-5.6-sol',
       'pro', 'high', $4, $5, now())`,
    [summaryId, userId, nodeId, "b".repeat(64), messageId],
  );
  await pool.query(
    `insert into branch_outline_versions
       (id, user_id, node_id, client_request_id, status, content, model,
        reasoning_mode, reasoning_effort, input_fingerprint, completed_at)
     values ($1, $2, $3, $4, 'completed', 'Synthetic Branch Outline', 'gpt-5.6-sol',
       'pro', 'high', $5, now())`,
    [outlineId, userId, nodeId, randomUUID(), "c".repeat(64)],
  );
  await pool.query(
    `update nodes
     set published_synthesis_version_id = $1,
         current_branch_outline_version_id = $2
     where user_id = $3 and id = $4`,
    [summaryId, outlineId, userId, nodeId],
  );
}

async function clearStaleness(userId: string) {
  await pool.query(
    `update nodes
     set synthesis_stale_at = null,
         branch_outline_stale_at = null,
         branch_outline_stale_reason = null
     where user_id = $1`,
    [userId],
  );
}

async function artifactStates(userId: string) {
  const result = await pool.query<{
    id: string;
    synthesis_stale_at: Date | null;
    branch_outline_stale_at: Date | null;
    branch_outline_stale_reason: string | null;
  }>(
    `select id, synthesis_stale_at, branch_outline_stale_at,
            branch_outline_stale_reason
     from nodes where user_id = $1`,
    [userId],
  );
  return new Map(result.rows.map((row) => [row.id, row]));
}

describe("owner-scoped node service", () => {
  beforeAll(async () => {
    ({
      archiveNodeForUser,
      createNodeForUser,
      deleteNodeForUser,
      getNodeTreeForUser,
      moveNodeForUser,
      NodeMutationError,
      renameNodeForUser,
      unarchiveNodeForUser,
    } = await import("../../src/lib/server/node-service"));
  });

  afterEach(async () => {
    if (userIds.size > 0) {
      await pool.query(`delete from "user" where id = any($1::text[])`, [[...userIds]]);
      userIds.clear();
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  it("creates multiple roots and deep children only for their owner", async () => {
    const ownerId = await insertUser();
    const otherUserId = await insertUser();
    const firstRoot = await createNodeForUser(ownerId, { title: "First root" });
    await createNodeForUser(ownerId, { title: "Second root" });
    const child = await createNodeForUser(ownerId, {
      title: "Child",
      parentId: firstRoot.id,
    });
    await createNodeForUser(ownerId, { title: "Grandchild", parentId: child.id });

    await expect(
      createNodeForUser(otherUserId, { title: "Cross-owner", parentId: firstRoot.id }),
    ).rejects.toEqual(new NodeMutationError("parent-not-found"));

    const tree = await getNodeTreeForUser(ownerId);
    expect(tree.roots.map(({ title }) => title)).toEqual(["First root", "Second root"]);
    expect(tree.ordered.map(({ title }) => title)).toEqual([
      "First root",
      "Child",
      "Grandchild",
      "Second root",
    ]);
    expect((await getNodeTreeForUser(otherUserId)).ordered).toEqual([]);
  });

  it("renames only an owner-scoped node", async () => {
    const ownerId = await insertUser();
    const otherUserId = await insertUser();
    const root = await createNodeForUser(ownerId, { title: "Original" });

    await expect(
      renameNodeForUser(otherUserId, { id: root.id, title: "Not allowed" }),
    ).rejects.toEqual(new NodeMutationError("node-not-found"));
    await expect(
      moveNodeForUser(otherUserId, { id: root.id, parentId: null }),
    ).rejects.toEqual(new NodeMutationError("node-not-found"));

    const renamed = await renameNodeForUser(ownerId, { id: root.id, title: "Renamed" });
    expect(renamed.title).toBe("Renamed");
  });

  it("recursively stales only the affected artifact paths for every tree mutation", async () => {
    const userId = await insertUser();
    const firstRoot = await createNodeForUser(userId, { title: "First root" });
    const secondRoot = await createNodeForUser(userId, { title: "Second root" });
    const child = await createNodeForUser(userId, {
      title: "Child",
      parentId: firstRoot.id,
    });
    const grandchild = await createNodeForUser(userId, {
      title: "Grandchild",
      parentId: child.id,
    });
    for (const node of [firstRoot, secondRoot, child, grandchild]) {
      await installArtifacts(userId, node.id);
    }

    await renameNodeForUser(userId, { id: child.id, title: "Renamed child" });
    let states = await artifactStates(userId);
    expect(states.get(firstRoot.id)).toMatchObject({
      synthesis_stale_at: expect.any(Date),
      branch_outline_stale_reason: "node-renamed",
    });
    expect(states.get(child.id)).toMatchObject({
      synthesis_stale_at: null,
      branch_outline_stale_at: expect.any(Date),
      branch_outline_stale_reason: "node-renamed",
    });
    expect(states.get(secondRoot.id)?.synthesis_stale_at).toBeNull();
    expect(states.get(grandchild.id)?.synthesis_stale_at).toBeNull();

    await clearStaleness(userId);
    await createNodeForUser(userId, { title: "New leaf", parentId: child.id });
    states = await artifactStates(userId);
    for (const id of [firstRoot.id, child.id]) {
      expect(states.get(id)).toMatchObject({
        synthesis_stale_at: expect.any(Date),
        branch_outline_stale_reason: "branch-structure-changed",
      });
    }
    expect(states.get(grandchild.id)?.synthesis_stale_at).toBeNull();

    await clearStaleness(userId);
    await moveNodeForUser(userId, { id: child.id, parentId: secondRoot.id });
    states = await artifactStates(userId);
    for (const id of [firstRoot.id, secondRoot.id]) {
      expect(states.get(id)).toMatchObject({
        synthesis_stale_at: expect.any(Date),
        branch_outline_stale_reason: "branch-structure-changed",
      });
    }
    expect(states.get(child.id)?.synthesis_stale_at).toBeNull();

    await clearStaleness(userId);
    await archiveNodeForUser(userId, { id: child.id });
    states = await artifactStates(userId);
    for (const id of [secondRoot.id, child.id, grandchild.id]) {
      expect(states.get(id)).toMatchObject({
        synthesis_stale_at: expect.any(Date),
        branch_outline_stale_reason: "branch-availability-changed",
      });
    }
    expect(states.get(firstRoot.id)?.synthesis_stale_at).toBeNull();

    await clearStaleness(userId);
    await unarchiveNodeForUser(userId, { id: child.id });
    states = await artifactStates(userId);
    for (const id of [secondRoot.id, child.id]) {
      expect(states.get(id)).toMatchObject({
        synthesis_stale_at: expect.any(Date),
        branch_outline_stale_reason: "branch-availability-changed",
      });
    }
    expect(states.get(grandchild.id)?.synthesis_stale_at).toBeNull();

    await clearStaleness(userId);
    await deleteNodeForUser(userId, { id: child.id });
    states = await artifactStates(userId);
    expect(states.get(secondRoot.id)).toMatchObject({
      synthesis_stale_at: expect.any(Date),
      branch_outline_stale_reason: "branch-structure-changed",
    });
    expect(states.get(firstRoot.id)?.synthesis_stale_at).toBeNull();
    expect(states.has(child.id)).toBe(false);
    expect(states.has(grandchild.id)).toBe(false);
  });

  it("does not stale artifacts for idempotent tree mutation requests", async () => {
    const userId = await insertUser();
    const root = await createNodeForUser(userId, { title: "Stable root" });
    await installArtifacts(userId, root.id);

    await renameNodeForUser(userId, { id: root.id, title: "Stable root" });
    await moveNodeForUser(userId, { id: root.id, parentId: null, position: 0 });
    let state = (await artifactStates(userId)).get(root.id);
    expect(state).toMatchObject({
      synthesis_stale_at: null,
      branch_outline_stale_at: null,
      branch_outline_stale_reason: null,
    });

    await archiveNodeForUser(userId, { id: root.id });
    await clearStaleness(userId);
    await archiveNodeForUser(userId, { id: root.id });
    state = (await artifactStates(userId)).get(root.id);
    expect(state).toMatchObject({
      synthesis_stale_at: null,
      branch_outline_stale_at: null,
      branch_outline_stale_reason: null,
    });

    await unarchiveNodeForUser(userId, { id: root.id });
    await clearStaleness(userId);
    await unarchiveNodeForUser(userId, { id: root.id });
    state = (await artifactStates(userId)).get(root.id);
    expect(state).toMatchObject({
      synthesis_stale_at: null,
      branch_outline_stale_at: null,
      branch_outline_stale_reason: null,
    });
  });

  it("moves and reorders subtrees while keeping both sibling groups contiguous", async () => {
    const userId = await insertUser();
    const firstRoot = await createNodeForUser(userId, { title: "First" });
    const secondRoot = await createNodeForUser(userId, { title: "Second" });
    const thirdRoot = await createNodeForUser(userId, { title: "Third" });
    const child = await createNodeForUser(userId, { title: "Child", parentId: firstRoot.id });

    await moveNodeForUser(userId, { id: thirdRoot.id, parentId: null, position: 0 });
    expect((await siblingPositions(userId, null)).map(({ id }) => id)).toEqual([
      thirdRoot.id,
      firstRoot.id,
      secondRoot.id,
    ]);

    await moveNodeForUser(userId, { id: firstRoot.id, parentId: secondRoot.id, position: 0 });
    expect((await siblingPositions(userId, null)).map(({ position }) => position)).toEqual([0, 1]);
    expect((await siblingPositions(userId, secondRoot.id)).map(({ id }) => id)).toEqual([
      firstRoot.id,
    ]);

    const tree = await getNodeTreeForUser(userId);
    expect(tree.byId.get(child.id)?.breadcrumb.map(({ title }) => title)).toEqual([
      "Second",
      "First",
      "Child",
    ]);
  });

  it("rejects cycles, foreign parents, and positions that no longer exist", async () => {
    const userId = await insertUser();
    const otherUserId = await insertUser();
    const root = await createNodeForUser(userId, { title: "Root" });
    const child = await createNodeForUser(userId, { title: "Child", parentId: root.id });
    const otherRoot = await createNodeForUser(otherUserId, { title: "Other" });

    await expect(
      moveNodeForUser(userId, { id: root.id, parentId: child.id }),
    ).rejects.toEqual(new NodeMutationError("cycle"));
    await expect(
      moveNodeForUser(userId, { id: root.id, parentId: otherRoot.id }),
    ).rejects.toEqual(new NodeMutationError("parent-not-found"));
    await expect(
      moveNodeForUser(userId, { id: child.id, parentId: null, position: 4 }),
    ).rejects.toEqual(new NodeMutationError("invalid-position"));
  });

  it("redacts private query parameters from unexpected database failures", async () => {
    const userId = await insertUser();
    const privateTitle = `private-title-${"x".repeat(220)}`;

    let caught: unknown;
    try {
      await createNodeForUser(userId, { title: privateTitle });
    } catch (error) {
      caught = error;
    }

    expect(caught).toEqual(new NodeMutationError("unavailable"));
    expect(String(caught)).not.toContain(privateTitle);
    expect(caught).not.toHaveProperty("cause");
  });

  it("serializes concurrent root and child changes without gaps or duplicates", async () => {
    const userId = await insertUser();
    const [first, second, third] = await Promise.all([
      createNodeForUser(userId, { title: "First" }),
      createNodeForUser(userId, { title: "Second" }),
      createNodeForUser(userId, { title: "Third" }),
    ]);

    expect((await siblingPositions(userId, null)).map(({ position }) => position)).toEqual([
      0, 1, 2,
    ]);

    const destination = await createNodeForUser(userId, { title: "Destination" });
    await Promise.all([
      createNodeForUser(userId, { title: "Child one", parentId: destination.id }),
      createNodeForUser(userId, { title: "Child two", parentId: destination.id }),
      createNodeForUser(userId, { title: "Child three", parentId: destination.id }),
    ]);
    expect(
      (await siblingPositions(userId, destination.id)).map(({ position }) => position),
    ).toEqual([0, 1, 2]);

    await Promise.all([
      moveNodeForUser(userId, { id: first.id, parentId: destination.id }),
      moveNodeForUser(userId, { id: second.id, parentId: destination.id }),
    ]);

    expect((await siblingPositions(userId, null)).map(({ position }) => position)).toEqual([0, 1]);
    expect(
      (await siblingPositions(userId, destination.id)).map(({ position }) => position),
    ).toEqual([0, 1, 2, 3, 4]);
    expect((await siblingPositions(userId, null)).map(({ id }) => id)).toEqual(
      expect.arrayContaining([third.id, destination.id]),
    );
  });

  it("archives active subtree nodes while preserving earlier archive timestamps", async () => {
    const userId = await insertUser();
    const root = await createNodeForUser(userId, { title: "Root" });
    const child = await createNodeForUser(userId, { title: "Child", parentId: root.id });
    const grandchild = await createNodeForUser(userId, {
      title: "Grandchild",
      parentId: child.id,
    });
    const earlierArchive = new Date("2026-07-01T12:00:00.000Z");
    await pool.query(`update nodes set archived_at = $1 where id = $2`, [
      earlierArchive,
      grandchild.id,
    ]);

    await archiveNodeForUser(userId, { id: root.id });

    const result = await pool.query<{ id: string; archived_at: Date | null }>(
      `select id, archived_at from nodes where user_id = $1 order by id`,
      [userId],
    );
    const archivedAtById = new Map(
      result.rows.map((row) => [row.id, row.archived_at?.toISOString() ?? null]),
    );
    expect(archivedAtById.get(root.id)).not.toBeNull();
    expect(archivedAtById.get(child.id)).toBe(archivedAtById.get(root.id));
    expect(archivedAtById.get(grandchild.id)).toBe(earlierArchive.toISOString());
  });

  it("unarchives only the selected node and its archived ancestor path", async () => {
    const userId = await insertUser();
    const root = await createNodeForUser(userId, { title: "Root" });
    const child = await createNodeForUser(userId, { title: "Child", parentId: root.id });
    const grandchild = await createNodeForUser(userId, {
      title: "Grandchild",
      parentId: child.id,
    });
    await archiveNodeForUser(userId, { id: root.id });

    await unarchiveNodeForUser(userId, { id: child.id });

    const tree = await getNodeTreeForUser(userId);
    expect(tree.byId.get(root.id)?.archivedAt).toBeNull();
    expect(tree.byId.get(child.id)?.archivedAt).toBeNull();
    expect(tree.byId.get(grandchild.id)?.archivedAt).not.toBeNull();
  });

  it("rejects active creation or movement anywhere beneath an archived ancestor", async () => {
    const userId = await insertUser();
    const archivedRoot = await createNodeForUser(userId, { title: "Archived root" });
    const archivedChild = await createNodeForUser(userId, {
      title: "Archived child",
      parentId: archivedRoot.id,
    });
    const activeSource = await createNodeForUser(userId, { title: "Active source" });
    await archiveNodeForUser(userId, { id: archivedRoot.id });
    await pool.query(`update nodes set archived_at = null where id = $1`, [archivedChild.id]);

    await expect(
      createNodeForUser(userId, { title: "Blocked", parentId: archivedChild.id }),
    ).rejects.toEqual(new NodeMutationError("archived-parent"));
    await expect(
      moveNodeForUser(userId, { id: activeSource.id, parentId: archivedChild.id }),
    ).rejects.toEqual(new NodeMutationError("archived-parent"));

    await archiveNodeForUser(userId, { id: archivedChild.id });
    await expect(
      moveNodeForUser(userId, { id: archivedChild.id, parentId: activeSource.id }),
    ).resolves.toMatchObject({ parentId: activeSource.id, archivedAt: expect.any(String) });
  });

  it("serializes archive with movement without leaving active nodes under an archive", async () => {
    const userId = await insertUser();
    const destination = await createNodeForUser(userId, { title: "Destination" });
    const source = await createNodeForUser(userId, { title: "Source" });

    const [archiveResult, moveResult] = await Promise.allSettled([
      archiveNodeForUser(userId, { id: destination.id }),
      moveNodeForUser(userId, { id: source.id, parentId: destination.id }),
    ]);

    expect(archiveResult.status).toBe("fulfilled");
    if (moveResult.status === "rejected") {
      expect(moveResult.reason).toEqual(new NodeMutationError("archived-parent"));
    }
    const tree = await getNodeTreeForUser(userId);
    const storedSource = tree.byId.get(source.id);
    if (storedSource?.parentId === destination.id) {
      expect(storedSource.archivedAt).not.toBeNull();
    }
  });

  it("does not distinguish foreign archive lifecycle targets from missing nodes", async () => {
    const userId = await insertUser();
    const otherUserId = await insertUser();
    const foreign = await createNodeForUser(otherUserId, { title: "Foreign" });
    const missingNodeId = randomUUID();

    await expect(archiveNodeForUser(userId, { id: foreign.id })).rejects.toEqual(
      new NodeMutationError("node-not-found"),
    );
    await expect(archiveNodeForUser(userId, { id: missingNodeId })).rejects.toEqual(
      new NodeMutationError("node-not-found"),
    );
    await expect(unarchiveNodeForUser(userId, { id: foreign.id })).rejects.toEqual(
      new NodeMutationError("node-not-found"),
    );
  });

  it("permanently deletes only the owned subtree and closes its sibling gap", async () => {
    const userId = await insertUser();
    const otherUserId = await insertUser();
    const first = await createNodeForUser(userId, { title: "First" });
    const doomed = await createNodeForUser(userId, { title: "Doomed" });
    const third = await createNodeForUser(userId, { title: "Third" });
    const child = await createNodeForUser(userId, {
      title: "Doomed child",
      parentId: doomed.id,
    });
    const grandchild = await createNodeForUser(userId, {
      title: "Doomed grandchild",
      parentId: child.id,
    });

    await expect(deleteNodeForUser(otherUserId, { id: doomed.id })).rejects.toEqual(
      new NodeMutationError("node-not-found"),
    );
    await expect(deleteNodeForUser(userId, { id: doomed.id })).resolves.toEqual({
      nodeId: doomed.id,
      parentId: null,
      recoveryNodeId: third.id,
    });

    expect(await siblingPositions(userId, null)).toEqual([
      { id: first.id, position: 0 },
      { id: third.id, position: 1 },
    ]);
    const deletedRows = await pool.query<{ id: string }>(
      `select id from nodes where id = any($1::uuid[])`,
      [[doomed.id, child.id, grandchild.id]],
    );
    expect(deletedRows.rows).toEqual([]);
  });

  it("serializes subtree deletion with movement without partial trees or order gaps", async () => {
    const userId = await insertUser();
    const doomed = await createNodeForUser(userId, { title: "Doomed root" });
    const child = await createNodeForUser(userId, {
      title: "Movable child",
      parentId: doomed.id,
    });
    const destination = await createNodeForUser(userId, { title: "Destination" });
    const survivor = await createNodeForUser(userId, { title: "Survivor" });

    const [deleteResult, moveResult] = await Promise.allSettled([
      deleteNodeForUser(userId, { id: doomed.id }),
      moveNodeForUser(userId, { id: child.id, parentId: destination.id }),
    ]);

    expect(deleteResult).toEqual({
      status: "fulfilled",
      value: {
        nodeId: doomed.id,
        parentId: null,
        recoveryNodeId: destination.id,
      },
    });
    const tree = await getNodeTreeForUser(userId);
    expect(tree.byId.has(doomed.id)).toBe(false);
    if (moveResult.status === "fulfilled") {
      expect(tree.byId.get(child.id)?.parentId).toBe(destination.id);
    } else {
      expect(moveResult.reason).toEqual(new NodeMutationError("node-not-found"));
      expect(tree.byId.has(child.id)).toBe(false);
    }
    expect(await siblingPositions(userId, null)).toEqual([
      { id: destination.id, position: 0 },
      { id: survivor.id, position: 1 },
    ]);
  });
});
