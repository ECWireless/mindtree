import { describe, expect, it } from "vitest";

import {
  assembleNodeTree,
  type FlatNode,
  NodeTreeDataError,
} from "../../src/lib/nodes/tree";

function node(index: number, overrides: Partial<FlatNode> = {}): FlatNode {
  return {
    id: `node-${index}`,
    parentId: index === 0 ? null : `node-${index - 1}`,
    position: 0,
    title: `Node ${index}`,
    archivedAt: null,
    ...overrides,
  };
}

describe("node tree assembly", () => {
  it("assembles stable depth-first order, breadcrumbs, and lookup state", () => {
    const tree = assembleNodeTree([
      node(3, { id: "second-root", parentId: null, position: 1, title: "Second root" }),
      node(2, {
        id: "second-child",
        parentId: "first-root",
        position: 1,
        title: "Second child",
      }),
      node(0, { id: "first-root", title: "First root" }),
      node(1, {
        id: "first-child",
        parentId: "first-root",
        title: "First child",
      }),
    ]);

    expect(tree.roots.map(({ id }) => id)).toEqual(["first-root", "second-root"]);
    expect(tree.ordered.map(({ id }) => id)).toEqual([
      "first-root",
      "first-child",
      "second-child",
      "second-root",
    ]);
    expect(tree.byId.get("second-child")).toMatchObject({
      depth: 1,
      breadcrumb: [
        { id: "first-root", title: "First root" },
        { id: "second-child", title: "Second child" },
      ],
    });
  });

  it("rejects duplicate IDs, missing parents, position corruption, and cycles", () => {
    expect(() => assembleNodeTree([node(0), node(0)])).toThrow(NodeTreeDataError);
    expect(() => assembleNodeTree([node(1, { parentId: "missing" })])).toThrow(
      "has a missing parent",
    );
    expect(() =>
      assembleNodeTree([
        node(0, { id: "first", parentId: null, position: 0 }),
        node(1, { id: "second", parentId: null, position: 2 }),
      ]),
    ).toThrow("non-contiguous positions");
    expect(() =>
      assembleNodeTree([
        node(0, { id: "first", parentId: "second" }),
        node(1, { id: "second", parentId: "first" }),
      ]),
    ).toThrow("A cycle makes node");
  });

  it("assembles a deeply nested tree without recursive stack growth", () => {
    const depth = 5_000;
    const tree = assembleNodeTree(Array.from({ length: depth }, (_, index) => node(index)));

    expect(tree.ordered).toHaveLength(depth);
    expect(tree.ordered.at(-1)).toMatchObject({
      id: `node-${depth - 1}`,
      depth: depth - 1,
    });
    expect(tree.byId.get(`node-${depth - 1}`)?.breadcrumb).toHaveLength(depth);
  });
});
