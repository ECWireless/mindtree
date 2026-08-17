import { describe, expect, it } from "vitest";

import nextConfig from "../../next.config";
import { config as proxyConfig, proxy } from "@/proxy";
import { publicShareResponseHeaders } from "@/lib/sharing/response-policy";

describe("public share response configuration", () => {
  it("applies cache, indexing, content, and referrer protections to every share path", async () => {
    const configured = await nextConfig.headers?.();
    const share = configured?.find((entry) => entry.source === "/share/:path*");

    expect(share?.headers).toEqual([...publicShareResponseHeaders]);
  });

  it("reasserts the same policy at the share-route proxy boundary", () => {
    const response = proxy();

    expect(proxyConfig.matcher).toEqual(["/share/:path*"]);
    const proxyPolicy = Object.fromEntries(
      publicShareResponseHeaders.map(({ key }) => [key, response.headers.get(key)]),
    );
    expect(proxyPolicy).toEqual(Object.fromEntries(
      publicShareResponseHeaders.map(({ key, value }) => [key, value]),
    ));
  });
});
