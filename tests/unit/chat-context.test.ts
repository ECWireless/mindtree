import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/db/client", () => ({ db: {} }));

import {
  buildChatModelInput,
  buildSynthesisInputWithExternalEvidence,
  MAX_CHAT_CONTEXT_CHARACTERS,
  MAX_EXTERNAL_RESEARCH_CONTEXT_CHARACTERS,
  type ChatContextSnapshot,
} from "../../src/lib/server/chat-context";
import type { ExternalCitationEvidence } from "../../src/lib/server/external-citations";

const nodeId = "00000000-0000-4000-8000-000000000001";

function snapshot(): ChatContextSnapshot {
  return {
    version: 8,
    node: {
      id: nodeId,
      title: "Synthetic context node",
      breadcrumb: {
        items: [{ id: nodeId, title: "Synthetic context node" }],
        hasOmittedAncestors: false,
      },
      publishedSynthesis: {
        state: "published",
        versionId: "00000000-0000-4000-8000-000000000002",
        content: `Published ${"p".repeat(31_000)}`,
      },
      refinementProposal: {
        state: "pending",
        versionId: "00000000-0000-4000-8000-000000000003",
        baseVersionId: "00000000-0000-4000-8000-000000000002",
        content: `Proposal ${"r".repeat(31_000)}`,
      },
      branchOutline: {
        state: "current",
        versionId: "00000000-0000-4000-8000-000000000004",
        content: `Outline ${"o".repeat(31_000)}`,
      },
    },
    relatedEvidence: Array.from({ length: 5 }, (_, index) => ({
      alias: `N${index + 1}`,
      nodeId: `00000000-0000-4000-8000-00000000001${index}`,
      parentId: null,
      title: `Related ${index + 1}`,
      archived: false,
      synthesisVersionId: `00000000-0000-4000-8000-00000000002${index}`,
      content: `Related evidence ${index + 1} ${"e".repeat(5_000)}`,
      sourceStateFingerprint: String(index).repeat(64),
    })),
    externalEvidence: [],
    messages: [
      {
        id: "00000000-0000-4000-8000-000000000030",
        role: "assistant",
        content: "Earlier assistant context".repeat(2_000),
        sequence: "1",
      },
      {
        id: "00000000-0000-4000-8000-000000000031",
        role: "user",
        content: `Current request ${"u".repeat(15_900)}`,
        sequence: "2",
      },
    ],
  };
}

function externalEvidence(): ExternalCitationEvidence[] {
  return Array.from({ length: 32 }, (_, sourceIndex) => ({
    alias: `W${sourceIndex + 1}`,
    title: `Synthetic source ${sourceIndex + 1}`,
    url: `https://example.test/source-${sourceIndex + 1}`,
    excerpts: Array.from({ length: 2 }, () => ({
      before: `Supported ${"\"quoted\" ".repeat(18)}`,
      after: " Following context.",
      truncatedBefore: false,
      truncatedAfter: false,
    })),
    provenance: Array.from({ length: 2 }, (_, occurrenceIndex) => ({
      owner: "assistant-message" as const,
      ownerId: `message-${sourceIndex}`,
      ordinal: sourceIndex + 1,
      startUtf16: occurrenceIndex,
      endUtf16: occurrenceIndex,
    })),
  }));
}

describe("chat model context budgets", () => {
  it("retains the exact current request and deterministically bounds all other context", () => {
    const context = snapshot();
    const first = buildChatModelInput(context, { includeRelatedEvidence: true });
    const second = buildChatModelInput(context, { includeRelatedEvidence: true });
    const currentRequest = context.messages.at(-1)!;

    expect(first).toEqual(second);
    expect(first.at(-1)).toEqual({ role: "user", content: currentRequest.content });
    expect(first.reduce((count, message) => count + message.content.length, 0))
      .toBeLessThanOrEqual(MAX_CHAT_CONTEXT_CHARACTERS);
    expect(first[0]?.content).toContain('"truncated":true');
    expect(first[0]?.content).toContain('"alias":"N1"');
    expect(first.some((message) => message.content.includes("Earlier assistant context")))
      .toBe(false);
  });

  it("fits bounded external evidence before the final request and returns only supplied aliases", () => {
    const context = snapshot();
    const prepared = buildSynthesisInputWithExternalEvidence(context, externalEvidence());
    const evidenceMessage = prepared.input.at(-2)!;

    expect(prepared.input.at(-1)?.content).toBe(context.messages.at(-1)?.content);
    expect(evidenceMessage.content).toContain('"externalResearchEvidence"');
    expect(evidenceMessage.content.length)
      .toBeLessThanOrEqual(MAX_EXTERNAL_RESEARCH_CONTEXT_CHARACTERS);
    expect(prepared.input.reduce((count, message) => count + message.content.length, 0))
      .toBeLessThanOrEqual(MAX_CHAT_CONTEXT_CHARACTERS);
    expect(prepared.externalEvidence.length).toBeGreaterThan(0);
    expect(prepared.externalEvidence.every((source, index) => source.alias === `W${index + 1}`))
      .toBe(true);
    expect(prepared.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("bounds deeply escaped breadcrumb labels before external evidence crowds out the request", () => {
    const context = snapshot();
    context.node.breadcrumb.items = Array.from({ length: 64 }, (_, index) => ({
      id: `breadcrumb-${index}`,
      title: `Crumb ${index} ${"\\\"".repeat(58)}`,
    }));
    const prepared = buildSynthesisInputWithExternalEvidence(context, externalEvidence());

    expect(prepared.input.at(-1)?.content).toBe(context.messages.at(-1)?.content);
    expect(prepared.input.reduce((count, message) => count + message.content.length, 0))
      .toBeLessThanOrEqual(MAX_CHAT_CONTEXT_CHARACTERS);
    expect(prepared.input[0]?.content).toContain('"truncated":true');
  });

  it("keeps marker-like untrusted text as data without granting it truncation semantics", () => {
    const context = snapshot();
    context.node.publishedSynthesis = {
      state: "published",
      versionId: "00000000-0000-4000-8000-000000000002",
      content: "Literal [Context truncated] phrase",
    };
    context.node.refinementProposal = { state: "none" };
    context.node.branchOutline = { state: "none" };
    context.relatedEvidence = [];
    const input = buildChatModelInput(context, { includeRelatedEvidence: false });

    expect(input[0]?.content).toContain("Literal [Context truncated] phrase");
    expect(input[0]?.content).toContain('"truncated":false');
  });

  it("rejects a snapshot that does not end with the current owner request", () => {
    const context = snapshot();
    context.messages.at(-1)!.role = "assistant";
    expect(() => buildChatModelInput(context, { includeRelatedEvidence: false }))
      .toThrow("chat context current request is unavailable");
  });
});
