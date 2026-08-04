import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/nodes", () => ({
  deleteNode: vi.fn(),
}));

import { DeleteNodeDialog } from "@/components/delete-node-dialog";
import { assembleNodeTree } from "@/lib/nodes/tree";
import { syntheticDashboardNodes } from "../fixtures/dashboard";

describe("DeleteNodeDialog", () => {
  it("renders explicit irreversible subtree confirmation with a safe cancel action", () => {
    const node = assembleNodeTree(syntheticDashboardNodes).byId.get("feedback");
    if (!node) {
      throw new Error("Expected synthetic selected node.");
    }

    const markup = renderToStaticMarkup(
      <DeleteNodeDialog
        node={node}
        onClose={vi.fn()}
        onDeleted={vi.fn()}
        returnFocusRef={createRef<HTMLButtonElement>()}
      />,
    );

    expect(markup).toContain('aria-labelledby="delete-node-title"');
    expect(markup).toContain('aria-describedby="delete-node-description"');
    expect(markup).toContain("Permanently delete Feedback loops?");
    expect(markup).toContain("every descendant");
    expect(markup).toContain("This cannot be undone");
    expect(markup).toContain("Archive instead");
    expect(markup).toContain("Delete permanently");
    expect(markup).toContain(">Cancel</button>");
    expect(markup).toContain('data-tooltip="Close"');
  });
});
