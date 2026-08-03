import "server-only";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { getServerEnvironment } from "@/lib/env/server";

import { schema } from "./schema";

const globalForDatabase = globalThis as typeof globalThis & {
  mindTreePool?: Pool;
};

const environment = getServerEnvironment(["database"]);

export const pool =
  globalForDatabase.mindTreePool ??
  new Pool({
    connectionString: environment.DATABASE_URL,
  });

if (process.env.NODE_ENV !== "production") {
  globalForDatabase.mindTreePool = pool;
}

export const db = drizzle(pool, { schema });
