import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  BranchOutlineOutputError,
  compileBranchOutlineModelOutput,
  requireBranchOutlineOutputFeasible,
} from "../../src/lib/server/branch-outline-output";

describe("Branch Outline model output", () => {
  it("validates stable ordinals and assembles title-safe Markdown server-side", () => {
    expect(compileBranchOutlineModelOutput(JSON.stringify({
      items: [{ ordinal: 1, description: "Connects research planning to delivery." }, {
        ordinal: 2,
        description: "Relates the implementation thread to its deeper decisions.",
      }],
    }), [
      "Research [Q3]\n<draft>",
      "Pipe | *star* `tick`_path\\next",
    ])).toEqual({
      content: "- Research (Q3) ‹draft› — Connects research planning to delivery.\n" +
        "- Pipe ¦ ∗star∗ 'tick'＿path／next — Relates the implementation thread to its deeper decisions.",
    });
  });

  it.each([
    ["not JSON", ["Child"]],
    [JSON.stringify({ items: [] }), ["Child"]],
    [JSON.stringify({ items: [{ ordinal: 2, description: "Wrong order." }] }), ["Child"]],
    [JSON.stringify({
      items: [{ ordinal: 1, description: "First." }, { ordinal: 1, description: "Duplicate." }],
    }), ["First", "Second"]],
    [JSON.stringify({
      items: [{ ordinal: 1, description: "Child." }],
      extra: true,
    }), ["Child"]],
    [JSON.stringify({ items: [{ ordinal: 1, description: "Two\nlines." }] }), ["Child"]],
    [JSON.stringify({
      items: [{ ordinal: 1, description: "Summary and Branch Outline unavailable." }],
    }), ["Child"]],
    [JSON.stringify({ items: [{ ordinal: 1, description: "Not archived." }] }), ["Child"]],
    [JSON.stringify({ items: [{ ordinal: 1, description: "No Summary exists." }] }), ["Child"]],
    [JSON.stringify({
      items: [{ ordinal: 1, description: "This child has no Branch Outline." }],
    }), ["Child"]],
    [JSON.stringify({ items: [{ ordinal: 1, description: "It lacks a Summary." }] }), ["Child"]],
    [JSON.stringify({ items: [{ ordinal: 1, description: "Summary absent." }] }), ["Child"]],
    [JSON.stringify({
      items: [{ ordinal: 1, description: "Without an outline, its role is unclear." }],
    }), ["Child"]],
    [JSON.stringify({
      items: [{ ordinal: 1, description: "The Branch Outline was not provided." }],
    }), ["Child"]],
    [JSON.stringify({
      items: [{ ordinal: 1, description: "No context was provided." }],
    }), ["Child"]],
    [JSON.stringify({
      items: [{ ordinal: 1, description: "No evidence has been provided." }],
    }), ["Child"]],
    [JSON.stringify({
      items: [{ ordinal: 1, description: "No context had been available." }],
    }), ["Child"]],
    [JSON.stringify({
      items: [{ ordinal: 1, description: "This node is in the archive." }],
    }), ["Child"]],
    [JSON.stringify({ items: [{ ordinal: 1, description: "Unsafe <script>." }] }), ["Child"]],
  ])("rejects malformed, reordered, extra, unsafe, or metadata output", (raw, titles) => {
    expect(() => compileBranchOutlineModelOutput(raw, titles)).toThrow(
      new BranchOutlineOutputError("invalid-output"),
    );
  });

  it("allows literal truncation language as ordinary output", () => {
    expect(compileBranchOutlineModelOutput(JSON.stringify({
      items: [{ ordinal: 1, description: "Discusses a context truncated boundary." }],
    }), ["Child"])).toEqual({
      content: "- Child — Discusses a context truncated boundary.",
    });
  });

  it("allows domain language that is not artifact or node status", () => {
    expect(compileBranchOutlineModelOutput(JSON.stringify({
      items: [{
        ordinal: 1,
        description: "Preserves archived newspaper records for the research workflow.",
      }, {
        ordinal: 2,
        description: "Maintains focus without context switching or evidence loss.",
      }],
    }), ["Historical sources", "Deep work"])).toEqual({
      content: "- Historical sources — Preserves archived newspaper records for the research workflow.\n" +
        "- Deep work — Maintains focus without context switching or evidence loss.",
    });
  });

  it("rejects a structurally impossible direct-child set before generation", () => {
    expect(() => requireBranchOutlineOutputFeasible(
      Array.from({ length: 1_000 }, () => "x"),
    )).toThrow(new BranchOutlineOutputError("output-too-large"));
  });
});
