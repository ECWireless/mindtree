import "server-only";

import { eq } from "drizzle-orm";
import { betterAuth } from "better-auth/minimal";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";

import { db } from "@/db/client";
import { authSchema, user as userTable } from "@/db/schema";
import { isAllowedIdentity, normalizeEmail } from "@/lib/auth/policy";
import { getAllowedEmail } from "@/lib/server/allowed-email";
import { getServerEnvironment } from "@/lib/env/server";

const environment = getServerEnvironment(["authentication"]);
const trustedOrigins = [
  new URL(environment.BETTER_AUTH_URL).origin,
  ...(environment.BETTER_AUTH_TRUSTED_ORIGINS ?? []),
].filter((origin, index, origins) => origins.indexOf(origin) === index);

function rejectIdentity(): never {
  throw new APIError("FORBIDDEN", {
    code: "ACCOUNT_NOT_ALLOWED",
    message: "account not allowed",
  });
}

function discardProviderSecrets<Account extends object>(account: Account) {
  return {
    data: {
      ...account,
      accessToken: null,
      refreshToken: null,
      idToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      scope: null,
      password: null,
    },
  };
}

export const auth = betterAuth({
  appName: "MindTree",
  baseURL: environment.BETTER_AUTH_URL,
  secret: environment.BETTER_AUTH_SECRET,
  trustedOrigins,
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: authSchema,
  }),
  account: {
    encryptOAuthTokens: true,
  },
  socialProviders: {
    google: {
      clientId: environment.GOOGLE_CLIENT_ID,
      clientSecret: environment.GOOGLE_CLIENT_SECRET,
    },
  },
  databaseHooks: {
    account: {
      create: {
        before: async (account) => discardProviderSecrets(account),
      },
      update: {
        before: async (account) => discardProviderSecrets(account),
      },
    },
    user: {
      create: {
        before: async (candidate) => {
          if (!isAllowedIdentity(candidate, getAllowedEmail())) {
            rejectIdentity();
          }

          return {
            data: {
              ...candidate,
              email: normalizeEmail(candidate.email),
            },
          };
        },
      },
    },
    session: {
      create: {
        before: async (candidate) => {
          const [sessionUser] = await db
            .select({
              email: userTable.email,
              emailVerified: userTable.emailVerified,
            })
            .from(userTable)
            .where(eq(userTable.id, candidate.userId))
            .limit(1);

          if (!sessionUser || !isAllowedIdentity(sessionUser, getAllowedEmail())) {
            rejectIdentity();
          }

          return { data: candidate };
        },
      },
    },
  },
});
