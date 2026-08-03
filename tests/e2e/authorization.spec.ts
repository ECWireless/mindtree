import { expect, test } from "@playwright/test";
import { Pool } from "pg";

import { browserAllowedEmail } from "../config/browser-auth.mjs";
import {
  cleanupBrowserAuthRecords,
  installBrowserSessionCookie,
  seedBrowserSession,
} from "./support/auth";

const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL or DATABASE_URL_UNPOOLED is required for browser tests.");
}

const pool = new Pool({ connectionString });

test.beforeAll(async () => {
  await cleanupBrowserAuthRecords(pool);
});

test.afterAll(async () => {
  try {
    await cleanupBrowserAuthRecords(pool);
  } finally {
    await pool.end();
  }
});

test("recovers when the Google sign-in request fails", async ({ page }) => {
  await page.route("**/api/auth/sign-in/social", (route) => route.abort("failed"));
  await page.goto("/");

  await page.getByRole("button", { name: "Continue with Google" }).click();

  await expect(page.locator("p[role='alert']")).toHaveText(
    "Google sign-in could not be started. Please try again.",
  );
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeEnabled();
});

test("loads the dashboard from a real Better Auth session and signs out", async ({
  context,
  page,
}) => {
  const seeded = await seedBrowserSession(pool);

  try {
    await installBrowserSessionCookie(context, seeded.cookie);
    await page.goto("/");

    await expect(page.getByTestId("dashboard-shell")).toBeVisible();
    await expect(page.locator(".dashboard-account > span")).toHaveText(browserAllowedEmail);
    await expect(page.getByText("No thoughts yet.")).toBeVisible();

    await page.reload();
    await expect(page.getByTestId("dashboard-shell")).toBeVisible();

    await page.getByRole("button", { name: "Sign out" }).click();

    await expect(page.getByTestId("sign-in-page")).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
    await expect.poll(() => seeded.sessionExists()).toBe(false);
    await expect
      .poll(async () =>
        (await context.cookies()).some((cookie) => cookie.name === "better-auth.session_token"),
      )
      .toBe(false);
  } finally {
    await seeded.cleanup();
  }
});

test("recovers when sign-out fails", async ({ context, page }) => {
  const seeded = await seedBrowserSession(pool);

  try {
    await installBrowserSessionCookie(context, seeded.cookie);
    await page.route("**/api/auth/sign-out", (route) => route.abort("failed"));
    await page.goto("/");

    await page.getByRole("button", { name: "Sign out" }).click();

    await expect(page.locator("p[role='alert']")).toHaveText("Sign out failed. Please try again.");
    await expect(page.getByRole("button", { name: "Sign out" })).toBeEnabled();
    await expect(page.getByTestId("dashboard-shell")).toBeVisible();
    await expect.poll(() => seeded.sessionExists()).toBe(true);
  } finally {
    await seeded.cleanup();
  }
});

for (const scenario of [
  {
    name: "a retained session for a different account",
    options: { email: "other-browser-user@example.test", emailVerified: true },
    accessDenied: true,
  },
  {
    name: "a retained session with an unverified email",
    options: { email: browserAllowedEmail, emailVerified: false },
    accessDenied: true,
  },
  {
    name: "an expired session",
    options: {
      email: browserAllowedEmail,
      emailVerified: true,
      expiresAt: new Date("2000-01-01T00:00:00.000Z"),
    },
    accessDenied: false,
  },
] as const) {
  test(`rejects ${scenario.name}`, async ({ context, page }) => {
    const seeded = await seedBrowserSession(pool, scenario.options);

    try {
      await installBrowserSessionCookie(context, seeded.cookie);
      await page.goto("/");

      await expect(page.getByTestId("dashboard-shell")).toHaveCount(0);
      await expect(page.getByTestId("sign-in-page")).toBeVisible();
      if (scenario.accessDenied) {
        await expect(page.getByText("That Google account can’t access this MindTree.")).toBeVisible();
        await expect(page.getByRole("button", { name: "Use another Google account" })).toBeVisible();
      } else {
        await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
      }
    } finally {
      await seeded.cleanup();
    }
  });
}

test("rejects an invalid session cookie", async ({ context, page }) => {
  await installBrowserSessionCookie(context, "invalid-token.invalid-signature");

  await page.goto("/");

  await expect(page.getByTestId("dashboard-shell")).toHaveCount(0);
  await expect(page.getByTestId("sign-in-page")).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
});

test("keeps unused Better Auth endpoints outside the browser surface", async ({
  context,
  page,
}) => {
  const seeded = await seedBrowserSession(pool);

  try {
    await installBrowserSessionCookie(context, seeded.cookie);
    await page.goto("/");
    await expect(page.getByTestId("dashboard-shell")).toBeVisible();

    const statuses = await page.evaluate(async () => {
      const postPaths = [
        "/api/auth/get-access-token",
        "/api/auth/refresh-token",
        "/api/auth/link-social",
        "/api/auth/unlink-account",
        "/api/auth/update-user",
        "/api/auth/delete-user",
      ];
      const getPaths = ["/api/auth/list-accounts", "/api/auth/get-session"];
      const results: Array<[string, number]> = [];

      for (const path of postPaths) {
        const response = await fetch(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ providerId: "google" }),
        });
        results.push([path, response.status]);
      }

      for (const path of getPaths) {
        const response = await fetch(path);
        results.push([path, response.status]);
      }

      return results;
    });

    expect(statuses).toEqual([
      ["/api/auth/get-access-token", 404],
      ["/api/auth/refresh-token", 404],
      ["/api/auth/link-social", 404],
      ["/api/auth/unlink-account", 404],
      ["/api/auth/update-user", 404],
      ["/api/auth/delete-user", 404],
      ["/api/auth/list-accounts", 404],
      ["/api/auth/get-session", 404],
    ]);
    await expect(page.getByTestId("dashboard-shell")).toBeVisible();
    await expect.poll(() => seeded.sessionExists()).toBe(true);
  } finally {
    await seeded.cleanup();
  }
});
