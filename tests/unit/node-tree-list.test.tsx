import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { NodeTreeList } from "../../src/components/node-tree-list";
import { assembleNodeTree, type FlatNode } from "../../src/lib/nodes/tree";

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

describe("node tree list", () => {
  it("flattens expanded branches and declares each row's hierarchy", () => {
    const tree = assembleNodeTree([
      node(0, { id: "first-root", title: "First root" }),
      node(1, { id: "first-child", parentId: "first-root", title: "First child" }),
      node(2, {
        id: "second-child",
        parentId: "first-root",
        position: 1,
        title: "Second child",
      }),
      node(3, { id: "second-root", parentId: null, position: 1, title: "Second root" }),
      node(4, { id: "hidden-child", parentId: "second-root", title: "Hidden child" }),
    ]);

    const markup = renderToStaticMarkup(
      <NodeTreeList
        roots={tree.roots}
        expanded={new Set(["first-root"])}
        renderNode={(item) => createElement("span", null, item.title)}
      />,
    );

    expect(markup.match(/<li /g)).toHaveLength(4);
    expect(markup).toContain(
      '<li aria-level="1" aria-posinset="1" aria-setsize="2"><span>First root</span></li>',
    );
    expect(markup).toContain(
      '<li aria-level="2" aria-posinset="2" aria-setsize="2"><span>Second child</span></li>',
    );
    expect(markup.indexOf("First child")).toBeLessThan(markup.indexOf("Second child"));
    expect(markup).not.toContain("Hidden child");
  });

  it("renders a deeply expanded hierarchy without recursive stack growth", () => {
    const depth = 5_000;
    const tree = assembleNodeTree(Array.from({ length: depth }, (_, index) => node(index)));
    const expanded = new Set(tree.ordered.slice(0, -1).map(({ id }) => id));
    const markup = renderToStaticMarkup(
      <NodeTreeList
        roots={tree.roots}
        expanded={expanded}
        renderNode={(item) => createElement("span", null, item.title)}
      />,
    );

    expect(markup.match(/<li /g)).toHaveLength(depth);
    expect(markup).toContain('aria-level="5000"');
    expect(markup).toContain("Node 4999");
  });
});
