import type { FlatNode } from "@/lib/nodes/tree";

export const syntheticDashboardEmail = "thinker@example.test";

export const syntheticDashboardNodes = [
  {
    id: "systems",
    parentId: null,
    position: 0,
    title: "Living systems",
    archivedAt: null,
    publishedSynthesisVersionId: null,
    synthesisStaleAt: null,
  },
  {
    id: "feedback",
    parentId: "systems",
    position: 0,
    title: "Feedback loops",
    archivedAt: null,
    publishedSynthesisVersionId: null,
    synthesisStaleAt: null,
  },
  {
    id: "questions",
    parentId: "systems",
    position: 1,
    title: "Open questions",
    archivedAt: null,
    publishedSynthesisVersionId: null,
    synthesisStaleAt: null,
  },
] satisfies readonly FlatNode[];
