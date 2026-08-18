"use client";

import {
  Analytics,
  type BeforeSendEvent,
} from "@vercel/analytics/next";

const PUBLIC_THOUGHT_TRAIL_PATH = /^\/share\/[^/]+\/?$/u;

export function sanitizePublicPageview(
  event: BeforeSendEvent,
): BeforeSendEvent | null {
  if (event.type !== "pageview") return null;

  let url: URL;
  try {
    url = new URL(event.url);
  } catch {
    return null;
  }

  if (url.pathname === "/") {
    url.pathname = "/";
  } else if (PUBLIC_THOUGHT_TRAIL_PATH.test(url.pathname)) {
    url.pathname = "/share/[secret]";
  } else {
    return null;
  }

  url.search = "";
  url.hash = "";

  return { ...event, url: url.toString() };
}

export function PublicSurfaceAnalytics() {
  return <Analytics beforeSend={sanitizePublicPageview} />;
}
