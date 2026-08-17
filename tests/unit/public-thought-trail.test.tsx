import { Buffer } from "node:buffer";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  PublicThoughtTrailUnavailable,
  PublicThoughtTrailView,
  toPublicConstellationNodes,
} from "@/components/public-thought-trail";
import {
  MAX_PUBLIC_TRAIL_SERIALIZED_BYTES,
  type PublicThoughtTrail,
} from "@/lib/sharing/contracts";

describe("public thought trail presentation", () => {
  it("renders only read-only public material and scoped navigation", () => {
    const summary = "# Public Summary\n\nFollow child and private phrase.\n\nExternal fact.";
    const childStart = summary.indexOf("child");
    const privateStart = summary.indexOf("private phrase");
    const externalAt = summary.length;
    const trail: PublicThoughtTrail = {
      rootNodeId: "root",
      selectedNodeId: "root",
      nodes: [
        {
          id: "root",
          parentId: null,
          position: 0,
          title: "Shared root",
          summary: {
            content: summary,
            citations: [
              {
                kind: "internal",
                ordinal: 1,
                startUtf16: childStart,
                endUtf16: childStart + "child".length,
                targetNodeId: "child",
              },
              {
                kind: "internal",
                ordinal: 2,
                startUtf16: privateStart,
                endUtf16: privateStart + "private phrase".length,
                targetNodeId: null,
              },
              {
                kind: "external",
                ordinal: 3,
                startUtf16: externalAt,
                endUtf16: externalAt,
                title: "Synthetic public source",
                url: "https://example.test/public-source",
              },
            ],
          },
          branchOutline: {
            content: "- First branch\n- [Untrusted link](https://private.example.test)",
          },
        },
        {
          id: "child",
          parentId: "root",
          position: 0,
          title: "Shared child",
          summary: null,
          branchOutline: null,
        },
      ],
    };

    const markup = renderToStaticMarkup(<PublicThoughtTrailView trail={trail} />);

    expect(markup).toContain("Shared · Read-only");
    expect(markup).not.toContain("This shared view follows the trail’s current active branch.");
    expect(markup).toContain('href="#public-trail-detail-title"');
    expect(markup).toContain("Skip to selected thought");
    expect(markup).toContain('<h1 class="sr-only" id="public-trail-page-title">');
    expect(markup).toContain('<h2 id="public-trail-detail-title" tabindex="-1">Shared root</h2>');
    expect(markup).toContain('<h3 id="public-trail-summary-title">Summary</h3>');
    expect(markup).toContain('<h3 id="public-trail-outline-title">Branch Outline</h3>');
    expect(markup).toContain('<path d="M6 4v16M6 8h7M6 16h7"></path>');
    expect(markup).not.toContain("public-trail-outline__glyph");
    expect(markup).toContain("Shared root");
    expect(markup).toContain("Shared child");
    expect(markup).toContain('href="?node=child"');
    expect(markup).toContain('href="https://example.test/public-source"');
    expect(markup).toContain("Synthetic public source");
    expect(markup).toContain("private phrase");
    expect(markup).not.toContain("private phrase</a>");
    expect(markup).toContain("Untrusted link");
    expect(markup).not.toContain("https://private.example.test");
    expect(markup).not.toContain("Chat");
    expect(markup).not.toContain("Regenerate");
    expect(markup).not.toContain("Edit");
    expect(markup).not.toContain("owner");
    expect(markup).not.toContain("/share/");
  });

  it("keeps deeply nested current descendants navigable with bounded indentation", () => {
    const nodes: PublicThoughtTrail["nodes"] = [];
    for (let index = 0; index < 80; index += 1) {
      nodes.push({
        id: `node-${index}`,
        parentId: index === 0 ? null : `node-${index - 1}`,
        position: 0,
        title: `Depth ${index + 1}`,
        summary: null,
        branchOutline: null,
      });
    }
    const trail: PublicThoughtTrail = {
      rootNodeId: "node-0",
      selectedNodeId: "node-79",
      nodes,
    };

    const markup = renderToStaticMarkup(<PublicThoughtTrailView trail={trail} />);

    expect(markup).toContain("Depth 80");
    expect(markup).toContain("Level 80.");
    expect(markup).toContain("public-trail-tree__children--mobile-capped");
    expect(markup).toContain("public-trail-tree__children--capped");
    expect(markup).toContain('aria-current="page"');
  });

  it("renders the same scoped nodes as a public constellation without owner state", () => {
    const trail: PublicThoughtTrail = {
      rootNodeId: "root",
      selectedNodeId: "child",
      nodes: [
        {
          id: "root",
          parentId: null,
          position: 0,
          title: "Shared root",
          summary: null,
          branchOutline: null,
        },
        {
          id: "child",
          parentId: "root",
          position: 0,
          title: "Shared child",
          summary: null,
          branchOutline: null,
        },
      ],
    };

    const markup = renderToStaticMarkup(
      <PublicThoughtTrailView trail={trail} view="constellation" />,
    );

    expect(markup).toContain("Skip to constellation");
    expect(markup).toContain('data-testid="public-constellation"');
    expect(markup).toContain('href="?node=child&amp;view=constellation"');
    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain("Thought Constellation");
    expect(markup).toContain('<h2 id="constellation-heading">Thought Constellation</h2>');
    expect(markup).not.toContain("Read-only view");
    expect(markup).toContain("Shared root");
    expect(markup).toContain("Shared child");
    expect(markup).toContain('href="?node=child"');
    expect(markup).toContain("Read thought");
    expect(markup).not.toContain("Open in tree");
    expect(markup).not.toContain("Summary published");
    expect(markup).not.toContain("No published Summary");
    expect(markup).not.toContain("Show archived thoughts");
    expect(markup).not.toContain("Create your first root thought");
    expect(markup).not.toContain("status-pill");
    expect(markup).not.toContain("Chat");
  });

  it("keeps the public constellation client contract flat, bounded, and allowlisted", () => {
    const nodes: PublicThoughtTrail["nodes"] = Array.from({ length: 500 }, (_, index) => ({
      id: `node-${index}`,
      parentId: index === 0 ? null : `node-${index - 1}`,
      position: 0,
      title: `Thought ${index} 思考 🌲 ${"x".repeat(180)}`,
      summary: null,
      branchOutline: null,
    }));

    const graphNodes = toPublicConstellationNodes(nodes);
    const serialized = JSON.stringify(graphNodes);

    expect(Object.keys(graphNodes[0] ?? {}).sort()).toEqual([
      "id",
      "parentId",
      "position",
      "title",
    ]);
    const serializedBytes = Buffer.byteLength(serialized, "utf8");
    expect(serializedBytes).toBeGreaterThan(serialized.length);
    expect(serializedBytes).toBeLessThan(MAX_PUBLIC_TRAIL_SERIALIZED_BYTES);
    expect(serialized).not.toContain("archivedAt");
    expect(serialized).not.toContain("publishedSynthesisVersionId");
    expect(serialized).not.toContain("synthesisStaleAt");
    expect(serialized).not.toContain("breadcrumb");
    expect(serialized).not.toContain("children");
    expect(serialized).not.toContain("summary");
    expect(serialized).not.toContain("branchOutline");
  });

  it("uses the same generic unavailable surface for absent capabilities", () => {
    const markup = renderToStaticMarkup(<PublicThoughtTrailUnavailable />);

    expect(markup).toContain("This thought trail is unavailable.");
    expect(markup).toContain("invalid, revoked, or no longer shared");
    expect(markup).not.toContain("secret");
  });
});
