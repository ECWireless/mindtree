import { defineConfig, devices } from "@playwright/test";

import { loadDatabaseEnvironment } from "./tests/config/load-database-environment.mjs";

loadDatabaseEnvironment();

const port = 3188;
const baseURL = `http://127.0.0.1:${port}`;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required for browser tests.");
}

const testAuthEnvironment = {
  DATABASE_URL: process.env.DATABASE_URL,
  BETTER_AUTH_SECRET: "synthetic-auth-secret-for-browser-tests-only",
  BETTER_AUTH_URL: baseURL,
  GOOGLE_CLIENT_ID: "synthetic-google-client-id",
  GOOGLE_CLIENT_SECRET: "synthetic-google-client-secret",
  ALLOWED_EMAIL: "browser-user@example.test",
};

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: "mobile",
      use: {
        ...devices["Pixel 5"],
        viewport: { width: 375, height: 812 },
      },
    },
  ],
  webServer: {
    command: `corepack pnpm dev --hostname 127.0.0.1 --port ${port}`,
    url: baseURL,
    env: testAuthEnvironment,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
