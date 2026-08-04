import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChatMessageContent } from "@/components/chat-message-content";

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
