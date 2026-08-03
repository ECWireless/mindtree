import { expect, test } from "@playwright/test";

test("renders the signed-out foundation without horizontal overflow", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle("MindTree");
  await expect(page.getByLabel("MindTree")).toBeVisible();
  await expect(page.getByText("Hierarchical thinking")).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 1, name: "See how your thoughts grow." }),
  ).toBeVisible();

  const action = page.getByRole("button", { name: "Continue with Google" });
  await action.focus();
  await expect(action).toBeFocused();
  await expect(action).toHaveCSS("outline-style", "solid");

  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
});

test("distinguishes allowlist rejection from other OAuth errors", async ({ page }) => {
  await page.goto("/?error=access_denied");

  await expect(page.getByText("Google sign-in wasn’t completed. Please try again.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();

  await page.goto("/?error=ACCOUNT_NOT_ALLOWED");

  await expect(page.getByText("That Google account can’t access this MindTree.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Use another Google account" })).toBeVisible();
});
