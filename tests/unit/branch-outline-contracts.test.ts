import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  branchOutlineDraftSchema,
  branchOutlineInputSnapshotSchema,
  claimBranchOutlineGenerationInputSchema,
} from "../../src/lib/branch-outlines/contracts";
import {
  fingerprintBranchOutlineGeneration,
  fingerprintBranchOutlineModelInput,
  fingerprintBranchOutlineSourceState,
} from "../../src/lib/server/branch-outline-fingerprint";

const nodeId = "00000000-0000-4000-8000-000000000001";
const sourceNodeId = "00000000-0000-4000-8000-000000000002";
const sourceSynthesisVersionId = "00000000-0000-4000-8000-000000000003";

describe("Branch Outline contracts", () => {
  it("uses the bounded Summary Markdown allowlist", () => {
    expect(branchOutlineDraftSchema.safeParse({
      content: "# Direction\n\n- First branch\n- **Second** branch",
    }).success).toBe(true);
    for (const content of [
      "<script>alert(1)</script>",
      "[Unsafe](https://example.test)",
      "```js\nalert(1)\n```",
      "   ",
    ]) {
      expect(branchOutlineDraftSchema.safeParse({ content }).success).toBe(false);
    }
  });

  it("requires explicit Summary and outline states to match their versions", () => {
    const fingerprint = "a".repeat(64);
    expect(branchOutlineInputSnapshotSchema.safeParse({
      sourceNodeId,
      sourceSynthesisVersionId: null,
      sourceBranchOutlineVersionId: null,
      summaryState: "none",
      outlineState: "none",
      sourceStateFingerprint: fingerprint,
      position: 0,
    }).success).toBe(true);
    expect(branchOutlineInputSnapshotSchema.safeParse({
      sourceNodeId,
      sourceSynthesisVersionId,
      sourceBranchOutlineVersionId: null,
      summaryState: "none",
      outlineState: "none",
      sourceStateFingerprint: fingerprint,
      position: 0,
    }).success).toBe(false);
    expect(branchOutlineInputSnapshotSchema.safeParse({
      sourceNodeId,
      sourceSynthesisVersionId: null,
      sourceBranchOutlineVersionId: null,
      summaryState: "none",
      outlineState: "current",
      sourceStateFingerprint: fingerprint,
      position: 0,
    }).success).toBe(false);
  });

  it("fingerprints exact ordered source states deterministically", () => {
    const sourceState = {
      sourceNodeId,
      sourceSynthesisVersionId,
      sourceBranchOutlineVersionId: null,
      summaryState: "published" as const,
      outlineState: "none" as const,
      position: 0,
      title: "Synthetic child",
      archivedAt: null,
    };
    const sourceStateFingerprint = fingerprintBranchOutlineSourceState(sourceState);
    const inputs = [{
      sourceNodeId,
      sourceSynthesisVersionId,
      sourceBranchOutlineVersionId: null,
      summaryState: "published" as const,
      outlineState: "none" as const,
      sourceStateFingerprint,
      position: 0,
    }];
    const fingerprint = fingerprintBranchOutlineGeneration({
      nodeId,
      nodeTitle: "Synthetic parent",
      nodeArchivedAt: null,
      baseSynthesisVersionId: null,
      inputs,
    });
    expect(sourceStateFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintBranchOutlineGeneration({
      nodeId,
      nodeTitle: "Synthetic parent",
      nodeArchivedAt: null,
      baseSynthesisVersionId: null,
      inputs,
    })).toBe(fingerprint);
    expect(fingerprintBranchOutlineGeneration({
      nodeId,
      nodeTitle: "Synthetic parent",
      nodeArchivedAt: null,
      baseSynthesisVersionId: null,
      inputs: [{ ...inputs[0]!, position: 1 }],
    })).not.toBe(fingerprint);
    expect(fingerprintBranchOutlineGeneration({
      nodeId,
      nodeTitle: "Synthetic parent",
      nodeArchivedAt: "2026-01-01T00:00:00.000Z",
      baseSynthesisVersionId: null,
      inputs,
    })).not.toBe(fingerprint);
    expect(claimBranchOutlineGenerationInputSchema.safeParse({
      nodeId,
      clientRequestId: "00000000-0000-4000-8000-000000000004",
      baseSynthesisVersionId: null,
      inputFingerprint: fingerprintBranchOutlineModelInput(nodeId, [{
        role: "user",
        content: "Exact bounded provider input",
      }], fingerprint),
      sourceStateFingerprint: fingerprint,
      inputs,
    }).success).toBe(true);
  });

  it("fingerprints the exact bounded Branch Outline provider input", () => {
    const sourceFingerprint = "f".repeat(64);
    const first = fingerprintBranchOutlineModelInput(nodeId, [{
      role: "user",
      content: "Bounded input A",
    }], sourceFingerprint);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintBranchOutlineModelInput(nodeId, [{
      role: "user",
      content: "Bounded input A",
    }], sourceFingerprint)).toBe(first);
    expect(fingerprintBranchOutlineModelInput(nodeId, [{
      role: "user",
      content: "Bounded input B",
    }], sourceFingerprint)).not.toBe(first);
    expect(fingerprintBranchOutlineModelInput(nodeId, [{
      role: "user",
      content: "Bounded input A",
    }], "e".repeat(64))).not.toBe(first);
  });
});
