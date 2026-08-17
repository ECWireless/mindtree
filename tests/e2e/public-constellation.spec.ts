import { createHash, randomBytes, randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";
import { Pool } from "pg";

import { seedBrowserSession } from "./support/auth";

const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL or DATABASE_URL_UNPOOLED is required for browser tests.");
}

const pool = new Pool({ connectionString });

test("keeps the shared constellation scoped, read-only, and URL-persistent", async ({
  page,
}, testInfo) => {
  const seeded = await seedBrowserSession(pool, {
    email: `public-constellation-${randomUUID()}@example.test`,
  });
  const rootId = randomUUID();
  const childId = randomUUID();
  const archivedChildId = randomUUID();
  const privateRootId = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  const digest = createHash("sha256").update(secret, "utf8").digest("hex");

  try {
    await pool.query(
      `insert into nodes (id, user_id, parent_id, position, title)
       values
         ($1, $4, null, 0, 'Shared root'),
         ($2, $4, $1, 0, 'Shared child'),
         ($3, $4, null, 1, 'Private root')`,
      [rootId, childId, privateRootId, seeded.userId],
    );
    await pool.query(
      `insert into nodes (id, user_id, parent_id, position, title, archived_at)
       values ($1, $2, $3, 1, 'Archived child', now())`,
      [archivedChildId, seeded.userId, rootId],
    );
    await pool.query(
      `insert into branch_share_links (user_id, root_node_id, secret_digest)
       values ($1, $2, $3)`,
      [seeded.userId, rootId, digest],
    );

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`/share/${secret}?node=${childId}&view=constellation`);

    await expect(page).toHaveURL(new RegExp(`node=${childId}&view=constellation$`));
    await expect(page.getByRole("link", { name: "Constellation", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.locator("#constellation-heading")).toHaveText("Thought Constellation");
    await expect(
      page.getByRole("group", { name: "2 thought node constellation" }),
    ).toBeVisible();
    await expect(page.locator(".constellation-node")).toHaveCount(2);
    await expect(
      page.getByRole("button", { name: "Shared root: Shared thought" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "Shared root / Shared child: Shared thought",
      }),
    ).toBeVisible();
    const selectedCard = page.getByRole("complementary", {
      name: "Shared child constellation details",
    });
    await expect(selectedCard).toBeVisible();
    const selectedCardBox = await selectedCard.boundingBox();
    const viewport = page.viewportSize();
    if (!selectedCardBox || !viewport) {
      throw new Error("The public constellation card and viewport must be measurable.");
    }
    expect(selectedCardBox.y + selectedCardBox.height).toBeLessThanOrEqual(
      viewport.height + 1,
    );

    await expect(page.getByText("Private root")).toHaveCount(0);
    await expect(page.getByText("Archived child")).toHaveCount(0);
    await expect(page.locator(".constellation-node--archived")).toHaveCount(0);
    await expect(page.locator(".status-pill")).toHaveCount(0);
    await expect(page.getByText("Open in tree")).toHaveCount(0);
    await expect(page.getByText("Summary published")).toHaveCount(0);
    await expect(page.getByText("Show archived thoughts")).toHaveCount(0);
    await expect(page.getByText("Create your first root thought")).toHaveCount(0);
    await expect(page.getByText("Chat", { exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "Shared root: Shared thought" }).click();
    await expect(page).toHaveURL(new RegExp(`node=${rootId}&view=constellation$`));
    await expect(
      page.getByRole("complementary", { name: "Shared root constellation details" }),
    ).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("public-constellation")).toBeVisible();
    const childBubble = page.getByRole("button", {
      name: "Shared root / Shared child: Shared thought",
    });
    await childBubble.focus();
    await childBubble.press("Enter");
    await expect(page).toHaveURL(new RegExp(`node=${childId}&view=constellation$`));
    const readThought = page.getByRole("link", { name: "Read thought" });
    await expect(readThought).toBeFocused();
    await readThought.click();
    await expect(page).toHaveURL(new RegExp(`node=${childId}$`));
    await expect(page.getByRole("heading", { level: 2, name: "Shared child" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Trail" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    await page.getByRole("link", { name: "Constellation", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`node=${childId}&view=constellation$`));
    await expect(page.getByTestId("public-constellation")).toBeVisible();

    if (testInfo.project.name === "desktop") {
      await page.setViewportSize({ width: 1_024, height: 500 });
      const shortViewportCard = page.getByRole("complementary", {
        name: "Shared child constellation details",
      });
      await expect(shortViewportCard).toBeVisible();
      const shortViewportCardBox = await shortViewportCard.boundingBox();
      if (!shortViewportCardBox) {
        throw new Error("The short-height constellation card must be measurable.");
      }
      expect(shortViewportCardBox.y + shortViewportCardBox.height).toBeLessThanOrEqual(501);
    }
  } finally {
    await seeded.cleanup();
  }
});

test.afterAll(async () => {
  await pool.end();
});
