import "server-only";

import { createHash } from "node:crypto";

export function fingerprintSynthesisOutlineInput(input: {
  nodeId: string;
  branchOutlineVersionId: string;
}) {
  return createHash("sha256")
    .update(JSON.stringify({ version: 1, ...input }), "utf8")
    .digest("hex");
}

export function fingerprintSynthesisRelatedInput(input: {
  nodeId: string;
  synthesisVersionId: string;
}) {
  return createHash("sha256")
    .update(JSON.stringify({ version: 1, ...input }), "utf8")
    .digest("hex");
}
