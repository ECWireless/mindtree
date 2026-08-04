import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/nodes", () => ({
  moveNode: vi.fn(),
}));

import { MoveNodeDialog } from "@/components/move-node-dialog";
import { assembleNodeTree, type FlatNode } from "@/lib/nodes/tree";

describe("MoveNodeDialog", () => {
  it("bounds unfiltered destinations and disambiguates repeated titles by breadcrumb", () => {
    const flatNodes: FlatNode[] = [
      { id: "source", parentId: null, position: 0, title: "Source", archivedAt: null },
      { id: "parent-a", parentId: null, position: 1, title: "Parent A", archivedAt: null },
      { id: "duplicate-a", parentId: "parent-a", position: 0, title: "Duplicate", archivedAt: null },
      { id: "parent-b", parentId: null, position: 2, title: "Parent B", archivedAt: null },
      { id: "duplicate-b", parentId: "parent-b", position: 0, title: "Duplicate", archivedAt: null },
      ...Array.from({ length: 98 }, (_, index) => ({
        id: `extra-${index}`,
        parentId: null,
        position: index + 3,
        title: `Extra ${index}`,
        archivedAt: null,
      })),
    ];
    const tree = assembleNodeTree(flatNodes);
    const markup = renderToStaticMarkup(
      <MoveNodeDialog
        node={tree.byId.get("source")!}
        nodes={tree.ordered}
        onClose={vi.fn()}
        onMoved={vi.fn()}
        returnFocusRef={{ current: null }}
      />,
    );

    expect(markup).toContain("Showing the first 100 of 102 destinations");
    expect(markup).toContain("Load 2 more destinations");
    expect(markup.match(/class="move-result"/g)).toHaveLength(100);
    expect(markup).toContain('aria-label="Move inside Parent A / Duplicate"');
    expect(markup).toContain('aria-label="Move inside Parent B / Duplicate"');
    expect(markup).toContain('aria-busy="false"');
  });
});
