import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

const DATABASE_ENVIRONMENT_NAMES = ["DATABASE_URL", "DATABASE_URL_UNPOOLED"] as const;

export function loadDatabaseEnvironment(path = ".env") {
  let parsed: Record<string, string | undefined>;

  try {
    parsed = parseEnv(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }

    throw error;
  }

  for (const name of DATABASE_ENVIRONMENT_NAMES) {
    if (process.env[name] === undefined && parsed[name] !== undefined) {
      process.env[name] = parsed[name];
    }
  }
}
