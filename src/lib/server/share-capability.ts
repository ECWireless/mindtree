import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

import {
  BRANCH_SHARE_SECRET_BYTES,
  branchShareSecretSchema,
} from "@/lib/sharing/contracts";
import { parseShareLinkEncryptionKey } from "@/lib/server/share-encryption-key";

const SHARE_ENCRYPTION_ALGORITHM = "aes-256-gcm";
const SHARE_ENCRYPTION_IV_BYTES = 12;
const SHARE_ENCRYPTION_TAG_BYTES = 16;
const SHARE_ENCRYPTION_ENVELOPE =
  /^v1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{58})\.([A-Za-z0-9_-]{22})$/;

export type BranchShareSecretBinding = {
  linkId: string;
  userId: string;
  rootNodeId: string;
};

function shareSecretAdditionalData(binding: BranchShareSecretBinding) {
  return Buffer.from(
    `mindtree:branch-share:v1\0${binding.linkId}\0${binding.userId}\0${binding.rootNodeId}`,
    "utf8",
  );
}

export function generateBranchShareSecret() {
  return randomBytes(BRANCH_SHARE_SECRET_BYTES).toString("base64url");
}

export function digestBranchShareSecret(secret: string) {
  const parsed = branchShareSecretSchema.safeParse(secret);
  if (!parsed.success) return null;
  return createHash("sha256").update(parsed.data, "utf8").digest("hex");
}

export function encryptBranchShareSecret(
  secret: string,
  encryptionKey: string,
  binding: BranchShareSecretBinding,
) {
  const parsedSecret = branchShareSecretSchema.safeParse(secret);
  const key = parseShareLinkEncryptionKey(encryptionKey);
  if (!parsedSecret.success || !key) return null;

  const iv = randomBytes(SHARE_ENCRYPTION_IV_BYTES);
  const cipher = createCipheriv(SHARE_ENCRYPTION_ALGORITHM, key, iv, {
    authTagLength: SHARE_ENCRYPTION_TAG_BYTES,
  });
  cipher.setAAD(shareSecretAdditionalData(binding));
  const ciphertext = Buffer.concat([
    cipher.update(parsedSecret.data, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${ciphertext.toString("base64url")}.${tag.toString("base64url")}`;
}

export function decryptBranchShareSecret(
  envelope: string,
  encryptionKey: string,
  binding: BranchShareSecretBinding,
) {
  const match = SHARE_ENCRYPTION_ENVELOPE.exec(envelope);
  const key = parseShareLinkEncryptionKey(encryptionKey);
  if (!match || !key) return null;

  try {
    const iv = Buffer.from(match[1]!, "base64url");
    const ciphertext = Buffer.from(match[2]!, "base64url");
    const tag = Buffer.from(match[3]!, "base64url");
    const decipher = createDecipheriv(SHARE_ENCRYPTION_ALGORITHM, key, iv, {
      authTagLength: SHARE_ENCRYPTION_TAG_BYTES,
    });
    decipher.setAAD(shareSecretAdditionalData(binding));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
    return branchShareSecretSchema.safeParse(plaintext).success ? plaintext : null;
  } catch {
    return null;
  }
}
