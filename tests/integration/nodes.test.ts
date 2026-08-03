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
let getNodeTreeForUser: typeof import(
  "../../src/lib/server/node-service"
).getNodeTreeForUser;
let moveNodeForUser: typeof import("../../src/lib/server/node-service").moveNodeForUser;
let NodeMutationError: typeof import("../../src/lib/server/node-service").NodeMutationError;
let renameNodeForUser: typeof import(
  "../../src/lib/server/node-service"
).renameNodeForUser;

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

describe("owner-scoped node service", () => {
  beforeAll(async () => {
    ({
      createNodeForUser,
      getNodeTreeForUser,
      moveNodeForUser,
      NodeMutationError,
      renameNodeForUser,
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
});
