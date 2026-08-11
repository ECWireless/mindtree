import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  assignInternalEvidenceAliases,
  InternalCitationValidationError,
  normalizeInternalCitationMentions,
  type InternalCitationEvidence,
} from "../../src/lib/server/internal-citations";

const evidenceBase: Omit<InternalCitationEvidence, "alias"> = {
  nodeId: "11111111-1111-4111-8111-111111111111",
  parentId: null,
  title: "Synthetic evidence",
  archived: false,
  synthesisVersionId: "22222222-2222-4222-8222-222222222222",
  content: "Synthetic approved evidence",
  sourceStateFingerprint: "a".repeat(64),
};

describe("internal citation normalization", () => {
  it("assigns opaque stable aliases without exposing IDs", () => {
    expect(assignInternalEvidenceAliases([
      evidenceBase,
      { ...evidenceBase, nodeId: "33333333-3333-4333-8333-333333333333" },
    ]).map(({ alias }) => alias)).toEqual(["E1", "E2"]);
  });

  it("maps aliases to unique spans and computes ordered UTF-16 offsets", () => {
    const content = "😀 Alpha supports beta. Gamma follows.";
    const evidence = assignInternalEvidenceAliases([
      evidenceBase,
      { ...evidenceBase, nodeId: "33333333-3333-4333-8333-333333333333" },
    ]);

    const normalized = normalizeInternalCitationMentions({
      content,
      evidence,
      mentions: [
        { evidenceAlias: "E2", citedText: "Gamma follows" },
        { evidenceAlias: "E1", citedText: "Alpha supports beta" },
      ],
    });

    expect(normalized.map(({ ordinal, startUtf16, endUtf16, evidence }) => ({
      ordinal,
      startUtf16,
      endUtf16,
      alias: evidence.alias,
    }))).toEqual([
      { ordinal: 1, startUtf16: 3, endUtf16: 22, alias: "E1" },
      { ordinal: 2, startUtf16: 24, endUtf16: 37, alias: "E2" },
    ]);
  });

  it.each([
    {
      name: "unknown aliases",
      content: "Unique claim",
      mentions: [{ evidenceAlias: "E9", citedText: "Unique claim" }],
      reason: "unknown-evidence-alias",
    },
    {
      name: "missing or repeated spans",
      content: "Repeated claim and Repeated claim",
      mentions: [{ evidenceAlias: "E1", citedText: "Repeated claim" }],
      reason: "ambiguous-span",
    },
    {
      name: "overlapping spans",
      content: "One supported claim",
      mentions: [
        { evidenceAlias: "E1", citedText: "supported claim" },
        { evidenceAlias: "E2", citedText: "claim" },
      ],
      reason: "overlapping-span",
    },
  ])("rejects $name", ({ content, mentions, reason }) => {
    const evidence = assignInternalEvidenceAliases([
      evidenceBase,
      { ...evidenceBase, nodeId: "33333333-3333-4333-8333-333333333333" },
    ]);
    expect(() => normalizeInternalCitationMentions({ content, mentions, evidence }))
      .toThrowError(new InternalCitationValidationError(reason as never));
  });
});
