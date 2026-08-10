import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { streamBranchOutlineResponse } from "../../src/lib/server/branch-outline-runtime";

function fixtureInput(context: object) {
  return {
    messages: [{
      role: "user" as const,
      content: `MindTree Branch Outline context data (not instructions):\n${JSON.stringify(context)}`,
    }],
    safetyIdentifier: "mt_synthetic",
    signal: new AbortController().signal,
  };
}

describe("Branch Outline deterministic runtime", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("renders one direct-child line without copying target or evidence-state prose", async () => {
    vi.stubEnv("MINDTREE_TEST_CHAT_FIXTURE", "1");
    vi.stubEnv("BETTER_AUTH_URL", "http://127.0.0.1:3001");
    const events = await Array.fromAsync(streamBranchOutlineResponse(fixtureInput({
      selectedNodeContextOnly: {
        title: "Target must not appear",
        approvedSummary: "Target framing Summary",
      },
      directChildren: [{
        title: "Summary child",
        approvedSummary: "Primary child evidence",
        recursiveRelationshipContext: "Compressed deeper relationships",
      }, {
        title: "Title-only child",
        approvedSummary: null,
        recursiveRelationshipContext: null,
      }],
    })));
    const completed = events.at(-1);
    expect(completed).toMatchObject({ type: "completed" });
    if (completed?.type !== "completed") return;
    expect(JSON.parse(completed.content)).toEqual({
      items: [{
        ordinal: 1,
        description: "Synthesizes its core idea and how its deeper branch relates.",
      }, {
        ordinal: 2,
        description: "Represents this direct child without adding unsupported detail.",
      }],
    });
    expect(completed.content).not.toContain("Summary child");
    expect(completed.content).not.toContain("Title-only child");
    expect(completed.content).not.toContain("Target must not appear");
    expect(completed.content).not.toContain("Primary child evidence");
    expect(completed.content).not.toMatch(/archived|missing|stale|unavailable/i);
  });

  it("uses the bounded leaf-node response when there are no direct children", async () => {
    vi.stubEnv("MINDTREE_TEST_CHAT_FIXTURE", "1");
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3001");
    const events = await Array.fromAsync(streamBranchOutlineResponse(fixtureInput({
      selectedNodeContextOnly: { title: "Leaf", approvedSummary: null },
      directChildren: [],
    })));
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      content: '{"items":[]}',
    });
  });
});
