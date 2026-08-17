import { createHash, randomBytes, randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";
import { Pool } from "pg";

import { seedBrowserSession } from "./support/auth";

const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL or DATABASE_URL_UNPOOLED is required for browser tests.");
}

const pool = new Pool({ connectionString });

async function expectNoHorizontalOverflow(page: Page) {
  const widths = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(widths.scrollWidth).toBeLessThanOrEqual(widths.clientWidth + 1);
}

test("wraps long titles throughout a deep shared trail", async ({ page }) => {
  const seeded = await seedBrowserSession(pool, {
    email: `public-title-wrapping-${randomUUID()}@example.test`,
  });
  const nodeIds = Array.from({ length: 24 }, () => randomUUID());
  const rootTitle = `Root thought ${"r".repeat(185)}`;
  const deepestTitle = `Deepest thought ${"x".repeat(180)}`;
  const titles = nodeIds.map((_, index) => {
    if (index === 0) return rootTitle;
    if (index === nodeIds.length - 1) return deepestTitle;
    return `Depth ${index + 1}`;
  });
  const parentIds = nodeIds.map((_, index) => index === 0 ? null : nodeIds[index - 1]);
  const positions = nodeIds.map(() => 0);
  const userIds = nodeIds.map(() => seeded.userId);
  const secret = randomBytes(32).toString("base64url");
  const digest = createHash("sha256").update(secret, "utf8").digest("hex");

  try {
    await pool.query(
      `insert into nodes (id, user_id, parent_id, position, title)
       select * from unnest($1::uuid[], $2::text[], $3::uuid[], $4::integer[], $5::text[])`,
      [nodeIds, userIds, parentIds, positions, titles],
    );
    await pool.query(
      `insert into branch_share_links (user_id, root_node_id, secret_digest)
       values ($1, $2, $3)`,
      [seeded.userId, nodeIds[0], digest],
    );

    await page.goto(`/share/${secret}?node=${nodeIds.at(-1)}`);
    await expect(page.getByText("24 thoughts")).toBeVisible();
    await expect(page.locator(".public-trail-tree__link")).toHaveCount(24);
    await expect(page.getByRole("heading", { level: 2, name: rootTitle }).first())
      .toBeVisible();
    await expect(
      page.getByRole("link", { name: new RegExp(`Level 24\\. ${deepestTitle}`) }),
    ).toHaveAttribute("aria-current", "page");
    await expect(
      page.getByRole("heading", { level: 2, name: deepestTitle }).last(),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page.getByRole("link", { name: new RegExp(`Level 1\\. ${rootTitle}`) }).click();
    await expect(page).toHaveURL(new RegExp(`node=${nodeIds[0]}$`));
    await expect(
      page.getByRole("heading", { level: 2, name: rootTitle }).last(),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);
  } finally {
    await seeded.cleanup();
  }
});

test.afterAll(async () => {
  await pool.end();
});
