import { expect, test } from "@playwright/test";

test("renders the signed-out foundation without horizontal overflow", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle("MindTree");
  await expect(page.getByLabel("MindTree")).toBeVisible();
  await expect(page.getByText("Hierarchical thinking")).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 1, name: "See how your thoughts grow." }),
  ).toBeVisible();

  const action = page.getByRole("link", { name: "View source" });
  await action.focus();
  await expect(action).toBeFocused();
  await expect(action).toHaveCSS("outline-style", "solid");

  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
});

test("keeps the source action honest and accessible", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("link", { name: "View source" })).toHaveAttribute(
    "href",
    "https://github.com/ECWireless/mindtree",
  );
});
