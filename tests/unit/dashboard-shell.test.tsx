import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/app/actions/nodes", () => ({
  archiveNode: vi.fn(),
  createNode: vi.fn(),
  deleteNode: vi.fn(),
  moveNode: vi.fn(),
  renameNode: vi.fn(),
  unarchiveNode: vi.fn(),
}));

vi.mock("@/app/actions/chat", () => ({
  loadChatMessages: vi.fn(),
  loadChatTurn: vi.fn(),
}));

vi.mock("@/app/actions/synthesis", () => ({
  approveSynthesisProposal: vi.fn(),
  rejectSynthesisProposal: vi.fn(),
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
    expect(markup).toContain(">Active</small>");
    expect(markup).toContain("Open Chat when this thought is ready to synthesize");
    expect(markup).toContain("Chat about Feedback loops");
    expect(markup).toContain(">Chat</button>");
    expect(markup).toContain("Assistant replies require OpenAI configuration.");
    expect(markup).toContain('class="chat-composer__availability"');
    expect(markup).toContain('textarea id="chat-draft-feedback"');
    expect(markup).toContain("disabled");
    expect(markup).toContain('aria-label="Thought tree"');
    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain('aria-label="Breadcrumb"');
    expect(markup).toContain("Add child to Feedback loops");
    expect(markup).toContain("Search thought titles");
    expect(markup).toContain("3 nodes");
    expect(markup).toContain('data-tooltip="Show archived"');
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).toContain('aria-label="Node constellation"');
    expect(markup).toContain('data-tooltip="Open node constellation"');
    expect(markup).toContain('<path d="m7.3 10.9 7.6-3.8M7.3 13.1l7.6 3.8"></path>');
    expect(markup).toContain('data-tooltip="New root thought"');
    expect(markup).toContain('<path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"></path>');
    expect(markup).toContain('<path d="m16.5 16.5 4 4"></path>');
    expect(markup).toContain('class="node-actions" aria-label="Thought actions"');
    expect(markup).toContain('data-tooltip="Archive thought"');
    expect(markup).toContain('data-tooltip="Move To…"');
    expect(markup).toContain('data-tooltip="Delete thought"');
    expect(markup).toContain('<rect x="3" y="4" width="18" height="4" rx="1"></rect>');
    expect(markup).toContain('<path d="M10 12h4"></path>');
    expect(markup).toContain('<path d="M3 7.5h7l2 2h9v9H3z"></path>');
    expect(markup).toContain('<path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13"></path>');
    const actionsStart = markup.indexOf('class="node-actions" aria-label="Thought actions"');
    const actionsMarkup = markup.slice(actionsStart, markup.indexOf("</div>", actionsStart));
    expect(actionsMarkup.indexOf('aria-label="Add child"')).toBeLessThan(
      actionsMarkup.indexOf('aria-label="Archive"'),
    );
    expect(actionsMarkup.indexOf('aria-label="Archive"')).toBeLessThan(
      actionsMarkup.indexOf('aria-label="Move To…"'),
    );
    expect(actionsMarkup.indexOf('aria-label="Move To…"')).toBeLessThan(
      actionsMarkup.indexOf('aria-label="Delete"'),
    );
    expect(markup).toContain('class="node-drag-handle"');
    expect(markup).toContain('data-tooltip="Add child to Feedback loops"');
    expect(markup).toContain('aria-label="Collapse Living systems" aria-expanded="true"');
    expect(markup).toContain('<path d="m9 5 7 7-7 7"></path>');
    expect(markup).toContain('<path d="M12 5v14M5 12h14"></path>');
    expect(markup).toContain(
      'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"',
    );

    const collapsedMarkup = renderToStaticMarkup(
      <DashboardShell email={syntheticDashboardEmail} nodes={syntheticDashboardNodes} />,
    );
    expect(collapsedMarkup).toContain(
      'aria-label="Expand Living systems" aria-expanded="false"',
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
    expect(selectedMarkup).toContain('data-tooltip="Delete thought"');
    expect(selectedMarkup).toContain('<path d="M4 7v5h5"></path>');
    expect(selectedMarkup).toContain('role="status" aria-live="polite"');
    expect(selectedMarkup).not.toContain("Add child to Feedback loops");
  });

  it("renders published and pending synthesis with explicit diff and decision cues", () => {
    const versionBase = {
      nodeId: "feedback",
      model: "gpt-5.6-sol",
      reasoningMode: "pro",
      reasoningEffort: "high",
      inputFingerprint: "a".repeat(64),
      generatingMessageId: "message-id",
      createdAt: "2026-08-05T12:00:00.000Z",
      updatedAt: "2026-08-05T12:00:00.000Z",
    };
    const markup = renderToStaticMarkup(
      <DashboardShell
        email={syntheticDashboardEmail}
        nodes={syntheticDashboardNodes}
        selectedNodeId="feedback"
        chatGenerationEnabled
      initialSynthesisWorkspace={{
        staleAt: "2026-08-05T13:00:00.000Z",
        published: {
            ...versionBase,
            id: "published-id",
            baseVersionId: null,
            status: "approved",
            content: "# Summary\n\nOld point",
            citations: [{
              kind: "external",
              ordinal: 1,
              startUtf16: "# Summary\n\nOld point".length,
              endUtf16: "# Summary\n\nOld point".length,
              title: "Synthetic source",
              url: "https://example.test/source",
            }],
            decidedAt: "2026-08-05T12:00:00.000Z",
          },
          pending: {
            ...versionBase,
            id: "pending-id",
            baseVersionId: "published-id",
            status: "pending",
            content: "# Summary\n\nNew point",
            citations: [],
            decidedAt: null,
          },
          history: [{
            id: "published-id",
            generatingMessageId: "message-id",
            status: "approved",
            content: "# Summary\n\nOld point",
            citations: [],
            baseContent: null,
            decidedAt: "2026-08-05T12:00:00.000Z",
          }],
        }}
      />,
    );

    expect(markup).toContain(">Summary</h2>");
    expect(markup).toContain("Pending Summary proposal · Not published");
    expect(markup).toContain("Old point");
    expect(markup).toContain("New point");
    expect(markup).toContain("Added:");
    expect(markup).toContain("Removed:");
    expect(markup).toContain("Approve and publish Summary");
    expect(markup).toContain("Reject Summary proposal");
    expect(markup).toContain('aria-label="Summary proposal decision"');
    expect(markup).toContain("describe the changes in your next message");
    expect(markup).toContain("Recent Summary decisions (1)");
    expect(markup).toContain("Update available");
    expect(markup).toContain("Open Chat to request a refreshed Summary");
    expect(markup).not.toContain("<h1>Summary</h1>");
    expect(markup).toContain("<h4>Summary</h4>");
    expect(markup).toContain("Synthetic source");
    expect(markup.indexOf('aria-label="External references"')).toBeLessThan(
      markup.indexOf('class="branch-outline"'),
    );
  });

  it("renders a useful empty state for a synthetic account with no nodes", () => {
    const markup = renderToStaticMarkup(
      <DashboardShell email={syntheticDashboardEmail} nodes={[]} />,
    );

    expect(markup).toContain("Start with one thought.");
    expect(markup).toContain("Create the first thought");
  });
});
