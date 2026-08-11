import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  calculateInternalTooltipPosition,
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

describe("internal synthesis links", () => {
  it("renders the supported phrase as an application-owned changed link", () => {
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
    expect(markup).toContain("internal-node-link internal-node-link--changed");
    expect(markup).toContain(">supported claim</a>");
    expect(markup).toContain("Linked thought: Current title");
    expect(markup).toContain('class="internal-node-tooltip" popover="manual"');
    expect(markup).toContain("Renamed from Prior title");
    expect(markup).toContain("Moved since linked");
    expect(markup).toContain("Archived");
    expect(markup).toContain("Summary changed since linked");
    expect(markup).toContain("Linked revision 12345678");
    expect(markup).not.toContain("[1]");
    expect(markup).not.toContain("Cited thoughts");
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

    expect(markup).toContain("Unavailable linked thought, formerly Deleted title");
    expect(markup).toContain("internal-node-link internal-node-link--unavailable");
    expect(markup).toContain('class="internal-node-tooltip" popover="manual"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain("Unavailable evidence<span aria-hidden=\"true\"");
    expect(markup).toContain(" (unavailable)</span>");
    expect(markup).not.toContain("node=deleted-node");
    expect(markup).not.toContain("[1]");
  });

  it("keeps exact-current provenance in the trusted link metadata", () => {
    const markup = renderToStaticMarkup(
      <SynthesisDocumentContent
        content="Current evidence"
        citations={[{
          kind: "internal",
          ordinal: 1,
          startUtf16: 0,
          endUtf16: 16,
          snapshot: {
            nodeId: "current-node",
            title: "Current title",
            synthesisVersionId: "12345678-1234-4234-8234-123456789012",
          },
          target: {
            state: "available",
            nodeId: "current-node",
            title: "Current title",
            synthesisVersionId: "12345678-1234-4234-8234-123456789012",
            renamed: false,
            moved: false,
            archived: false,
            changedRevision: false,
          },
        }]}
      />,
    );

    expect(markup).toContain('class="internal-node-link"');
    expect(markup).toContain(">Current evidence</a>");
    expect(markup).toContain("aria-describedby=");
    expect(markup).toContain('aria-label="Current evidence"');
    expect(markup).not.toContain("title=");
    expect(markup).toContain("Exact linked revision");
    expect(markup).toContain("Linked revision 12345678");
    expect(markup).not.toContain("Cited thoughts");
  });

  it("links multiple plain phrases inside emphasized Markdown without numbering them", () => {
    const content = "**Perceptron → Neural network**";
    const perceptronStart = content.indexOf("Perceptron");
    const neuralNetworkStart = content.indexOf("Neural network");
    const markup = renderToStaticMarkup(
      <SynthesisDocumentContent
        content={content}
        citations={[
          {
            kind: "internal",
            ordinal: 1,
            startUtf16: perceptronStart,
            endUtf16: perceptronStart + "Perceptron".length,
            snapshot: {
              nodeId: "perceptron-node",
              title: "Perceptron",
              synthesisVersionId: "11111111-1111-4111-8111-111111111111",
            },
            target: {
              state: "available",
              nodeId: "perceptron-node",
              title: "Perceptron",
              synthesisVersionId: "11111111-1111-4111-8111-111111111111",
              renamed: false,
              moved: false,
              archived: false,
              changedRevision: false,
            },
          },
          {
            kind: "internal",
            ordinal: 2,
            startUtf16: neuralNetworkStart,
            endUtf16: neuralNetworkStart + "Neural network".length,
            snapshot: {
              nodeId: "network-node",
              title: "Neural network",
              synthesisVersionId: "22222222-2222-4222-8222-222222222222",
            },
            target: {
              state: "available",
              nodeId: "network-node",
              title: "Neural network",
              synthesisVersionId: "22222222-2222-4222-8222-222222222222",
              renamed: false,
              moved: false,
              archived: false,
              changedRevision: false,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("<strong>");
    expect(markup).toContain(">Perceptron</a>");
    expect(markup).toContain(">Neural network</a>");
    expect(markup).not.toContain("[1]");
    expect(markup).not.toContain("[2]");
  });

  it("preserves Markdown blocks and fails closed for legacy spans outside text nodes", () => {
    const content = "# AI Progression\n\n- Perceptron";
    const perceptronStart = content.indexOf("Perceptron");
    const markup = renderToStaticMarkup(
      <SynthesisDocumentContent
        content={content}
        citations={[
          {
            kind: "internal",
            ordinal: 1,
            startUtf16: 0,
            endUtf16: "# AI Progression".length,
            snapshot: {
              nodeId: "legacy-heading-node",
              title: "Legacy heading",
              synthesisVersionId: "11111111-1111-4111-8111-111111111111",
            },
            target: {
              state: "available",
              nodeId: "legacy-heading-node",
              title: "Legacy heading",
              synthesisVersionId: "11111111-1111-4111-8111-111111111111",
              renamed: false,
              moved: false,
              archived: false,
              changedRevision: false,
            },
          },
          {
            kind: "internal",
            ordinal: 2,
            startUtf16: perceptronStart,
            endUtf16: perceptronStart + "Perceptron".length,
            snapshot: {
              nodeId: "perceptron-node",
              title: "Perceptron",
              synthesisVersionId: "22222222-2222-4222-8222-222222222222",
            },
            target: {
              state: "available",
              nodeId: "perceptron-node",
              title: "Perceptron",
              synthesisVersionId: "22222222-2222-4222-8222-222222222222",
              renamed: false,
              moved: false,
              archived: false,
              changedRevision: false,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("<h4>AI Progression</h4>");
    expect(markup).toContain('<li><a aria-describedby=');
    expect(markup).toContain('href="/?node=perceptron-node"');
    expect(markup).not.toContain("node=legacy-heading-node");
  });
});

describe("internal node tooltip positioning", () => {
  it("clamps both horizontal edges and chooses the roomier vertical side", () => {
    const tooltip = { width: 288, height: 48 };
    const left = calculateInternalTooltipPosition({
      target: { top: 100, right: 20, bottom: 120, left: 0, width: 20, height: 20 },
      tooltip,
      viewportWidth: 1000,
      viewportHeight: 600,
    });
    const right = calculateInternalTooltipPosition({
      target: { top: 100, right: 1000, bottom: 120, left: 980, width: 20, height: 20 },
      tooltip,
      viewportWidth: 1000,
      viewportHeight: 600,
    });
    const nearTop = calculateInternalTooltipPosition({
      target: { top: 4, right: 510, bottom: 24, left: 490, width: 20, height: 20 },
      tooltip,
      viewportWidth: 1000,
      viewportHeight: 600,
    });

    expect(left).toEqual({ left: 160, placement: "above", top: 45 });
    expect(right).toEqual({ left: 840, placement: "above", top: 45 });
    expect(nearTop).toEqual({ left: 500, placement: "below", top: 31 });
  });

  it("clamps vertically when neither side has enough room", () => {
    expect(calculateInternalTooltipPosition({
      target: { top: 40, right: 510, bottom: 60, left: 490, width: 20, height: 20 },
      tooltip: { width: 288, height: 68 },
      viewportWidth: 1000,
      viewportHeight: 100,
    })).toEqual({ left: 500, placement: "above", top: 16 });
  });
});
