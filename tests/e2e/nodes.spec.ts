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

    const toolbarCount = page.locator(".toolbar-count");
    const toolbarSearch = page.locator(".tree-search");
    const toolbarActions = page.locator(".toolbar-actions");
    const newRoot = page.getByRole("button", { name: "New root thought" });
    const showArchived = page.getByRole("button", { name: "Show archived" });
    await expect(toolbarCount).toHaveText("0 nodes");
    await expect(newRoot).toHaveAttribute("data-tooltip", "New root thought");
    await expect(showArchived).toHaveAttribute("data-tooltip", "Show archived");
    await expect(showArchived).toBeEnabled();
    if (testInfo.project.name !== "mobile") {
      await expect(toolbarCount).toBeVisible();
      const countColor = await toolbarCount.locator(".eyebrow").evaluate(
        (element) => getComputedStyle(element).color,
      );
      expect(countColor).toBe("rgb(250, 243, 14)");
      const countBox = await toolbarCount.boundingBox();
      const searchBox = await toolbarSearch.boundingBox();
      const actionsBox = await toolbarActions.boundingBox();
      if (!countBox || !searchBox || !actionsBox) {
        throw new Error("Toolbar count, search, and actions must have measurable layout boxes.");
      }
      expect(countBox.x).toBeLessThan(searchBox.x);
      expect(actionsBox.x - (searchBox.x + searchBox.width)).toBeLessThanOrEqual(17);
    } else {
      await expect(toolbarCount).toBeHidden();
      const searchBox = await toolbarSearch.boundingBox();
      const actionsBox = await toolbarActions.boundingBox();
      if (!searchBox || !actionsBox) {
        throw new Error("Mobile toolbar search and actions must have measurable layout boxes.");
      }
      expect(Math.abs(actionsBox.y - searchBox.y)).toBeLessThanOrEqual(1);
    }

    await newRoot.hover();
    await expect.poll(() =>
      newRoot.evaluate((button) => getComputedStyle(button, "::after").opacity),
    ).toBe("1");
    await newRoot.click();
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByText("Enter a title.", { exact: true })).toBeVisible();
    await page.getByPlaceholder("Root thought").fill("Systems thinking");
    await page.getByRole("button", { name: "Add", exact: true }).click();

    await expect(page).toHaveURL(/\?node=[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { level: 1, name: "Systems thinking" })).toBeVisible();
    await expect(toolbarCount).toHaveText("1 node");

    const addChild = page.getByRole("button", { name: "Add child", exact: true });
    await addChild.click();
    const childThought = page.getByPlaceholder("Child thought");
    if (testInfo.project.name !== "mobile") {
      await expect(page.locator(".tree-pane").getByPlaceholder("Child thought")).toBeVisible();
      await expect(page.locator(".detail-pane").getByPlaceholder("Child thought")).toHaveCount(0);
    } else {
      await expect(page.locator(".detail-pane").getByPlaceholder("Child thought")).toBeVisible();
      await expect(page.locator(".tree-pane").getByPlaceholder("Child thought")).toHaveCount(0);
    }
    await childThought.press("Escape");
    await expect(addChild).toBeFocused();
    await addChild.click();
    await childThought.fill("Feedback loops");
    await page.getByRole("button", { name: "Add", exact: true }).click();

    await expect(page.getByRole("heading", { level: 1, name: "Feedback loops" })).toBeVisible();
    await expect(toolbarCount).toHaveText("2 nodes");
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
      await addChild.click();
      await expect(page.locator(".tree-pane").getByPlaceholder("Child thought")).toBeVisible();
      await page.getByPlaceholder("Child thought").press("Escape");
      await expect(addChild).toBeFocused();
      await page.getByRole("button", { name: "Collapse Systems thinking" }).click();
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

    if (testInfo.project.name !== "mobile") {
      await newRoot.click();
      const rootThought = page.getByPlaceholder("Root thought");
      await expect(rootThought).toBeVisible();
      await rootThought.press("Escape");
      await expect(newRoot).toBeFocused();
    }

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

test("archives a subtree, reveals it, and unarchives only a reachable path", async ({
  context,
  page,
}, testInfo) => {
  const seeded = await seedBrowserSession(pool);
  const rootId = randomUUID();
  const childId = randomUUID();
  const grandchildId = randomUUID();

  try {
    await pool.query(
      `insert into nodes (id, user_id, parent_id, position, title)
       values ($1, $4, null, 0, 'Archive root'),
              ($2, $4, $1, 0, 'Archive child'),
              ($3, $4, $2, 0, 'Archive grandchild')`,
      [rootId, childId, grandchildId, seeded.userId],
    );
    await installBrowserSessionCookie(context, seeded.cookie);
    await page.goto(`/?node=${rootId}`);

    const archivedToggle = page.getByRole("button", { name: "Show archived" });
    const archiveButton = page.getByRole("button", { name: "Archive", exact: true });
    await expect(archiveButton).toHaveAttribute("data-tooltip", "Archive thought");
    await archiveButton.focus();
    await expect.poll(() =>
      archiveButton.evaluate((button) => getComputedStyle(button, "::after").opacity),
    ).toBe("1");
    await archiveButton.click();
    await expect(
      page.getByRole("status").filter({ hasText: "Archive root archived." }),
    ).toBeVisible();
    await expect(page.locator(".node-status-line")).toHaveText("Archived");
    await expect(page.getByRole("button", { name: "Add child", exact: true })).toHaveCount(0);
    if (testInfo.project.name === "mobile") {
      await page.getByRole("link", { name: "Back to thoughts" }).click();
      await expect(page.getByRole("link", { name: /Archive root/ })).toBeVisible();
    }
    await expect(archivedToggle).toHaveAttribute("aria-pressed", "true");
    await expect(archivedToggle).toHaveAttribute("data-tooltip", "Hide archived");

    await archivedToggle.click();
    await expect(page).toHaveURL("/");
    await expect(page.getByText("No active thoughts.", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: /Archive root/ })).toHaveCount(0);

    await page.getByRole("button", { name: "Show archived thoughts" }).click();
    await expect(page.getByRole("link", { name: /Archive root/ })).toBeVisible();
    await page.getByRole("button", { name: "Expand Archive root" }).click();
    await page.getByRole("link", { name: /Archive child/ }).click();
    const unarchiveButton = page.getByRole("button", { name: "Unarchive", exact: true });
    await expect(unarchiveButton).toHaveAttribute("data-tooltip", "Unarchive thought");
    await unarchiveButton.click();
    await expect(page.getByText("Active", { exact: true })).toBeVisible();

    if (testInfo.project.name === "mobile") {
      await page.getByRole("link", { name: "Back to thoughts" }).click();
    }
    const toggleAfterUnarchive = page.getByRole("button", { name: "Show archived" });
    await expect(toggleAfterUnarchive).toHaveAttribute("aria-pressed", "true");
    await toggleAfterUnarchive.click();
    const expandRoot = page.getByRole("button", { name: "Expand Archive root" });
    if (await expandRoot.count()) {
      await expandRoot.click();
    }
    await expect(page.getByRole("link", { name: /Archive child/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /Archive grandchild/ })).toHaveCount(0);

    await page.getByRole("combobox", { name: "Search thought titles" }).fill("grandchild");
    const archivedSearchResult = page.getByRole("option", {
      name: /Archive grandchild.*Archived/,
    });
    await expect(archivedSearchResult).toBeVisible();
    await archivedSearchResult.click();
    await expect(page).toHaveURL(`/?node=${grandchildId}`);
    await expect(page.locator(".node-status-line")).toHaveText("Archived");
    if (testInfo.project.name === "mobile") {
      await page.getByRole("link", { name: "Back to thoughts" }).click();
    }
    await expect(page.getByRole("button", { name: "Show archived" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    const rows = await pool.query<{ id: string; archived_at: Date | null }>(
      `select id, archived_at from nodes where user_id = $1 order by id`,
      [seeded.userId],
    );
    const archivedAtById = new Map(rows.rows.map((row) => [row.id, row.archived_at]));
    expect(archivedAtById.get(rootId)).toBeNull();
    expect(archivedAtById.get(childId)).toBeNull();
    expect(archivedAtById.get(grandchildId)).toBeInstanceOf(Date);
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
    const dragHandle = deepestLink.locator("..").locator(".node-drag-handle");
    await dragHandle.hover();
    await expect.poll(() =>
      dragHandle.evaluate((handle) => getComputedStyle(handle, "::after").opacity),
    ).toBe("1");
    dimensions = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);

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

test("searches the tree and moves a thought through the accessible dialog", async ({ context, page }, testInfo) => {
  const seeded = await seedBrowserSession(pool);
  const systemsId = randomUUID();
  const feedbackId = randomUUID();
  const researchId = randomUUID();
  const sharedSystemsId = randomUUID();
  const sharedResearchId = randomUUID();
  const archivedDestinationId = randomUUID();
  const searchOptionIds = Array.from({ length: 14 }, () => randomUUID());

  try {
    await pool.query(
      `insert into nodes (id, user_id, parent_id, position, title)
       values ($1, $6, null, 0, 'Systems map'),
              ($2, $6, $1, 0, 'Feedback loops'),
              ($3, $6, null, 1, 'Research notes'),
              ($4, $6, $1, 1, 'Shared target'),
              ($5, $6, $3, 0, 'Shared target')`,
      [systemsId, feedbackId, researchId, sharedSystemsId, sharedResearchId, seeded.userId],
    );
    for (const [index, id] of searchOptionIds.entries()) {
      await pool.query(
        `insert into nodes (id, user_id, parent_id, position, title)
         values ($1, $2, null, $3, $4)`,
        [id, seeded.userId, index + 2, `Search option ${index + 1}`],
      );
    }
    await pool.query(
      `insert into nodes (id, user_id, parent_id, position, title, archived_at)
       values ($1, $2, null, 16, 'Archived shelf', now())`,
      [archivedDestinationId, seeded.userId],
    );

    await installBrowserSessionCookie(context, seeded.cookie);
    await page.goto("/");

    const search = page.getByRole("combobox", { name: "Search thought titles" });
    await expect(search).toHaveAttribute("aria-expanded", "false");
    const searchResults = page.locator(".search-results");
    await search.fill("search option");
    await expect(page.locator("#tree-search-status")).toContainText("14 results available.");
    for (let index = 0; index < 12; index += 1) {
      await search.press("ArrowDown");
    }
    const activeOptionId = await search.getAttribute("aria-activedescendant");
    const activeOption = page.locator(`#${activeOptionId}`);
    const resultsBox = await searchResults.boundingBox();
    const activeOptionBox = await activeOption.boundingBox();
    if (!resultsBox || !activeOptionBox) {
      throw new Error("Active search option and results popup must have measurable layout boxes.");
    }
    expect(activeOptionBox.y).toBeGreaterThanOrEqual(resultsBox.y);
    expect(activeOptionBox.y + activeOptionBox.height).toBeLessThanOrEqual(
      resultsBox.y + resultsBox.height + 1,
    );
    await search.press("Escape");
    await expect(search).toHaveAttribute("aria-expanded", "false");

    await search.fill("FEEDBACK");
    await expect(search).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#tree-search-status")).toContainText("1 result available.");
    const feedbackOption = searchResults.getByRole("option", { name: /Feedback loops/ });
    await expect(feedbackOption).toBeVisible();
    await expect(feedbackOption).toContainText(
      "Systems map / Feedback loops",
    );
    await search.press("ArrowDown");
    await expect(feedbackOption).toHaveAttribute("aria-selected", "true");
    await search.press("Enter");

    await expect(page).toHaveURL(new RegExp(`\\?node=${feedbackId}$`));
    await expect(page.getByRole("heading", { level: 1, name: "Feedback loops" })).toBeVisible();
    if (testInfo.project.name !== "mobile") {
      await expect(page.getByRole("link", { name: /Feedback loops/ })).toBeFocused();
    } else {
      await expect(page.getByRole("heading", { level: 1, name: "Feedback loops" })).toBeFocused();
    }

    const moveTrigger = page.getByRole("button", { name: "Move To…" });
    await expect(moveTrigger).toHaveAttribute("data-tooltip", "Move To…");
    await moveTrigger.click();
    const dialog = page.getByRole("dialog", { name: /Choose a new location for Feedback loops/ });
    await expect(dialog.getByRole("searchbox", { name: "Search destinations" })).toBeFocused();
    await expect(dialog.locator(".move-browser__toolbar")).toContainText("Systems map");
    const closeMoveDialog = dialog.getByRole("button", { name: "Close move dialog" });
    await expect(closeMoveDialog).toHaveAttribute("data-tooltip", "Close");
    await page.keyboard.press("Escape");
    await expect(moveTrigger).toBeFocused();

    await moveTrigger.click();
    await dialog.getByRole("button", { name: "Up one level" }).click();
    await expect(dialog.locator(".move-browser__toolbar")).toContainText("Root");
    await expect(dialog.getByRole("button", { name: "Move here" })).toBeFocused();
    await dialog.getByRole("button", { name: "Browse Archived shelf" }).click();
    await expect(dialog.getByRole("button", { name: "Move here" })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Up one level" })).toBeFocused();
    await dialog.getByRole("button", { name: "Up one level" }).click();
    await expect(dialog.getByRole("button", { name: "Move here" })).toBeFocused();
    const moveSearch = dialog.getByRole("searchbox", { name: "Search destinations" });
    await moveSearch.fill("shared target");
    const moveSearchResults = dialog.locator('[aria-label="Search move destinations"]');
    await expect(moveSearchResults.getByRole("button", { name: /Systems map \/ Shared target/ })).toBeVisible();
    await expect(moveSearchResults.getByRole("button", { name: /Research notes \/ Shared target/ })).toBeVisible();
    await moveSearch.fill("");
    await dialog
      .getByRole("button", { name: "Choose placement relative to Research notes" })
      .click();
    await expect(dialog.getByRole("button", { name: "Move before Research notes" })).toBeFocused();
    await dialog.getByRole("button", { name: "Back to destinations" }).click();
    await expect(dialog.getByRole("button", { name: "Move here" })).toBeFocused();
    if (testInfo.project.name === "mobile") {
      await page.setViewportSize({ width: 667, height: 320 });
    }
    await dialog.getByRole("searchbox", { name: "Search destinations" }).fill("research");
    await dialog
      .locator('[aria-label="Search move destinations"]')
      .getByRole("button", { name: /Research notes/ })
      .click();
    await dialog.getByRole("button", { name: "Back to destinations" }).click();
    await expect(dialog.getByRole("searchbox", { name: "Search destinations" })).toBeFocused();
    await dialog
      .locator('[aria-label="Search move destinations"]')
      .getByRole("button", { name: /Research notes/ })
      .click();
    const insideResearch = dialog.getByRole("button", { name: "Move inside Research notes" });
    await insideResearch.scrollIntoViewIfNeeded();
    await expect(insideResearch).toBeVisible();
    await page.route("**/*", async (route) => {
      if (route.request().method() === "POST") {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      await route.continue();
    });
    await insideResearch.click();
    await expect(dialog).toHaveAttribute("aria-busy", "true");
    await expect(dialog.locator(".dialog-status")).toHaveText("Moving thought…");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveCount(0);
    await page.unroute("**/*");
    if (testInfo.project.name === "mobile") {
      await page.setViewportSize({ width: 375, height: 812 });
    }
    await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText(
      "Research notes",
    );

    await expect.poll(async () => {
      const result = await pool.query<{ parent_id: string | null; position: number }>(
        `select parent_id, position from nodes where id = $1`,
        [feedbackId],
      );
      return result.rows[0];
    }).toEqual({ parent_id: researchId, position: 1 });

    await moveTrigger.click();
    await dialog.getByRole("searchbox", { name: "Search destinations" }).fill("systems");
    await dialog
      .locator('[aria-label="Search move destinations"]')
      .getByRole("button", { name: /Systems map/ })
      .click();
    const beforeSystems = dialog.getByRole("button", { name: "Move before Systems map" });
    await beforeSystems.focus();
    await beforeSystems.press("Enter");
    await expect.poll(async () => {
      const result = await pool.query<{ id: string }>(
        `select id from nodes where user_id = $1 and parent_id is null order by position`,
        [seeded.userId],
      );
      return result.rows.map(({ id }) => id);
    }).toEqual([feedbackId, systemsId, researchId, ...searchOptionIds, archivedDestinationId]);

    await moveTrigger.click();
    await dialog.getByRole("searchbox", { name: "Search destinations" }).fill("research");
    await dialog
      .locator('[aria-label="Search move destinations"]')
      .getByRole("button", { name: /Research notes/ })
      .click();
    const afterResearch = dialog.getByRole("button", { name: "Move after Research notes" });
    await afterResearch.focus();
    await afterResearch.press("Enter");
    await expect.poll(async () => {
      const result = await pool.query<{ id: string }>(
        `select id from nodes where user_id = $1 and parent_id is null order by position`,
        [seeded.userId],
      );
      return result.rows.map(({ id }) => id);
    }).toEqual([systemsId, researchId, feedbackId, ...searchOptionIds, archivedDestinationId]);
  } finally {
    await seeded.cleanup();
  }
});

test("moves a root with pointer drag-and-drop before, inside, and after targets", async ({ context, page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "Pointer drag coverage runs in the desktop project.");
  const seeded = await seedBrowserSession(pool);
  const firstId = randomUUID();
  const secondId = randomUUID();
  const thirdId = randomUUID();
  const secondChildId = randomUUID();

  try {
    await pool.query(
      `insert into nodes (id, user_id, parent_id, position, title)
       values ($1, $5, null, 0, 'First root'),
              ($2, $5, null, 1, 'Second root'),
              ($3, $5, null, 2, 'Third root'),
              ($4, $5, $2, 0, 'Existing child')`,
      [firstId, secondId, thirdId, secondChildId, seeded.userId],
    );

    await installBrowserSessionCookie(context, seeded.cookie);
    await page.goto("/");

    async function settleDragUi() {
      await page.evaluate(
        () => new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
      );
    }

    async function dragTo(
      targetTitle: string,
      targetFraction: number,
      expectedZone: "before" | "inside" | "after",
    ) {
      const sourceRow = page.locator(".node-row", {
        has: page.getByRole("link", { name: /First root/ }),
      });
      const targetRow = page.locator(".node-row", {
        has: page.getByRole("link", { name: new RegExp(targetTitle) }),
      });
      await targetRow.evaluate((row) => row.scrollIntoView({ block: "center" }));
      await settleDragUi();
      const handleBox = await sourceRow.locator(".node-drag-handle").boundingBox();
      const targetBox = await targetRow.boundingBox();
      if (!handleBox || !targetBox) {
        throw new Error("Drag source and target must have measurable layout boxes.");
      }

      await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(
        targetBox.x + targetBox.width / 2,
        targetBox.y + targetBox.height * targetFraction,
        { steps: 8 },
      );
      await expect(sourceRow).toHaveClass(/node-row--dragging/);
      const settledTargetBox = await targetRow.boundingBox();
      if (!settledTargetBox) {
        throw new Error("Drag target must remain measurable after pointer auto-scroll.");
      }
      await page.mouse.move(
        settledTargetBox.x + settledTargetBox.width / 2,
        settledTargetBox.y + settledTargetBox.height * targetFraction,
        { steps: 3 },
      );
      await expect(targetRow).toHaveAttribute("data-drop-zone", expectedZone);
      const feedbackStyle = await targetRow.evaluate((row) => {
        const label = getComputedStyle(row, "::after");
        const line = getComputedStyle(row, "::before");
        return {
          labelBackground: label.backgroundColor,
          labelOverflow: label.overflow,
          labelRight: label.right,
          lineBackground: line.backgroundColor,
        };
      });
      expect(feedbackStyle.labelBackground).toBe("rgb(18, 99, 173)");
      expect(feedbackStyle.labelOverflow).toBe("hidden");
      expect(feedbackStyle.labelRight).toBe("50.4px");
      if (expectedZone !== "inside") {
        expect(feedbackStyle.lineBackground).toBe("rgb(115, 185, 245)");
      } else {
        await expect(targetRow).toHaveClass(/node-row--drag-expand-pending/);
        const animationStyle = await targetRow.evaluate((row) => {
          const style = getComputedStyle(row);
          return {
            delay: style.animationDelay,
            duration: style.animationDuration,
            iterationCount: style.animationIterationCount,
            name: style.animationName,
            timingFunction: style.animationTimingFunction,
          };
        });
        expect(animationStyle).toEqual({
          delay: "0.5s",
          duration: "0.35s",
          iterationCount: "2",
          name: "drag-expand-blink",
          timingFunction: "ease-in-out",
        });
        await expect(page.getByRole("button", { name: `Collapse ${targetTitle}` })).toBeVisible({
          timeout: 2_500,
        });
      }
      const dimensions = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }));
      expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
      await page.mouse.up();
    }

    await dragTo("Second root", 0.5, "inside");

    await expect.poll(async () => {
      const result = await pool.query<{ parent_id: string | null; position: number }>(
        `select parent_id, position from nodes where id = $1`,
        [firstId],
      );
      return result.rows[0];
    }).toEqual({ parent_id: secondId, position: 1 });
    await expect(page.getByText("Moving thought…", { exact: true })).toHaveCount(0);
    await settleDragUi();

    await expect(page.getByRole("button", { name: "Collapse Second root" })).toBeVisible();
    await dragTo("Third root", 0.1, "before");

    await expect.poll(async () => {
      const result = await pool.query<{ id: string }>(
        `select id from nodes where user_id = $1 and parent_id is null order by position`,
        [seeded.userId],
      );
      return result.rows.map(({ id }) => id);
    }).toEqual([secondId, firstId, thirdId]);
    await expect(page.getByText("Moving thought…", { exact: true })).toHaveCount(0);
    await settleDragUi();

    await dragTo("Third root", 0.9, "after");

    await expect.poll(async () => {
      const result = await pool.query<{ id: string }>(
        `select id from nodes where user_id = $1 and parent_id is null order by position`,
        [seeded.userId],
      );
      return result.rows.map(({ id }) => id);
    }).toEqual([secondId, thirdId, firstId]);
  } finally {
    await seeded.cleanup();
  }
});

test("uses and cancels TimeTree's drag hover expansion delay", async ({ context, page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "Pointer drag coverage runs in the desktop project.");
  const seeded = await seedBrowserSession(pool);
  const sourceId = randomUUID();
  const targetId = randomUUID();
  const childId = randomUUID();

  try {
    await pool.query(
      `insert into nodes (id, user_id, parent_id, position, title)
       values ($1, $4, null, 0, 'Timed hover source'),
              ($2, $4, null, 1, 'Timed hover target'),
              ($3, $4, $2, 0, 'Timed hover child')`,
      [sourceId, targetId, childId, seeded.userId],
    );

    await installBrowserSessionCookie(context, seeded.cookie);
    await page.clock.install();
    await page.goto("/");

    const sourceRow = page.locator(".node-row", {
      has: page.getByRole("link", { name: /Timed hover source/ }),
    });
    const targetRow = page.locator(".node-row", {
      has: page.getByRole("link", { name: /Timed hover target/ }),
    });
    const handleBox = await sourceRow.locator(".node-drag-handle").boundingBox();
    const targetBox = await targetRow.boundingBox();
    if (!handleBox || !targetBox) {
      throw new Error("Drag source and target must have measurable layout boxes.");
    }

    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.clock.pauseAt(await page.evaluate(() => Date.now()));
    await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, {
      steps: 8,
    });
    await expect(targetRow).toHaveAttribute("data-drop-zone", "inside");
    await expect(targetRow).toHaveClass(/node-row--drag-expand-pending/);

    await page.clock.runFor(600);
    await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height * 0.1);
    await expect(targetRow).toHaveAttribute("data-drop-zone", "before");
    await expect(targetRow).not.toHaveClass(/node-row--drag-expand-pending/);
    await page.clock.runFor(1_200);
    await expect(page.getByRole("button", { name: "Expand Timed hover target" })).toBeVisible();

    await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2);
    await expect(targetRow).toHaveAttribute("data-drop-zone", "inside");
    await page.clock.runFor(1_199);
    await expect(page.getByRole("button", { name: "Expand Timed hover target" })).toBeVisible();
    await page.clock.runFor(1);
    await expect(page.getByRole("button", { name: "Collapse Timed hover target" })).toBeVisible({
      timeout: 500,
    });
  } finally {
    await seeded.cleanup();
  }
});

test("uses TimeTree's reduced-motion delay for drag hover expansion", async ({ context, page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "Pointer drag coverage runs in the desktop project.");
  const seeded = await seedBrowserSession(pool);
  const sourceId = randomUUID();
  const targetId = randomUUID();
  const childId = randomUUID();

  try {
    await pool.query(
      `insert into nodes (id, user_id, parent_id, position, title)
       values ($1, $4, null, 0, 'Reduced motion source'),
              ($2, $4, null, 1, 'Reduced motion target'),
              ($3, $4, $2, 0, 'Reduced motion child')`,
      [sourceId, targetId, childId, seeded.userId],
    );

    await installBrowserSessionCookie(context, seeded.cookie);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.clock.install();
    await page.goto("/");

    const sourceRow = page.locator(".node-row", {
      has: page.getByRole("link", { name: /Reduced motion source/ }),
    });
    const targetRow = page.locator(".node-row", {
      has: page.getByRole("link", { name: /Reduced motion target/ }),
    });
    const handleBox = await sourceRow.locator(".node-drag-handle").boundingBox();
    const targetBox = await targetRow.boundingBox();
    if (!handleBox || !targetBox) {
      throw new Error("Drag source and target must have measurable layout boxes.");
    }

    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.clock.pauseAt(await page.evaluate(() => Date.now()));
    await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, {
      steps: 8,
    });
    await expect(targetRow).toHaveAttribute("data-drop-zone", "inside");
    await expect(targetRow).toHaveClass(/node-row--drag-expand-pending/);

    await page.clock.runFor(499);
    await expect(page.getByRole("button", { name: "Expand Reduced motion target" })).toBeVisible();
    await page.clock.runFor(1);
    await expect(page.getByRole("button", { name: "Collapse Reduced motion target" })).toBeVisible({
      timeout: 500,
    });
    await page.clock.resume();
    await page.mouse.up();
  } finally {
    await seeded.cleanup();
  }
});
