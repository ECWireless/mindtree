import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/app/actions/nodes", () => ({
  archiveNode: vi.fn(),
  createNode: vi.fn(),
  moveNode: vi.fn(),
  renameNode: vi.fn(),
  unarchiveNode: vi.fn(),
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
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).toContain('data-tooltip="New root thought"');
    expect(markup).toContain('<path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"></path>');
    expect(markup).toContain('<path d="m16.5 16.5 4 4"></path>');
    expect(markup).toContain('class="node-actions" aria-label="Thought actions"');
    expect(markup).toContain('data-tooltip="Archive thought"');
    expect(markup).toContain('data-tooltip="Move To…"');
    expect(markup).toContain('<rect x="3" y="4" width="18" height="4" rx="1"></rect>');
    expect(markup).toContain('<path d="M10 12h4"></path>');
    expect(markup).toContain('<path d="M3 7.5h7l2 2h9v9H3z"></path>');
    const actionsStart = markup.indexOf('class="node-actions" aria-label="Thought actions"');
    const actionsMarkup = markup.slice(actionsStart, markup.indexOf("</div>", actionsStart));
    expect(actionsMarkup.indexOf('aria-label="Add child"')).toBeLessThan(
      actionsMarkup.indexOf('aria-label="Archive"'),
    );
    expect(actionsMarkup.indexOf('aria-label="Archive"')).toBeLessThan(
      actionsMarkup.indexOf('aria-label="Move To…"'),
    );
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

  it("hides archived branches by default and reveals a directly selected archive", () => {
    const archivedNodes = syntheticDashboardNodes.map((node) =>
      node.id === "systems" || node.parentId === "systems"
        ? { ...node, archivedAt: "2026-08-03T12:00:00.000Z" }
        : node,
    );

    const hiddenMarkup = renderToStaticMarkup(
      <DashboardShell email={syntheticDashboardEmail} nodes={archivedNodes} />,
    );
    expect(hiddenMarkup).not.toContain("Living systems");
    expect(hiddenMarkup).toContain("No active thoughts.");
    expect(hiddenMarkup).toContain("Show archived thoughts");

    const selectedMarkup = renderToStaticMarkup(
      <DashboardShell
        email={syntheticDashboardEmail}
        nodes={archivedNodes}
        selectedNodeId="feedback"
      />,
    );
    expect(selectedMarkup).toContain("Living systems");
    expect(selectedMarkup).toContain('aria-pressed="true"');
    expect(selectedMarkup).toContain('data-tooltip="Hide archived"');
    expect(selectedMarkup).toContain("Unarchive");
    expect(selectedMarkup).toContain('data-tooltip="Unarchive thought"');
    expect(selectedMarkup).toContain('<path d="M4 7v5h5"></path>');
    expect(selectedMarkup).toContain('role="status" aria-live="polite"');
    expect(selectedMarkup).not.toContain("Add child to Feedback loops");
  });

  it("renders a useful empty state for a synthetic account with no nodes", () => {
    const markup = renderToStaticMarkup(
      <DashboardShell email={syntheticDashboardEmail} nodes={[]} />,
    );

    expect(markup).toContain("Start with one thought.");
    expect(markup).toContain("Create the first thought");
  });
});
