import { Buffer } from "node:buffer";

import { defineConfig, devices } from "@playwright/test";

import { browserAllowedEmail, browserAuthSecret } from "./tests/config/browser-auth.mjs";
import { loadDatabaseEnvironment } from "./tests/config/load-database-environment.mjs";

loadDatabaseEnvironment();

const port = 3188;
const baseURL = `http://127.0.0.1:${port}`;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required for browser tests.");
}

const testAuthEnvironment = {
  DATABASE_URL: process.env.DATABASE_URL,
  BETTER_AUTH_SECRET: browserAuthSecret,
  BETTER_AUTH_URL: baseURL,
  GOOGLE_CLIENT_ID: "synthetic-google-client-id",
  GOOGLE_CLIENT_SECRET: "synthetic-google-client-secret",
  ALLOWED_EMAIL: browserAllowedEmail,
  SHARE_LINK_ENCRYPTION_KEY: Buffer.alloc(32, 15).toString("base64url"),
  MINDTREE_TEST_CHAT_FIXTURE: "1",
};

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "small-mobile",
      use: {
        ...devices["Pixel 5"],
        viewport: { width: 320, height: 568 },
      },
    },
    {
      name: "mobile",
      use: {
        ...devices["Pixel 5"],
        viewport: { width: 375, height: 812 },
      },
    },
    {
      name: "tablet",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 768, height: 1024 },
      },
    },
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
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
