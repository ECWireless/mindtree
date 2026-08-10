import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BranchOutlineDocumentContent } from "../../src/components/chat-message-content";

describe("Branch Outline document content", () => {
  it("preserves explicit list semantics when visual markers are replaced", () => {
    const unordered = renderToStaticMarkup(
      <BranchOutlineDocumentContent content={"- First branch\n- Second branch"} />,
    );
    const ordered = renderToStaticMarkup(
      <BranchOutlineDocumentContent content={"1. First branch\n2. Second branch"} />,
    );

    expect(unordered).toContain('<ul role="list">');
    expect(ordered).toContain('<ol role="list">');
  });
});
