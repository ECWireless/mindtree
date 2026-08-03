import { describe, expect, it } from "vitest";

import { resolveAuthenticationAvailability } from "@/lib/auth/deployment";

describe("authentication deployment policy", () => {
  it.each([undefined, "development", "production"])(
    "allows sign-in outside a Vercel preview (%s)",
    (vercelEnvironment) => {
      expect(
        resolveAuthenticationAvailability({
          canonicalUrl: "https://mind.example.test",
          vercelEnvironment,
        }),
      ).toEqual({ available: true });
    },
  );

  it("directs preview users to the configured canonical origin", () => {
    expect(
      resolveAuthenticationAvailability({
        canonicalUrl: "https://mind.example.test/auth-path",
        vercelEnvironment: "preview",
      }),
    ).toEqual({
      available: false,
      canonicalOrigin: "https://mind.example.test",
    });
  });
});
