import { describe, expect, it } from "vitest";

import { sensitiveAuthRequestLogPatterns } from "@/lib/auth/logging";

function isSensitiveAuthRequestHidden(path: string) {
  return sensitiveAuthRequestLogPatterns.some((pattern) => pattern.test(path));
}

describe("sensitive authentication request logging", () => {
  it("hides Google callback query data from the development request log", () => {
    expect(
      isSensitiveAuthRequestHidden(
        "/api/auth/callback/google?state=synthetic-state&code=synthetic-code",
      ),
    ).toBe(true);
    expect(isSensitiveAuthRequestHidden("/api/auth/callback/google")).toBe(true);
  });

  it("keeps ordinary application and auth-route logging available", () => {
    expect(isSensitiveAuthRequestHidden("/")).toBe(false);
    expect(isSensitiveAuthRequestHidden("/api/auth/sign-in/social")).toBe(false);
  });
});
