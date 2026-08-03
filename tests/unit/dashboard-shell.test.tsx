import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

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
    expect(markup).toContain("Synthesis needs review");
    expect(markup).toContain("Develop this thought");
    expect(markup).toContain('aria-label="Thought tree"');
    expect(markup).toContain('aria-current="page"');
  });

  it("renders a useful empty state for a synthetic account with no nodes", () => {
    const markup = renderToStaticMarkup(
      <DashboardShell email={syntheticDashboardEmail} nodes={[]} />,
    );

    expect(markup).toContain("Start with one thought.");
    expect(markup).not.toContain("Clarity lives here.");
  });
});
