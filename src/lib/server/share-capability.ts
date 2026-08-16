import "server-only";

import { createHash, randomBytes } from "node:crypto";

import {
  BRANCH_SHARE_SECRET_BYTES,
  branchShareSecretSchema,
} from "@/lib/sharing/contracts";

export function generateBranchShareSecret() {
  return randomBytes(BRANCH_SHARE_SECRET_BYTES).toString("base64url");
}

export function digestBranchShareSecret(secret: string) {
  const parsed = branchShareSecretSchema.safeParse(secret);
  if (!parsed.success) return null;
  return createHash("sha256").update(parsed.data, "utf8").digest("hex");
}
