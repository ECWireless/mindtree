import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";
import { Pool } from "pg";

import {
  installBrowserSessionCookie,
  seedBrowserSession,
} from "./support/auth";

const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL or DATABASE_URL_UNPOOLED is required for browser tests.");
}

const pool = new Pool({ connectionString });

test.afterAll(async () => {
  await pool.end();
});

test("creates and navigates a responsive thought hierarchy", async ({ context, page }, testInfo) => {
  const seeded = await seedBrowserSession(pool);

  try {
    await installBrowserSessionCookie(context, seeded.cookie);
    await page.goto("/");

    await page.getByRole("button", { name: "New root" }).click();
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByText("Enter a title.", { exact: true })).toBeVisible();
    await page.getByPlaceholder("Root thought").fill("Systems thinking");
    await page.getByRole("button", { name: "Add", exact: true }).click();

    await expect(page).toHaveURL(/\?node=[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { level: 1, name: "Systems thinking" })).toBeVisible();

    const addChild = page.getByRole("button", { name: "Add child", exact: true });
    await addChild.click();
    await page.getByPlaceholder("Child thought").press("Escape");
    await expect(addChild).toBeFocused();
    await addChild.click();
    await page.getByPlaceholder("Child thought").fill("Feedback loops");
    await page.getByRole("button", { name: "Add", exact: true }).click();

    await expect(page.getByRole("heading", { level: 1, name: "Feedback loops" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText(
      "Systems thinking",
    );

    await page.getByRole("button", { name: "Edit title" }).click();
    await page.getByRole("textbox", { name: "Thought title" }).press("Escape");
    await expect(page.getByRole("button", { name: "Edit title" })).toBeFocused();
    await page.getByRole("button", { name: "Edit title" }).click();
    await page.getByRole("textbox", { name: "Thought title" }).fill("Reinforcing loops");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Reinforcing loops" })).toBeVisible();

    if (testInfo.project.name !== "mobile") {
      await page.getByRole("button", { name: "Collapse Systems thinking" }).click();
      await expect(page.getByRole("link", { name: /Reinforcing loops/ })).toHaveCount(0);
      await page.getByRole("button", { name: "Expand Systems thinking" }).click();
    }

    await page
      .getByRole("navigation", { name: "Breadcrumb" })
      .getByRole("link", { name: "Systems thinking" })
      .click();
    await expect(page.getByRole("heading", { level: 1, name: "Systems thinking" })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole("heading", { level: 1, name: "Reinforcing loops" })).toBeVisible();
    await page.goForward();
    await expect(page.getByRole("heading", { level: 1, name: "Systems thinking" })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole("heading", { level: 1, name: "Reinforcing loops" })).toBeVisible();

    if (testInfo.project.name === "mobile") {
      await page.getByRole("link", { name: "Back to thoughts" }).click();
      await expect(page).toHaveURL("/");
      const expandRoot = page.getByRole("button", { name: "Expand Systems thinking" });
      if (await expandRoot.count()) {
        await expandRoot.click();
      }
      await expect(page.getByRole("link", { name: /Reinforcing loops/ })).toBeVisible();
      await page.getByRole("button", { name: "Collapse Systems thinking" }).click();
      await expect(page.getByRole("link", { name: /Reinforcing loops/ })).toHaveCount(0);
      await page.getByRole("button", { name: "Expand Systems thinking" }).click();
      await page.getByRole("link", { name: /Reinforcing loops/ }).click();
      await expect(page).toHaveURL(/\?node=[0-9a-f-]{36}$/);
    }

    const dimensions = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);

    const enabledButtonCursors = await page
      .locator("button:not(:disabled)")
      .evaluateAll((buttons) => buttons.map((button) => getComputedStyle(button).cursor));
    expect(enabledButtonCursors.every((cursor) => cursor === "pointer")).toBe(true);
  } finally {
    await seeded.cleanup();
  }
});

test("keeps deep long-title rows and breadcrumbs within the viewport", async ({ context, page }, testInfo) => {
  const seeded = await seedBrowserSession(pool);
  const titles = Array.from(
    { length: 13 },
    (_, index) => `Depth-${index}-${"unbrokentitle".repeat(12)}`,
  );
  const ids = titles.map(() => randomUUID());
  const deepestTitle = titles[titles.length - 1];

  try {
    for (let index = 0; index < ids.length; index += 1) {
      await pool.query(
        `insert into nodes (id, user_id, parent_id, position, title)
         values ($1, $2, $3, 0, $4)`,
        [ids[index], seeded.userId, index === 0 ? null : ids[index - 1], titles[index]],
      );
    }

    await installBrowserSessionCookie(context, seeded.cookie);
    if (testInfo.project.name === "mobile") {
      await page.setViewportSize({ width: 320, height: 812 });
    }
    await page.goto("/");

    for (const title of titles.slice(0, -1)) {
      const expander = page.getByRole("button", { name: `Expand ${title}` });
      await expander.focus();
      await expander.press("Enter");
    }

    const deepestLink = page.getByRole("link").filter({ hasText: deepestTitle });
    await expect(deepestLink).toBeVisible();
    const addChildButton = page.getByRole("button", { name: `Add child to ${deepestTitle}` });
    await addChildButton.focus();
    await addChildButton.press("Enter");
    const childTitleInput = page.getByPlaceholder("Child thought");
    await expect(childTitleInput).toBeVisible();

    const deepestLinkBox = await deepestLink.boundingBox();
    const childTitleInputBox = await childTitleInput.boundingBox();
    if (!deepestLinkBox || !childTitleInputBox) {
      throw new Error("Deep row and child input must have measurable layout boxes.");
    }
    expect(deepestLinkBox.width).toBeGreaterThanOrEqual(64);
    expect(Math.abs(childTitleInputBox.x - deepestLinkBox.x)).toBeLessThanOrEqual(2);

    let dimensions = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);

    await childTitleInput.press("Escape");
    await addChildButton.hover();
    await expect.poll(() =>
      addChildButton.evaluate((button) => getComputedStyle(button, "::after").opacity),
    ).toBe("1");
    const tooltipStyle = await addChildButton.evaluate((button) => {
      const style = getComputedStyle(button, "::after");
      return { bottom: style.bottom, overflowWrap: style.overflowWrap, top: style.top };
    });
    expect(tooltipStyle.bottom).not.toBe("auto");
    expect(tooltipStyle.overflowWrap).toBe("anywhere");
    expect(Number.parseFloat(tooltipStyle.top)).toBeLessThan(0);

    dimensions = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);

    await deepestLink.click();
    await expect(page.getByRole("heading", { level: 1, name: deepestTitle })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText(titles[0]);

    dimensions = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
  } finally {
    await seeded.cleanup();
  }
});
