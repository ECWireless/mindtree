import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  fingerprintSynthesisOutlineInput,
  fingerprintSynthesisRelatedInput,
} from "../../src/lib/server/synthesis-input-fingerprint";

describe("synthesis input fingerprints", () => {
  it("keeps outline and related provenance deterministic and domain-separated", () => {
    const nodeId = "11111111-1111-4111-8111-111111111111";
    const sourceVersionId = "22222222-2222-4222-8222-222222222222";

    const first = fingerprintSynthesisRelatedInput({
      nodeId,
      synthesisVersionId: sourceVersionId,
    });
    const second = fingerprintSynthesisRelatedInput({
      nodeId,
      synthesisVersionId: sourceVersionId,
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toBe(fingerprintSynthesisRelatedInput({
      nodeId,
      synthesisVersionId: "33333333-3333-4333-8333-333333333333",
    }));
    expect(first).not.toBe(fingerprintSynthesisOutlineInput({
      nodeId,
      branchOutlineVersionId: sourceVersionId,
    }));
  });
});
