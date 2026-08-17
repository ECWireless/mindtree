import { Buffer } from "node:buffer";

export function parseShareLinkEncryptionKey(value: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  const key = Buffer.from(value, "base64url");
  return key.length === 32 && key.toString("base64url") === value ? key : null;
}
