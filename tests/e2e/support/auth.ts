import { randomUUID } from "node:crypto";

import type { BrowserContext } from "@playwright/test";
import { makeSignature } from "better-auth/crypto";
import type { Pool } from "pg";

import { browserAllowedEmail, browserAuthSecret } from "../../config/browser-auth.mjs";

type SeedBrowserSessionOptions = {
  email?: string;
  emailVerified?: boolean;
  expiresAt?: Date;
};

export async function cleanupBrowserAuthRecords(pool: Pool) {
  await pool.query(`delete from "user" where id like 'browser-user-%'`);
}

export async function seedBrowserSession(
  pool: Pool,
  {
    email = browserAllowedEmail,
    emailVerified = true,
    expiresAt = new Date(Date.now() + 60 * 60 * 1_000),
  }: SeedBrowserSessionOptions = {},
) {
  const userId = `browser-user-${randomUUID()}`;
  const sessionId = `browser-session-${randomUUID()}`;
  const token = `browser-token-${randomUUID()}`;

  await pool.query(
    `insert into "user" (id, name, email, email_verified)
     values ($1, 'Synthetic Browser User', $2, $3)`,
    [userId, email, emailVerified],
  );

  try {
    await pool.query(
      `insert into "session" (id, user_id, token, expires_at)
       values ($1, $2, $3, $4)`,
      [sessionId, userId, token, expiresAt],
    );
  } catch (error) {
    await pool.query(`delete from "user" where id = $1`, [userId]);
    throw error;
  }

  const signature = await makeSignature(token, browserAuthSecret);

  return {
    cookie: `${token}.${signature}`,
    sessionId,
    userId,
    async cleanup() {
      await pool.query(`delete from "user" where id = $1`, [userId]);
    },
    async sessionExists() {
      const result = await pool.query<{ exists: boolean }>(
        `select exists(select 1 from "session" where id = $1) as exists`,
        [sessionId],
      );
      return result.rows[0]?.exists ?? false;
    },
  };
}

export async function installBrowserSessionCookie(context: BrowserContext, value: string) {
  await context.addCookies([
    {
      name: "better-auth.session_token",
      value,
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}
