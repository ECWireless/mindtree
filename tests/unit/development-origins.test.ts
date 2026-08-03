import { describe, expect, it } from "vitest";

import { parseAllowedDevOrigins } from "@/lib/env/development-origins";

describe("parseAllowedDevOrigins", () => {
  it("normalizes full origins and hostnames for Next.js", () => {
    expect(
      parseAllowedDevOrigins(
        "https://private.example.test/, localhost, https://private.example.test/",
      ),
    ).toEqual(["private.example.test", "localhost"]);
  });

  it.each([
    "ftp://private.example.test",
    "https://private.example.test/path",
    "https://user:password@private.example.test",
    "https://private.example.test?query=value",
  ])("rejects a malformed development origin: %s", (origin) => {
    expect(() => parseAllowedDevOrigins(origin)).toThrow(
      "NEXT_ALLOWED_DEV_ORIGINS must contain valid HTTP(S) origins or hostnames.",
    );
  });
});
