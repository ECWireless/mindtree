import type { NextConfig } from "next";

import { sensitiveRequestLogPatterns } from "./src/lib/auth/logging";
import { parseAllowedDevOrigins } from "./src/lib/env/development-origins";
import { publicShareResponseHeaders } from "./src/lib/sharing/response-policy";

const allowedDevOrigins = parseAllowedDevOrigins(process.env.NEXT_ALLOWED_DEV_ORIGINS);

const nextConfig: NextConfig = {
  allowedDevOrigins,
  async headers() {
    return [{
      source: "/share/:path*",
      headers: [...publicShareResponseHeaders],
    }];
  },
  logging: {
    incomingRequests: {
      ignore: sensitiveRequestLogPatterns,
    },
  },
  reactStrictMode: true,
};

export default nextConfig;
