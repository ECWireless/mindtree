import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/app/actions/nodes", () => ({
  createNode: vi.fn(),
  moveNode: vi.fn(),
  renameNode: vi.fn(),
}));

import { DashboardShell } from "@/components/dashboard-shell";
import {
  syntheticDashboardEmail,
  syntheticDashboardNodes,
} from "../fixtures/dashboard";

describe("DashboardShell", () => {
  it("renders the synthetic tree and selected thought without a routed auth bypass", () => {
    const markup = renderToStaticMarkup(
      <DashboardShell
        email={syntheticDashboardEmail}
        nodes={syntheticDashboardNodes}
        selectedNodeId="feedback"
      />,
    );

    expect(markup).toContain(syntheticDashboardEmail);
    expect(markup).toContain("Living systems");
    expect(markup).toContain("Feedback loops");
    expect(markup).toContain("Open questions");
    expect(markup).toContain("No synthesis yet");
    expect(markup).toContain("Develop this thought");
    expect(markup).toContain('aria-label="Thought tree"');
    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain('aria-label="Breadcrumb"');
    expect(markup).toContain("Add child to Feedback loops");
    expect(markup).toContain("Search thought titles");
    expect(markup).toContain("3 nodes");
    expect(markup).toContain('data-tooltip="Show archived"');
    expect(markup).toContain('data-tooltip="New root thought"');
    expect(markup).toContain('<path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"></path>');
    expect(markup).toContain('<path d="m16.5 16.5 4 4"></path>');
    expect(markup).toContain("Move to…");
    expect(markup).toContain('class="node-drag-handle"');
    expect(markup).toContain('data-tooltip="Add child to Feedback loops"');
    expect(markup).toContain('<path d="m5 9 7 7 7-7"></path>');
    expect(markup).toContain('<path d="M12 5v14M5 12h14"></path>');
    expect(markup).toContain(
      'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"',
    );

    const collapsedMarkup = renderToStaticMarkup(
      <DashboardShell email={syntheticDashboardEmail} nodes={syntheticDashboardNodes} />,
    );
    expect(collapsedMarkup).toContain('<path d="m9 5 7 7-7 7"></path>');
  });

  it("renders a useful empty state for a synthetic account with no nodes", () => {
    const markup = renderToStaticMarkup(
      <DashboardShell email={syntheticDashboardEmail} nodes={[]} />,
    );

    expect(markup).toContain("Start with one thought.");
    expect(markup).toContain("Create the first thought");
  });
});
