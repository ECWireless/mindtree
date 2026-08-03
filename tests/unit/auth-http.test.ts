import { describe, expect, it } from "vitest";

import { isMindTreeAuthRequestAllowed } from "@/lib/auth/http";

describe("MindTree authentication HTTP surface", () => {
  it.each([
    ["GET", "/api/auth/callback/google"],
    ["POST", "/api/auth/callback/google"],
    ["POST", "/api/auth/sign-in/social"],
    ["POST", "/api/auth/sign-out"],
  ] as const)("allows only the required %s %s flow", (method, pathname) => {
    expect(isMindTreeAuthRequestAllowed({ method, pathname })).toBe(true);
  });

  it.each([
    ["POST", "/api/auth/get-access-token"],
    ["POST", "/api/auth/refresh-token"],
    ["GET", "/api/auth/list-accounts"],
    ["POST", "/api/auth/link-social"],
    ["POST", "/api/auth/unlink-account"],
    ["POST", "/api/auth/update-user"],
    ["POST", "/api/auth/delete-user"],
    ["GET", "/api/auth/get-session"],
  ] as const)("rejects the unused %s %s endpoint", (method, pathname) => {
    expect(isMindTreeAuthRequestAllowed({ method, pathname })).toBe(false);
  });

  it("rejects every auth request in a preview deployment", () => {
    expect(
      isMindTreeAuthRequestAllowed({
        method: "POST",
        pathname: "/api/auth/sign-in/social",
        vercelEnvironment: "preview",
      }),
    ).toBe(false);
  });
});
