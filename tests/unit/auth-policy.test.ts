import { describe, expect, it } from "vitest";

import {
  assertAuthorizedSession,
  AuthorizationError,
  isAllowedIdentity,
  normalizeEmail,
  type AuthSession,
} from "@/lib/auth/policy";

const allowedEmail = "owner@example.test";

function session(email = allowedEmail, emailVerified = true): AuthSession {
  return {
    user: {
      id: "synthetic-user",
      name: "Synthetic Owner",
      email,
      emailVerified,
    },
  };
}

describe("single-owner authorization policy", () => {
  it("normalizes email casing and surrounding whitespace", () => {
    expect(normalizeEmail("  OWNER@Example.Test ")).toBe(allowedEmail);
    expect(
      isAllowedIdentity(
        { email: " OWNER@Example.Test ", emailVerified: true },
        allowedEmail,
      ),
    ).toBe(true);
  });

  it("accepts only the verified configured identity", () => {
    expect(assertAuthorizedSession(session(), allowedEmail)).toEqual(session());
    expect(isAllowedIdentity({ email: allowedEmail, emailVerified: false }, allowedEmail)).toBe(
      false,
    );
    expect(
      isAllowedIdentity({ email: "other@example.test", emailVerified: true }, allowedEmail),
    ).toBe(false);
  });

  it("distinguishes missing, unverified, and disallowed sessions", () => {
    expect(() => assertAuthorizedSession(null, allowedEmail)).toThrow(
      new AuthorizationError("missing-session"),
    );
    expect(() => assertAuthorizedSession(session(allowedEmail, false), allowedEmail)).toThrow(
      new AuthorizationError("unverified-email"),
    );
    expect(() => assertAuthorizedSession(session("other@example.test"), allowedEmail)).toThrow(
      new AuthorizationError("disallowed-email"),
    );
  });
});
