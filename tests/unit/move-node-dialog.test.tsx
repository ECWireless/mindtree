import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/nodes", () => ({
  moveNode: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { getMoveSearchPage, MoveNodeDialog } from "@/components/move-node-dialog";
import { formatBreadcrumb } from "@/lib/nodes/presentation";
import { assembleNodeTree, type FlatNode } from "@/lib/nodes/tree";

describe("MoveNodeDialog", () => {
  it("renders the TimeTree-style hierarchy browser with bounded level content", () => {
    const flatNodes: FlatNode[] = [
      { id: "source", parentId: null, position: 0, title: "Source", archivedAt: null },
      { id: "parent-a", parentId: null, position: 1, title: "Parent A", archivedAt: null },
      { id: "duplicate-a", parentId: "parent-a", position: 0, title: "Duplicate", archivedAt: null },
      { id: "parent-b", parentId: null, position: 2, title: "Parent B", archivedAt: null },
      { id: "duplicate-b", parentId: "parent-b", position: 0, title: "Duplicate", archivedAt: null },
      ...Array.from({ length: 101 }, (_, index) => ({
        id: `extra-${index}`,
        parentId: null,
        position: index + 3,
        title: `Destination ${index}`,
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

    expect(markup).toContain("Choose a new location for Source");
    expect(markup).toContain('class="move-browser"');
    expect(markup).toContain("Browsing");
    expect(markup).toContain("Move here");
    expect(markup).toContain('aria-label="Up one level"');
    expect(markup).toContain('data-tooltip="Close"');
    expect(markup).toContain('aria-label="Browse Parent A"');
    expect(markup).toContain('aria-label="Choose placement relative to Parent A"');
    expect(markup.match(/class="move-browser__node"/g)).toHaveLength(103);
    expect(markup).toContain('aria-busy="false"');

    const bounded = getMoveSearchPage(tree.ordered, tree.byId.get("source")!, "destination");
    expect(bounded.results).toHaveLength(101);
    expect(bounded.visibleResults).toHaveLength(100);

    const duplicates = getMoveSearchPage(tree.ordered, tree.byId.get("source")!, "duplicate");
    expect(duplicates.results.map(formatBreadcrumb)).toEqual([
      "Parent A / Duplicate",
      "Parent B / Duplicate",
    ]);
  });
});
