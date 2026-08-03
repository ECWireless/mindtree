import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

try {
  process.loadEnvFile(".env");
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
    throw error;
  }
}

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
    passWithNoTests: true,
    testTimeout: 10_000,
  },
});
