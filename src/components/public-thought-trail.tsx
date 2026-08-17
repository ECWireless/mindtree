import { BrandMark } from "@/components/brand-mark";
import { BranchMapIcon } from "@/components/branch-map-icon";
import {
  BranchOutlineDocumentContent,
  ExternalReferences,
  PublicSynthesisDocumentContent,
} from "@/components/chat-message-content";
import { NodeConstellationIcon } from "@/components/node-constellation-icon";
import { PublicConstellationView } from "@/components/public-constellation-view";
import { assembleNodeTree, type TreeNode } from "@/lib/nodes/tree";
import type {
  PublicConstellationNode,
  PublicExternalCitation,
  PublicThoughtTrail,
  PublicThoughtTrailNode,
} from "@/lib/sharing/contracts";

function trailNodeHref(nodeId: string) {
  return `?node=${encodeURIComponent(nodeId)}`;
}

function constellationHref(nodeId: string) {
  return `?node=${encodeURIComponent(nodeId)}&view=constellation`;
}

export function toPublicConstellationNodes(
  nodes: readonly PublicThoughtTrailNode[],
): PublicConstellationNode[] {
  return nodes.map(({ id, parentId, position, title }) => ({
    id,
    parentId,
    position,
    title,
  }));
}

function PublicTrailBranch({
  nodes,
  selectedNodeId,
  nested = false,
  parentDepth = 0,
}: {
  nodes: readonly TreeNode[];
  selectedNodeId: string;
  nested?: boolean;
  parentDepth?: number;
}) {
  const capped = nested && parentDepth >= 12;
  const mobileCapped = nested && parentDepth >= 6;
  return (
    <ol className={nested
      ? [
          "public-trail-tree__children",
          capped ? "public-trail-tree__children--capped" : "",
          mobileCapped ? "public-trail-tree__children--mobile-capped" : "",
        ].filter(Boolean).join(" ")
      : "public-trail-tree__branch"}
    >
      {nodes.map((node) => (
        <li
          className={`public-trail-tree__item${node.children.length > 0 ? " public-trail-tree__item--branch" : ""}`}
          key={node.id}
        >
          <a
            className="public-trail-tree__link"
            href={trailNodeHref(node.id)}
            aria-current={node.id === selectedNodeId ? "page" : undefined}
          >
            <span className="sr-only">Level {node.depth + 1}. </span>
            <span className="public-trail-tree__node" aria-hidden="true" />
            <span className="public-trail-tree__title">{node.title}</span>
          </a>
          {node.children.length > 0 ? (
            <PublicTrailBranch
              nodes={node.children}
              selectedNodeId={selectedNodeId}
              nested
              parentDepth={node.depth}
            />
          ) : null}
        </li>
      ))}
    </ol>
  );
}

export function PublicThoughtTrailView({
  trail,
  view = "trail",
}: {
  trail: PublicThoughtTrail;
  view?: "trail" | "constellation";
}) {
  const publicById = new Map(trail.nodes.map((node) => [node.id, node]));
  const tree = assembleNodeTree(trail.nodes.map((node) => ({
    id: node.id,
    parentId: node.parentId,
    position: node.position,
    title: node.title,
    archivedAt: null,
    publishedSynthesisVersionId: null,
    synthesisStaleAt: null,
  })));
  const selectedTreeNode = tree.byId.get(trail.selectedNodeId);
  const selectedNode = publicById.get(trail.selectedNodeId);
  const root = tree.byId.get(trail.rootNodeId);
  if (!selectedTreeNode || !selectedNode || !root) {
    throw new Error("The public thought trail is inconsistent.");
  }
  if (view === "constellation") {
    return (
      <PublicConstellationView
        nodes={toPublicConstellationNodes(trail.nodes)}
        selectedNodeId={selectedNode.id}
      />
    );
  }
  const externalCitations = selectedNode.summary?.citations.filter(
    (citation): citation is PublicExternalCitation => citation.kind === "external",
  ) ?? [];

  return (
    <main
      className="public-trail"
      data-testid="public-thought-trail"
      aria-labelledby="public-trail-page-title"
    >
      <a
        className="skip-link"
        href="#public-trail-detail-title"
      >
        Skip to selected thought
      </a>
      <header className="public-trail__header">
        <div className="wordmark wordmark--compact" aria-label="MindTree">
          <BrandMark />
          <span>MindTree</span>
        </div>
        <div className="public-trail__header-actions">
          <nav className="public-trail__view-switch" aria-label="Shared view">
            <a
              href={trailNodeHref(selectedNode.id)}
              aria-current="page"
            >
              <BranchMapIcon />
              <span>Trail</span>
            </a>
            <a
              href={constellationHref(selectedNode.id)}
            >
              <NodeConstellationIcon />
              <span>Constellation</span>
            </a>
          </nav>
          <span className="public-trail__read-only">Shared · Read-only</span>
        </div>
      </header>
      <h1 className="sr-only" id="public-trail-page-title">
        {selectedNode.title} — shared thought trail
      </h1>

      <div className="public-trail__workspace">
        <nav className="public-trail-tree" aria-labelledby="public-trail-tree-title">
          <p className="pane-eyebrow">Thought trail</p>
          <h2 id="public-trail-tree-title">{root.title}</h2>
          <p className="public-trail-tree__count">
            {trail.nodes.length} {trail.nodes.length === 1 ? "thought" : "thoughts"}
          </p>
          <PublicTrailBranch nodes={tree.roots} selectedNodeId={selectedNode.id} />
        </nav>

        <article className="public-trail-detail" aria-labelledby="public-trail-detail-title">
          <nav className="breadcrumbs" aria-label="Breadcrumb">
            <ol>
              {selectedTreeNode.breadcrumb.map((item, index) => (
                <li key={item.id}>
                  {index < selectedTreeNode.breadcrumb.length - 1 ? (
                    <a href={trailNodeHref(item.id)}>{item.title}</a>
                  ) : (
                    <span aria-current="page">{item.title}</span>
                  )}
                </li>
              ))}
            </ol>
          </nav>
          <h2 id="public-trail-detail-title" tabIndex={-1}>{selectedNode.title}</h2>

          <section className="public-trail-summary" aria-labelledby="public-trail-summary-title">
            <h3 id="public-trail-summary-title">Summary</h3>
            {selectedNode.summary ? (
              <div className="synthesis-document__content">
                <PublicSynthesisDocumentContent
                  content={selectedNode.summary.content}
                  citations={selectedNode.summary.citations}
                />
              </div>
            ) : (
              <p className="public-trail__empty">No published Summary is available for this thought.</p>
            )}
          </section>

          <ExternalReferences citations={externalCitations} headingLevel={3} />

          <section className="branch-outline public-trail-outline" aria-labelledby="public-trail-outline-title">
            <div className="branch-outline__heading">
              <div className="branch-outline__identity">
                <span className="branch-outline__mark" aria-hidden="true">
                  <BranchMapIcon />
                </span>
                <h3 id="public-trail-outline-title">Branch Outline</h3>
              </div>
            </div>
            <div className="branch-outline__canvas">
              {selectedNode.branchOutline ? (
                <div className="branch-outline__content branch-outline__content--current synthesis-document__content">
                  <BranchOutlineDocumentContent content={selectedNode.branchOutline.content} />
                </div>
              ) : (
                <p className="public-trail__empty">No Branch Outline is available for this thought.</p>
              )}
            </div>
          </section>
        </article>
      </div>
    </main>
  );
}

export function PublicThoughtTrailUnavailable({ oversized = false }: { oversized?: boolean }) {
  return (
    <main className="public-trail-unavailable" aria-labelledby="public-trail-unavailable-title">
      <div className="wordmark" aria-label="MindTree">
        <BrandMark />
        <span>MindTree</span>
      </div>
      <p className="eyebrow">Shared thought trail</p>
      <h1 id="public-trail-unavailable-title">This thought trail is unavailable.</h1>
      <p>
        {oversized
          ? "It currently contains too much material to display safely."
          : "The link may be invalid, revoked, or no longer shared."}
      </p>
    </main>
  );
}
