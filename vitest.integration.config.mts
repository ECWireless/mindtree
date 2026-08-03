import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

import { loadDatabaseEnvironment } from "./tests/config/load-database-environment.mjs";

loadDatabaseEnvironment();

export default defineConfig({
  resolve: {
    alias: {
      "server-only": fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)),
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["tests/integration/**/*.test.{ts,tsx}"],
    fileParallelism: false,
    testTimeout: 10_000,
  },
});
