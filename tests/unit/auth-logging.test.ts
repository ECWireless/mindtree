import { describe, expect, it } from "vitest";

import { sensitiveRequestLogPatterns } from "@/lib/auth/logging";

function isSensitiveRequestHidden(path: string) {
  return sensitiveRequestLogPatterns.some((pattern) => pattern.test(path));
}

describe("sensitive request logging", () => {
  it("hides Google callback query data from the development request log", () => {
    expect(
      isSensitiveRequestHidden(
        "/api/auth/callback/google?state=synthetic-state&code=synthetic-code",
      ),
    ).toBe(true);
    expect(isSensitiveRequestHidden("/api/auth/callback/google")).toBe(true);
  });

  it("hides public capability paths, including malformed attempts", () => {
    expect(isSensitiveRequestHidden(`/share/${"a".repeat(43)}?node=synthetic`)).toBe(true);
    expect(isSensitiveRequestHidden("/share/not-a-valid-secret")).toBe(true);
    expect(isSensitiveRequestHidden("/share/")).toBe(false);
  });

  it("keeps ordinary application and auth-route logging available", () => {
    expect(isSensitiveRequestHidden("/")).toBe(false);
    expect(isSensitiveRequestHidden("/api/auth/sign-in/social")).toBe(false);
  });
});
