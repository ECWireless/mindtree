import { describe, expect, it } from "vitest";

import {
  formatBreadcrumb,
  getMoveDestinations,
  getNodeDropDestination,
  getRootEndDestination,
  searchNodes,
} from "../../src/lib/nodes/presentation";
import { assembleNodeTree, type FlatNode } from "../../src/lib/nodes/tree";

const flatNodes = [
  { id: "alpha", parentId: null, position: 0, title: "Alpha Systems", archivedAt: null },
  { id: "child", parentId: "alpha", position: 0, title: "Feedback Loop", archivedAt: null },
  { id: "grandchild", parentId: "child", position: 0, title: "Deep Signal", archivedAt: null },
  { id: "beta", parentId: null, position: 1, title: "Beta systems", archivedAt: "2026-01-01" },
  { id: "beta-child", parentId: "beta", position: 0, title: "Other work", archivedAt: null },
] satisfies readonly FlatNode[];

describe("node presentation", () => {
  const tree = assembleNodeTree(flatNodes);

  it("searches titles case-insensitively in stable tree order", () => {
    expect(searchNodes(tree.ordered, " SYSTEMS ").map(({ id }) => id)).toEqual(["alpha", "beta"]);
    expect(searchNodes(tree.ordered, "feedback").map(({ id }) => id)).toEqual(["child"]);
    expect(searchNodes(tree.ordered, "   ")).toEqual([]);
    expect(formatBreadcrumb(tree.byId.get("grandchild")!)).toBe(
      "Alpha Systems / Feedback Loop / Deep Signal",
    );
  });

  it("excludes the moving subtree from searchable destinations", () => {
    const source = tree.byId.get("child")!;
    expect(getMoveDestinations(tree.ordered, source, "").map(({ id }) => id)).toEqual([
      "alpha",
      "beta",
      "beta-child",
    ]);
    expect(getMoveDestinations(tree.ordered, source, "other").map(({ id }) => id)).toEqual([
      "beta-child",
    ]);
  });

  it("maps before, after, and inside drops to contiguous destination positions", () => {
    const source = tree.byId.get("child")!;
    const beta = tree.byId.get("beta")!;
    const betaChild = tree.byId.get("beta-child")!;

    expect(getNodeDropDestination(tree.ordered, source, beta, "before")).toEqual({
      parentId: null,
      position: 1,
      targetId: "beta",
      zone: "before",
    });
    expect(getNodeDropDestination(tree.ordered, source, beta, "after")).toEqual({
      parentId: null,
      position: 2,
      targetId: "beta",
      zone: "after",
    });
    expect(getNodeDropDestination(tree.ordered, source, betaChild, "inside")).toEqual({
      parentId: "beta-child",
      position: 0,
      targetId: "beta-child",
      zone: "inside",
    });
  });

  it("rejects self and subtree destinations and computes root-end movement", () => {
    const source = tree.byId.get("child")!;
    const descendant = tree.byId.get("grandchild")!;
    expect(getNodeDropDestination(tree.ordered, source, source, "inside")).toBeNull();
    expect(getNodeDropDestination(tree.ordered, source, descendant, "inside")).toBeNull();
    expect(getNodeDropDestination(tree.ordered, source, descendant, "after")).toBeNull();
    expect(getRootEndDestination(tree.ordered, source)).toEqual({ parentId: null, position: 2 });
  });
});
