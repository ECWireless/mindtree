import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  decryptBranchShareSecret,
  digestBranchShareSecret,
  encryptBranchShareSecret,
  generateBranchShareSecret,
} from "@/lib/server/share-capability";

const encryptionKey = Buffer.alloc(32, 11).toString("base64url");
const otherEncryptionKey = Buffer.alloc(32, 12).toString("base64url");

function binding() {
  return {
    linkId: randomUUID(),
    userId: `synthetic-user-${randomUUID()}`,
    rootNodeId: randomUUID(),
  };
}

describe("branch share capability encryption", () => {
  it("round-trips an unguessable secret without storing plaintext", () => {
    const secret = generateBranchShareSecret();
    const shareBinding = binding();
    const envelope = encryptBranchShareSecret(secret, encryptionKey, shareBinding);

    if (!envelope) throw new Error("Expected a synthetic encrypted envelope.");

    expect(envelope).toMatch(
      /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{58}\.[A-Za-z0-9_-]{22}$/,
    );
    expect(envelope).not.toContain(secret);
    expect(digestBranchShareSecret(secret)).toMatch(/^[0-9a-f]{64}$/);
    expect(decryptBranchShareSecret(envelope, encryptionKey, shareBinding)).toBe(secret);
  });

  it("fails closed for the wrong key, binding, malformed envelope, or secret", () => {
    const secret = generateBranchShareSecret();
    const shareBinding = binding();
    const envelope = encryptBranchShareSecret(secret, encryptionKey, shareBinding)!;

    expect(decryptBranchShareSecret(envelope, otherEncryptionKey, shareBinding)).toBeNull();
    expect(decryptBranchShareSecret(envelope, encryptionKey, {
      ...shareBinding,
      rootNodeId: randomUUID(),
    })).toBeNull();
    expect(decryptBranchShareSecret(`${envelope}tampered`, encryptionKey, shareBinding)).toBeNull();
    expect(encryptBranchShareSecret("malformed", encryptionKey, shareBinding)).toBeNull();
    expect(encryptBranchShareSecret(secret, "malformed", shareBinding)).toBeNull();
    expect(encryptBranchShareSecret(secret, "a".repeat(43), shareBinding)).toBeNull();
  });
});
