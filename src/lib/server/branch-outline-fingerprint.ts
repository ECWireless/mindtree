import "server-only";

import { createHash } from "node:crypto";

import type { BranchOutlineInputSnapshot } from "@/lib/branch-outlines/contracts";

type BranchOutlineSourceState = Omit<
  BranchOutlineInputSnapshot,
  "sourceStateFingerprint"
> & {
  title: string;
  archivedAt: string | null;
};

function sha256(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

export function fingerprintBranchOutlineSourceState(
  state: BranchOutlineSourceState,
) {
  return sha256({ version: 1, ...state });
}

export function fingerprintBranchOutlineGeneration(input: {
  nodeId: string;
  nodeTitle: string;
  nodeArchivedAt: string | null;
  baseSynthesisVersionId: string | null;
  inputs: readonly BranchOutlineInputSnapshot[];
}) {
  return sha256({
    version: 1,
    nodeId: input.nodeId,
    nodeTitle: input.nodeTitle,
    nodeArchivedAt: input.nodeArchivedAt,
    baseSynthesisVersionId: input.baseSynthesisVersionId,
    inputs: input.inputs.map((source) => ({
      sourceNodeId: source.sourceNodeId,
      sourceSynthesisVersionId: source.sourceSynthesisVersionId,
      sourceBranchOutlineVersionId: source.sourceBranchOutlineVersionId,
      summaryState: source.summaryState,
      outlineState: source.outlineState,
      sourceStateFingerprint: source.sourceStateFingerprint,
      position: source.position,
    })),
  });
}

export function fingerprintBranchOutlineModelInput(
  nodeId: string,
  input: readonly { role: "user"; content: string }[],
  sourceStateFingerprint: string,
) {
  return sha256({
    version: 1,
    policy: "branch-outline-context-v1",
    nodeId,
    input,
    sourceStateFingerprint,
  });
}
