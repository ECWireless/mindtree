import type { FlatNode } from "@/lib/nodes/tree";

export const syntheticDashboardEmail = "thinker@example.test";

export const syntheticDashboardNodes = [
  {
    id: "systems",
    parentId: null,
    position: 0,
    title: "Living systems",
    archivedAt: null,
  },
  {
    id: "feedback",
    parentId: "systems",
    position: 0,
    title: "Feedback loops",
    archivedAt: null,
  },
  {
    id: "questions",
    parentId: "systems",
    position: 1,
    title: "Open questions",
    archivedAt: null,
  },
] satisfies readonly FlatNode[];
