import { toNextJsHandler } from "better-auth/next-js";

import {
  isMindTreeAuthRequestAllowed,
  type MindTreeAuthHttpMethod,
} from "@/lib/auth/http";

export const dynamic = "force-dynamic";

function notFound() {
  return new Response("Not Found", { status: 404 });
}

async function handleAuthRequest(request: Request, method: MindTreeAuthHttpMethod) {
  if (
    !isMindTreeAuthRequestAllowed({
      method,
      pathname: new URL(request.url).pathname,
      vercelEnvironment: process.env.VERCEL_ENV,
    })
  ) {
    return notFound();
  }

  const { auth } = await import("@/lib/server/auth");
  const handler = toNextJsHandler(auth)[method];
  return handler(request);
}

export function GET(request: Request) {
  return handleAuthRequest(request, "GET");
}

export function POST(request: Request) {
  return handleAuthRequest(request, "POST");
}
