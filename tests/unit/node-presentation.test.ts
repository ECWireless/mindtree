import { describe, expect, it } from "vitest";

import {
  formatBreadcrumb,
  getMoveDestinations,
  getNodeDropDestination,
  getNodeDropZone,
  getRootEndDestination,
  getVisibleNodeRoots,
  searchNodes,
} from "../../src/lib/nodes/presentation";
import { assembleNodeTree, type FlatNode } from "../../src/lib/nodes/tree";

const synthesisState = {
  publishedSynthesisVersionId: null,
  synthesisStaleAt: null,
} as const;

const flatNodes = [
  { ...synthesisState, id: "alpha", parentId: null, position: 0, title: "Alpha Systems", archivedAt: null },
  { ...synthesisState, id: "child", parentId: "alpha", position: 0, title: "Feedback Loop", archivedAt: null },
  { ...synthesisState, id: "grandchild", parentId: "child", position: 0, title: "Deep Signal", archivedAt: null },
  { ...synthesisState, id: "beta", parentId: null, position: 1, title: "Beta systems", archivedAt: "2026-01-01" },
  { ...synthesisState, id: "beta-child", parentId: "beta", position: 0, title: "Other work", archivedAt: null },
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

  it("hides archived branches without changing the source tree or sibling positions", () => {
    const visibleRoots = getVisibleNodeRoots(tree.roots, false);
    expect(visibleRoots.map(({ id, position }) => [id, position])).toEqual([["alpha", 0]]);
    expect(visibleRoots[0]?.children[0]?.id).toBe("child");
    expect(tree.roots.map(({ id }) => id)).toEqual(["alpha", "beta"]);
    expect(getVisibleNodeRoots(tree.roots, true)).toBe(tree.roots);
  });

  it("filters a deeply nested tree without recursive stack growth", () => {
    let root: (typeof tree.roots)[number] = {
      id: "deep-4999",
      parentId: "deep-4998",
      position: 0,
      title: "Deep 4999",
      archivedAt: "2026-01-01T00:00:00.000Z",
      publishedSynthesisVersionId: null,
      synthesisStaleAt: null,
      children: [],
      breadcrumb: [],
      depth: 4_999,
    };
    for (let depth = 4_998; depth >= 0; depth -= 1) {
      root = {
        id: `deep-${depth}`,
        parentId: depth === 0 ? null : `deep-${depth - 1}`,
        position: 0,
        title: `Deep ${depth}`,
        archivedAt: null,
        publishedSynthesisVersionId: null,
        synthesisStaleAt: null,
        children: [root],
        breadcrumb: [],
        depth,
      };
    }

    const sourceRoots = [root];
    const visible = getVisibleNodeRoots(sourceRoots, false);
    expect(visible === sourceRoots).toBe(false);
    let current = visible[0];
    let count = 0;
    while (current) {
      count += 1;
      current = current.children[0];
    }
    expect(count).toBe(4_999);
  });

  it("excludes the moving subtree from searchable destinations", () => {
    const source = tree.byId.get("child")!;
    expect(getMoveDestinations(tree.ordered, source, "").map(({ id }) => id)).toEqual([
      "alpha",
      "beta",
    ]);
    expect(getMoveDestinations(tree.ordered, source, "other")).toEqual([]);
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
    expect(getNodeDropDestination(tree.ordered, source, beta, "inside")).toBeNull();
    expect(getNodeDropDestination(tree.ordered, source, betaChild, "inside")).toBeNull();
  });

  it("maps pointer positions to stable before, inside, and after zones", () => {
    const target = { top: 100, height: 80 };

    expect(getNodeDropZone(119, target)).toBe("before");
    expect(getNodeDropZone(120, target)).toBe("inside");
    expect(getNodeDropZone(152, target)).toBe("inside");
    expect(getNodeDropZone(153, target)).toBe("after");
    expect(getNodeDropZone(100, { top: 100, height: 0 })).toBeNull();
  });

  it("keeps root drop resolution valid after moving the source out of a child group", () => {
    const movedTree = assembleNodeTree([
      { ...synthesisState, id: "second", parentId: null, position: 0, title: "Second", archivedAt: null },
      { ...synthesisState, id: "existing", parentId: "second", position: 0, title: "Existing", archivedAt: null },
      { ...synthesisState, id: "first", parentId: "second", position: 1, title: "First", archivedAt: null },
      { ...synthesisState, id: "third", parentId: null, position: 1, title: "Third", archivedAt: null },
    ]);

    expect(
      getNodeDropDestination(
        movedTree.ordered,
        movedTree.byId.get("first")!,
        movedTree.byId.get("third")!,
        "before",
      ),
    ).toEqual({ parentId: null, position: 1, targetId: "third", zone: "before" });
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
