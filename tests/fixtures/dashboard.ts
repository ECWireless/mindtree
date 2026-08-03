import type { DashboardFixtureNode } from "@/components/dashboard-shell";

export const syntheticDashboardEmail = "thinker@example.test";

export const syntheticDashboardNodes = [
  {
    id: "systems",
    title: "Living systems",
    depth: 0,
    synthesisState: "approved",
  },
  {
    id: "feedback",
    title: "Feedback loops",
    depth: 1,
    synthesisState: "stale",
  },
  {
    id: "questions",
    title: "Open questions",
    depth: 1,
    synthesisState: "missing",
  },
] satisfies readonly DashboardFixtureNode[];
