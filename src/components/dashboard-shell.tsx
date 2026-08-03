import { BrandMark } from "./brand-mark";
import { SignOutButton } from "./auth-buttons";
import type { CSSProperties } from "react";
import Link from "next/link";

export type DashboardFixtureNode = {
  id: string;
  title: string;
  depth: number;
  synthesisState: "approved" | "missing" | "stale";
};

type DashboardShellProps = {
  email: string;
  nodes: readonly DashboardFixtureNode[];
  selectedNodeId?: string;
};

const synthesisLabels: Record<DashboardFixtureNode["synthesisState"], string> = {
  approved: "Synthesis approved",
  missing: "No synthesis yet",
  stale: "Synthesis needs review",
};

export function DashboardShell({ email, nodes, selectedNodeId }: DashboardShellProps) {
  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? nodes[0];

  return (
    <main className="dashboard" data-testid="dashboard-shell">
      <header className="dashboard-header">
        <Link className="wordmark wordmark--compact" href="/" aria-label="MindTree home">
          <BrandMark />
          <span>MindTree</span>
        </Link>
        <div className="dashboard-account">
          <span>{email}</span>
          <SignOutButton />
        </div>
      </header>

      <div className="dashboard-toolbar" aria-label="MindTree tools">
        <label className="tree-search">
          <span className="sr-only">Search nodes</span>
          <input type="search" placeholder="Search thoughts" disabled />
        </label>
        <div className="toolbar-actions">
          <button className="button button--quiet" type="button" disabled>
            Show archived
          </button>
          <button className="button button--primary" type="button" disabled>
            New root
          </button>
        </div>
      </div>

      <div className="dashboard-main">
        <nav className="tree-pane" aria-label="Thought tree">
          <p className="pane-eyebrow">Thoughts</p>
          <ul className="node-list">
            {nodes.map((node) => {
              const selected = node.id === selectedNode?.id;
              return (
                <li key={node.id} style={{ "--node-depth": node.depth } as CSSProperties}>
                  <button
                    className={`node-row${selected ? " node-row--selected" : ""}`}
                    type="button"
                    aria-current={selected ? "page" : undefined}
                    disabled
                  >
                    <span>{node.title}</span>
                    <small>{synthesisLabels[node.synthesisState]}</small>
                  </button>
                </li>
              );
            })}
          </ul>
          {nodes.length === 0 ? <p className="tree-empty">No thoughts yet.</p> : null}
        </nav>

        <section className="detail-pane" aria-labelledby="fixture-node-title">
          {selectedNode ? (
            <>
              <p className="pane-eyebrow">Selected thought</p>
              <h1 id="fixture-node-title">{selectedNode.title}</h1>
              <section className="synthesis-placeholder" aria-labelledby="fixture-synthesis-title">
                <p className="pane-eyebrow">Synthesis</p>
                <h2 id="fixture-synthesis-title">Clarity lives here.</h2>
                <p>
                  Approved synthesis will stay distinct from the conversation that shaped it.
                </p>
              </section>
              <section className="chat-placeholder" aria-labelledby="fixture-chat-title">
                <p className="pane-eyebrow">Conversation</p>
                <h2 id="fixture-chat-title">Develop this thought</h2>
                <p>Chat and proposal controls arrive in their dedicated phases.</p>
              </section>
            </>
          ) : (
            <div className="empty-state">
              <p className="pane-eyebrow">MindTree</p>
              <h1 id="fixture-node-title">Start with one thought.</h1>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
