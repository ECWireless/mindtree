import "server-only";

import { headers } from "next/headers";

import { assertAuthorizedSession } from "@/lib/auth/policy";
import { auth } from "@/lib/server/auth";
import { getAllowedEmail } from "@/lib/server/allowed-email";

export async function requireAuthorizedSession(requestHeaders?: Headers) {
  const session = await auth.api.getSession({
    headers: requestHeaders ?? (await headers()),
  });

  return assertAuthorizedSession(session, getAllowedEmail());
}
