"use client";

import { useState } from "react";

import { BrandMark } from "@/components/brand-mark";
import { BranchMapIcon } from "@/components/branch-map-icon";
import { NodeConstellation } from "@/components/node-constellation";
import { NodeConstellationIcon } from "@/components/node-constellation-icon";
import type { PublicConstellationNode } from "@/lib/sharing/contracts";

function trailNodeHref(nodeId: string) {
  return `?node=${encodeURIComponent(nodeId)}`;
}

function constellationHref(nodeId: string) {
  return `?node=${encodeURIComponent(nodeId)}&view=constellation`;
}

export function PublicConstellationView({
  nodes,
  selectedNodeId,
}: {
  nodes: readonly PublicConstellationNode[];
  selectedNodeId: string;
}) {
  const [activeNodeId, setActiveNodeId] = useState(selectedNodeId);
  const activeNodeTitle =
    nodes.find(({ id }) => id === activeNodeId)?.title ?? "Shared thought";

  function selectNode(nodeId: string) {
    setActiveNodeId(nodeId);
    window.history.replaceState(
      window.history.state,
      "",
      constellationHref(nodeId),
    );
  }

  return (
    <main
      className="public-trail"
      data-testid="public-thought-trail"
      aria-labelledby="public-trail-page-title"
    >
      <a className="skip-link" href="#public-constellation">
        Skip to constellation
      </a>
      <header className="public-trail__header">
        <div className="wordmark wordmark--compact" aria-label="MindTree">
          <BrandMark />
          <span>MindTree</span>
        </div>
        <div className="public-trail__header-actions">
          <nav className="public-trail__view-switch" aria-label="Shared view">
            <a href={trailNodeHref(activeNodeId)}>
              <BranchMapIcon />
              <span>Trail</span>
            </a>
            <a href={constellationHref(activeNodeId)} aria-current="page">
              <NodeConstellationIcon />
              <span>Constellation</span>
            </a>
          </nav>
          <span className="public-trail__read-only">Shared · Read-only</span>
        </div>
      </header>
      <h1 className="sr-only" id="public-trail-page-title">
        {activeNodeTitle} — shared thought trail
      </h1>
      <div
        className="public-trail__constellation"
        data-testid="public-constellation"
        id="public-constellation"
        tabIndex={-1}
      >
        <NodeConstellation
          variant="public"
          nodes={nodes}
          selectedNodeId={activeNodeId}
          onSelectNode={selectNode}
        />
      </div>
    </main>
  );
}
