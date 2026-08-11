import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ChatMessageContent,
  SynthesisDocumentContent,
} from "@/components/chat-message-content";

describe("assistant chat Markdown", () => {
  it("renders the approved formatting subset and strips links to plain text", () => {
    const markup = renderToStaticMarkup(
      <ChatMessageContent content={"**Strong** and [private](https://example.test/private)\n\n- One"} />,
    );

    expect(markup).toContain("<strong>Strong</strong>");
    expect(markup).toContain("<li>One</li>");
    expect(markup).toContain("private");
    expect(markup).not.toContain("href=");
    expect(markup).not.toContain("example.test");
  });

  it("does not render raw HTML or unsupported elements", () => {
    const markup = renderToStaticMarkup(
      <ChatMessageContent content={'<script>alert("private")</script>\n\n`secret`\n\n![alt](https://example.test/image.png)'} />,
    );

    expect(markup).not.toContain("<script");
    expect(markup).not.toContain("<code");
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("example.test");
  });
});

describe("internal synthesis citations", () => {
  it("renders application-owned navigation and changed-reference details", () => {
    const content = "A supported claim.";
    const markup = renderToStaticMarkup(
      <SynthesisDocumentContent
        content={content}
        citations={[{
          kind: "internal",
          ordinal: 1,
          startUtf16: 2,
          endUtf16: 17,
          snapshot: {
            nodeId: "old-node",
            title: "Prior title",
            synthesisVersionId: "12345678-1234-4234-8234-123456789012",
          },
          target: {
            state: "available",
            nodeId: "current-node",
            title: "Current title",
            synthesisVersionId: "12345678-1234-4234-8234-123456789012",
            renamed: true,
            moved: true,
            archived: true,
            changedRevision: true,
          },
        }]}
      />,
    );

    expect(markup).toContain('href="/?node=current-node"');
    expect(markup).toContain("Citation 1: Current title");
    expect(markup).toContain("Renamed from Prior title");
    expect(markup).toContain("Moved since cited");
    expect(markup).toContain("Archived");
    expect(markup).toContain("Summary changed since cited");
    expect(markup).toContain("Revision 12345678");
  });

  it("preserves an unavailable snapshot without creating a target link", () => {
    const markup = renderToStaticMarkup(
      <SynthesisDocumentContent
        content="Unavailable evidence"
        citations={[{
          kind: "internal",
          ordinal: 1,
          startUtf16: 0,
          endUtf16: 20,
          snapshot: {
            nodeId: "deleted-node",
            title: "Deleted title",
            synthesisVersionId: "abcdef12-1234-4234-8234-123456789012",
          },
          target: {
            state: "unavailable",
            deletedAt: "2026-08-11T00:00:00.000Z",
          },
        }]}
      />,
    );

    expect(markup).toContain("Unavailable thought — formerly Deleted title");
    expect(markup).not.toContain("node=deleted-node");
  });
});
