import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  ContextBudgetError,
  fitContextArtifacts,
  truncateContextArtifact,
} from "../../src/lib/server/context-budget";

describe("context budget allocation", () => {
  it("fits artifacts deterministically while preserving fixed structure", () => {
    const input = {
      artifacts: [
        { id: "primary", content: "p".repeat(500), weight: 3 },
        { id: "secondary", content: "s".repeat(500), weight: 1 },
      ],
      maxCharacters: 260,
      render: (
        content: ReadonlyMap<string, string>,
        truncated: ReadonlySet<string>,
      ) =>
        JSON.stringify({
          requiredOrdinal: 1,
          primary: {
            content: content.get("primary"),
            truncated: truncated.has("primary"),
          },
          secondary: {
            content: content.get("secondary"),
            truncated: truncated.has("secondary"),
          },
        }),
    };
    const first = fitContextArtifacts(input);
    const second = fitContextArtifacts(input);

    expect(first.content).toBe(second.content);
    expect(first.content.length).toBeLessThanOrEqual(input.maxCharacters);
    expect(first.content).toContain('"requiredOrdinal":1');
    expect(first.artifactContent.get("primary")!.length)
      .toBeGreaterThan(first.artifactContent.get("secondary")!.length);
    expect(first.truncatedArtifactIds).toEqual(new Set(["primary", "secondary"]));
    expect(first.content).toContain('"truncated":true');
  });

  it("keeps complete content when it already fits", () => {
    const fitted = fitContextArtifacts({
      artifacts: [{ id: "only", content: "Complete evidence", weight: 1 }],
      maxCharacters: 100,
      render: (content) => `fixed:${content.get("only")}`,
    });
    expect(fitted.content).toBe("fixed:Complete evidence");
    expect(fitted.truncatedArtifactIds.size).toBe(0);
  });

  it("fails when required fixed structure cannot fit", () => {
    expect(() => fitContextArtifacts({
      artifacts: [{ id: "only", content: "x".repeat(100), weight: 1 }],
      maxCharacters: 10,
      render: (content) => `required-structure:${content.get("only")}`,
    })).toThrow(new ContextBudgetError("minimum-too-large"));
  });

  it("bounds text without injecting application syntax into untrusted content", () => {
    const result = truncateContextArtifact("x".repeat(100), 40);
    expect(result).toHaveLength(40);
    expect(result).toBe("x".repeat(40));
  });
});
