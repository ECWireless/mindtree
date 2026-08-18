import { describe, expect, it } from "vitest";

import { sanitizePublicPageview } from "@/components/public-surface-analytics";

describe("public surface analytics", () => {
  it("reports a signed-out landing page without query or fragment data", () => {
    const event = {
      type: "pageview" as const,
      url: "https://mindtree.example/?error=ACCOUNT_NOT_ALLOWED#details",
    };

    expect(sanitizePublicPageview(event)).toEqual({
      type: "pageview",
      url: "https://mindtree.example/",
    });
    expect(event.url).toContain("ACCOUNT_NOT_ALLOWED");
  });

  it("groups public trails without exposing their capability or node state", () => {
    const secret = "public-capability-secret";
    const nodeId = "11111111-1111-4111-8111-111111111111";

    const sanitized = sanitizePublicPageview({
      type: "pageview",
      url: `https://mindtree.example/share/${secret}?node=${nodeId}&view=constellation#thought`,
    });

    expect(sanitized).toEqual({
      type: "pageview",
      url: "https://mindtree.example/share/[secret]",
    });
    expect(JSON.stringify(sanitized)).not.toContain(secret);
    expect(JSON.stringify(sanitized)).not.toContain(nodeId);
  });

  it.each([
    "https://mindtree.example/api/chat",
    "https://mindtree.example/api/auth/session",
    "https://mindtree.example/share/secret/extra",
    "https://mindtree.example/private",
  ])("discards pageviews outside the approved public surfaces: %s", (url) => {
    expect(sanitizePublicPageview({ type: "pageview", url })).toBeNull();
  });

  it("discards custom events and malformed URLs", () => {
    expect(
      sanitizePublicPageview({
        type: "event",
        url: "https://mindtree.example/",
      }),
    ).toBeNull();
    expect(
      sanitizePublicPageview({ type: "pageview", url: "/share/secret" }),
    ).toBeNull();
  });
});
