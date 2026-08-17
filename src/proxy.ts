import { NextResponse } from "next/server";

import { publicShareResponseHeaders } from "@/lib/sharing/response-policy";

export function proxy() {
  const response = NextResponse.next();
  for (const { key, value } of publicShareResponseHeaders) {
    response.headers.set(key, value);
  }
  return response;
}

export const config = {
  matcher: ["/share/:path*"],
};
