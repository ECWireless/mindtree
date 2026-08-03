import type { NextConfig } from "next";

import { sensitiveAuthRequestLogPatterns } from "./src/lib/auth/logging";
import { parseAllowedDevOrigins } from "./src/lib/env/development-origins";

const allowedDevOrigins = parseAllowedDevOrigins(process.env.NEXT_ALLOWED_DEV_ORIGINS);

const nextConfig: NextConfig = {
  allowedDevOrigins,
  logging: {
    incomingRequests: {
      ignore: sensitiveAuthRequestLogPatterns,
    },
  },
  reactStrictMode: true,
};

export default nextConfig;
