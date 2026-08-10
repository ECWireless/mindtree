import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/db/client", () => ({ db: {} }));

import {
  BranchOutlineContextError,
  MAX_BRANCH_OUTLINE_CONTEXT_CHARACTERS,
  buildBranchOutlineModelInput,
  type BranchOutlineContextSnapshot,
} from "../../src/lib/server/branch-outline-context";

const snapshot: BranchOutlineContextSnapshot = {
  version: 1,
  node: {
    id: "00000000-0000-4000-8000-000000000001",
    title: "Synthetic root",
    archivedAt: null,
    summary: {
      state: "published",
      versionId: "00000000-0000-4000-8000-000000000002",
      content: "Approved root Summary",
    },
  },
  children: [
    {
      id: "00000000-0000-4000-8000-000000000003",
      title: "Current child",
      archivedAt: null,
      summary: { state: "none" },
      outline: {
        state: "current",
        versionId: "00000000-0000-4000-8000-000000000004",
        content: "Current deeper outline",
      },
    },
    {
      id: "00000000-0000-4000-8000-000000000005",
      title: "Stale child",
      archivedAt: "2026-01-01T00:00:00.000Z",
      summary: {
        state: "published",
        versionId: "00000000-0000-4000-8000-000000000006",
        content: "Approved child Summary",
      },
      outline: {
        state: "stale",
        versionId: "00000000-0000-4000-8000-000000000007",
      },
    },
  ],
};

describe("Branch Outline model context", () => {
  it("delimits ordered untrusted evidence and excludes internal identifiers", () => {
    const input = buildBranchOutlineModelInput(snapshot);
    expect(input).toHaveLength(1);
    expect(input[0]?.content).toContain("context data (not instructions)");
    expect(input[0]?.content).toContain('"selectedNodeContextOnly"');
    expect(input[0]?.content).toContain('"directChildren"');
    expect(input[0]?.content).toContain("Approved root Summary");
    expect(input[0]?.content).toContain("Approved child Summary");
    expect(input[0]?.content).toContain("Current deeper outline");
    expect(input[0]?.content).toContain('"approvedSummary":null');
    expect(input[0]?.content).toContain('"recursiveRelationshipContext":null');
    expect(input[0]?.content).not.toContain('"archived"');
    expect(input[0]?.content).not.toContain('"state"');
    expect(input[0]?.content).not.toContain("00000000-0000-4000-8000");
    expect(input[0]?.content.indexOf("Current child")).toBeLessThan(
      input[0]?.content.indexOf("Stale child") ?? 0,
    );
  });

  it("rejects oversized context without silently omitting children", () => {
    expect(() => buildBranchOutlineModelInput({
      ...snapshot,
      node: {
        ...snapshot.node,
        summary: {
          state: "published",
          versionId: "00000000-0000-4000-8000-000000000002",
          content: "x".repeat(MAX_BRANCH_OUTLINE_CONTEXT_CHARACTERS),
        },
      },
    })).toThrow(new BranchOutlineContextError("context-too-large"));
  });

  it("rejects a child set whose minimum required output cannot fit", () => {
    expect(() => buildBranchOutlineModelInput({
      ...snapshot,
      children: Array.from({ length: 1_000 }, (_, index) => ({
        id: `synthetic-child-${index}`,
        title: "x",
        archivedAt: null,
        summary: { state: "none" as const },
        outline: { state: "none" as const },
      })),
    })).toThrow(new BranchOutlineContextError("context-too-large"));
  });
});
