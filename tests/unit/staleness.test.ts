import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  collectAncestorPathIds,
  StalenessTreeError,
} from "@/lib/server/staleness";

describe("recursive artifact staleness paths", () => {
  it("walks a deep owner tree iteratively without recursion", () => {
    const nodes = Array.from({ length: 5_000 }, (_, index) => ({
      id: `node-${index}`,
      parentId: index === 0 ? null : `node-${index - 1}`,
    }));

    const path = collectAncestorPathIds(nodes, "node-4999", { includeStart: true });
    expect(path).toHaveLength(5_000);
    expect(path[0]).toBe("node-4999");
    expect(path.at(-1)).toBe("node-0");
  });

  it("fails closed for missing nodes and cycles", () => {
    expect(() => collectAncestorPathIds([], "missing", { includeStart: true }))
      .toThrow(StalenessTreeError);
    expect(() => collectAncestorPathIds([
      { id: "first", parentId: "second" },
      { id: "second", parentId: "first" },
    ], "first", { includeStart: true })).toThrow(StalenessTreeError);
  });
});
