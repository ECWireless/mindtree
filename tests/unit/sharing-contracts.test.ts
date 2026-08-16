import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  BRANCH_SHARE_SECRET_BYTES,
  BRANCH_SHARE_SECRET_LENGTH,
  branchShareRootInputSchema,
  branchShareSecretSchema,
  publicTrailSelectionSchema,
} from "@/lib/sharing/contracts";

describe("branch sharing contracts", () => {
  it("accepts exactly one canonical 256-bit base64url capability", () => {
    const secret = randomBytes(BRANCH_SHARE_SECRET_BYTES).toString("base64url");
    expect(secret).toHaveLength(BRANCH_SHARE_SECRET_LENGTH);
    expect(branchShareSecretSchema.parse(secret)).toBe(secret);

    for (const malformed of [
      secret.slice(1),
      `${secret}=`,
      `${secret.slice(0, -1)}+`,
      "a".repeat(BRANCH_SHARE_SECRET_LENGTH),
    ]) {
      expect(branchShareSecretSchema.safeParse(malformed).success).toBe(
        malformed === "a".repeat(BRANCH_SHARE_SECRET_LENGTH),
      );
    }
  });

  it("accepts only strict UUID node selections", () => {
    const nodeId = crypto.randomUUID();
    expect(branchShareRootInputSchema.parse({ nodeId })).toEqual({ nodeId });
    expect(publicTrailSelectionSchema.parse(nodeId)).toBe(nodeId);
    expect(branchShareRootInputSchema.safeParse({ nodeId, extra: true }).success)
      .toBe(false);
    expect(publicTrailSelectionSchema.safeParse("not-a-node").success).toBe(false);
  });
});
