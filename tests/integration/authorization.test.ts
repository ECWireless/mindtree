import { randomUUID } from "node:crypto";

import { makeSignature } from "better-auth/crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";

import { AuthorizationError } from "../../src/lib/auth/policy";

const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL or DATABASE_URL_UNPOOLED is required for integration tests.");
}

const authSecret = "synthetic-auth-secret-for-integration-tests-only";
const allowedEmail = "allowed-user@example.test";
const pool = new Pool({ connectionString });
const userIds = new Set<string>();

let auth: typeof import("../../src/lib/server/auth").auth;
let requireAuthorizedSession: typeof import(
  "../../src/lib/server/authorization"
).requireAuthorizedSession;
let authRouteGet: typeof import("../../src/app/api/auth/[...all]/route").GET;
let authRoutePost: typeof import("../../src/app/api/auth/[...all]/route").POST;

async function seedSession(email: string, emailVerified: boolean) {
  const userId = `user-${randomUUID()}`;
  const sessionId = `session-${randomUUID()}`;
  const token = `token-${randomUUID()}`;
  userIds.add(userId);

  await pool.query(
    `insert into "user" (id, name, email, email_verified)
     values ($1, 'Synthetic User', $2, $3)`,
    [userId, email, emailVerified],
  );
  await pool.query(
    `insert into "session" (id, user_id, token, expires_at)
     values ($1, $2, $3, now() + interval '1 hour')`,
    [sessionId, userId, token],
  );

  const signature = await makeSignature(token, authSecret);
  const headers = new Headers();
  headers.set("cookie", `better-auth.session_token=${token}.${signature}`);

  return { headers, userId };
}

describe("Better Auth single-owner boundary", () => {
  beforeAll(async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", authSecret);
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
    vi.stubEnv("BETTER_AUTH_TRUSTED_ORIGINS", "https://trusted.example.test/");
    vi.stubEnv("GOOGLE_CLIENT_ID", "synthetic-google-client-id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "synthetic-google-client-secret");
    vi.stubEnv("ALLOWED_EMAIL", allowedEmail);

    ({ auth } = await import("../../src/lib/server/auth"));
    ({ requireAuthorizedSession } = await import("../../src/lib/server/authorization"));
    ({ GET: authRouteGet, POST: authRoutePost } = await import(
      "../../src/app/api/auth/[...all]/route"
    ));
  });

  afterEach(async () => {
    process.env.ALLOWED_EMAIL = allowedEmail;
    delete process.env.VERCEL_ENV;

    if (userIds.size > 0) {
      await pool.query(`delete from "user" where id = any($1::text[])`, [[...userIds]]);
      userIds.clear();
    }
  });

  afterAll(async () => {
    try {
      await pool.end();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("accepts a validated Better Auth session for the allowed account", async () => {
    const { headers } = await seedSession(allowedEmail, true);

    const session = await requireAuthorizedSession(headers);

    expect(session.user.email).toBe(allowedEmail);
    expect(session.user.emailVerified).toBe(true);
  });

  it("rejects missing, invalid, unverified, and disallowed sessions", async () => {
    await expect(requireAuthorizedSession(new Headers())).rejects.toEqual(
      new AuthorizationError("missing-session"),
    );

    await expect(
      requireAuthorizedSession(
        new Headers({ cookie: "better-auth.session_token=invalid-token.invalid-signature" }),
      ),
    ).rejects.toEqual(new AuthorizationError("missing-session"));

    const expired = await seedSession(allowedEmail.toUpperCase(), true);
    await pool.query(`update "session" set expires_at = now() - interval '1 minute' where user_id = $1`, [
      expired.userId,
    ]);
    await expect(requireAuthorizedSession(expired.headers)).rejects.toEqual(
      new AuthorizationError("missing-session"),
    );

    const unverified = await seedSession(allowedEmail, false);
    await expect(requireAuthorizedSession(unverified.headers)).rejects.toEqual(
      new AuthorizationError("unverified-email"),
    );

    const disallowed = await seedSession("other-user@example.test", true);
    await expect(requireAuthorizedSession(disallowed.headers)).rejects.toEqual(
      new AuthorizationError("disallowed-email"),
    );
  });

  it("revokes a retained session when the configured allowlist changes", async () => {
    const { headers } = await seedSession(allowedEmail, true);
    await expect(requireAuthorizedSession(headers)).resolves.toBeTruthy();

    process.env.ALLOWED_EMAIL = "replacement-user@example.test";

    await expect(requireAuthorizedSession(headers)).rejects.toEqual(
      new AuthorizationError("disallowed-email"),
    );
  });

  it("rejects disallowed identities before user or session creation", async () => {
    const context = await auth.$context;
    const userHook = context.options.databaseHooks?.user?.create?.before;
    const sessionHook = context.options.databaseHooks?.session?.create?.before;
    expect(userHook).toBeTypeOf("function");
    expect(sessionHook).toBeTypeOf("function");

    await expect(
      userHook?.({
        id: `user-${randomUUID()}`,
        name: "Disallowed User",
        email: "other-user@example.test",
        emailVerified: true,
        image: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).rejects.toThrow("account not allowed");

    const { userId } = await seedSession("other-session-user@example.test", true);
    await expect(
      sessionHook?.({
        id: `session-${randomUUID()}`,
        token: `token-${randomUUID()}`,
        userId,
        expiresAt: new Date(Date.now() + 60_000),
        ipAddress: null,
        userAgent: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).rejects.toThrow("account not allowed");
  });

  it("rejects unused credential and account routes, including in previews", async () => {
    const retained = await seedSession(allowedEmail, true);
    process.env.ALLOWED_EMAIL = "replacement-user@example.test";

    const headers = new Headers(retained.headers);
    headers.set("content-type", "application/json");
    headers.set("origin", "http://localhost:3000");

    for (const pathname of [
      "/api/auth/get-access-token",
      "/api/auth/refresh-token",
      "/api/auth/link-social",
      "/api/auth/unlink-account",
      "/api/auth/update-user",
      "/api/auth/delete-user",
    ]) {
      const response = await authRoutePost(
        new Request(`http://localhost:3000${pathname}`, {
          method: "POST",
          headers,
          body: JSON.stringify({ providerId: "google" }),
        }),
      );
      expect(response.status, pathname).toBe(404);
    }

    const getResponse = await authRouteGet(
      new Request("http://localhost:3000/api/auth/list-accounts", { headers }),
    );
    expect(getResponse.status).toBe(404);

    process.env.VERCEL_ENV = "preview";
    const previewResponse = await authRoutePost(
      new Request("https://preview.example.test/api/auth/sign-in/social", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://preview.example.test",
        },
        body: JSON.stringify({ provider: "google" }),
      }),
    );
    expect(previewResponse.status).toBe(404);
  });

  it("lets a retained disallowed session sign out without exposing another auth endpoint", async () => {
    const retained = await seedSession(allowedEmail, true);
    process.env.ALLOWED_EMAIL = "replacement-user@example.test";
    const headers = new Headers(retained.headers);
    headers.set("origin", "http://localhost:3000");

    const response = await authRoutePost(
      new Request("http://localhost:3000/api/auth/sign-out", {
        method: "POST",
        headers,
      }),
    );

    expect(response.status).toBe(200);
    const sessionCount = await pool.query<{ count: number }>(
      `select count(*)::int as count from "session" where user_id = $1`,
      [retained.userId],
    );
    expect(sessionCount.rows[0]?.count).toBe(0);
  });

  it("configures token encryption defensively and discards all provider secrets", async () => {
    const { userId } = await seedSession(allowedEmail, true);
    const context = await auth.$context;
    expect(context.options.account?.encryptOAuthTokens).toBe(true);
    expect(context.options.trustedOrigins).toContain("http://localhost:3000");
    expect(context.options.trustedOrigins).toContain("https://trusted.example.test");

    const account = await context.internalAdapter.createAccount({
      userId,
      providerId: "google",
      accountId: `google-${randomUUID()}`,
      accessToken: "synthetic-access-token",
      refreshToken: "synthetic-refresh-token",
      idToken: "synthetic-id-token",
      accessTokenExpiresAt: new Date(Date.now() + 60_000),
      refreshTokenExpiresAt: new Date(Date.now() + 120_000),
      scope: "openid email profile",
      password: "synthetic-password",
    });

    const selectProviderSecrets = () =>
      pool.query<{
        access_token: string | null;
        refresh_token: string | null;
        id_token: string | null;
        access_token_expires_at: Date | null;
        refresh_token_expires_at: Date | null;
        scope: string | null;
        password: string | null;
      }>(
      `select access_token, refresh_token, id_token, access_token_expires_at,
              refresh_token_expires_at, scope, password
       from "account" where id = $1`,
      [account.id],
    );

    expect((await selectProviderSecrets()).rows[0]).toEqual({
      access_token: null,
      refresh_token: null,
      id_token: null,
      access_token_expires_at: null,
      refresh_token_expires_at: null,
      scope: null,
      password: null,
    });

    await pool.query(
      `update "account"
       set access_token = 'synthetic-existing-access-token',
           refresh_token = 'synthetic-existing-refresh-token',
           id_token = 'synthetic-existing-id-token',
           access_token_expires_at = now(),
           refresh_token_expires_at = now(),
           scope = 'openid',
           password = 'synthetic-existing-password'
       where id = $1`,
      [account.id],
    );
    await context.internalAdapter.updateAccount(account.id, {
      accessToken: "synthetic-replacement-access-token",
      refreshToken: "synthetic-replacement-refresh-token",
      idToken: "synthetic-replacement-id-token",
      accessTokenExpiresAt: new Date(Date.now() + 60_000),
      refreshTokenExpiresAt: new Date(Date.now() + 120_000),
      scope: "openid email",
      password: "synthetic-replacement-password",
    });

    expect((await selectProviderSecrets()).rows[0]).toEqual({
      access_token: null,
      refresh_token: null,
      id_token: null,
      access_token_expires_at: null,
      refresh_token_expires_at: null,
      scope: null,
      password: null,
    });
  });
});
