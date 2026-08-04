"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";

import { moveNode } from "@/app/actions/nodes";
import {
  createNodeDropResolver,
  formatBreadcrumb,
  getMoveDestinations,
  getRootEndDestination,
  type NodeDropDestination,
  type NodeDropZone,
} from "@/lib/nodes/presentation";
import type { TreeNode } from "@/lib/nodes/tree";

const moveDestinationLimit = 100;

function CloseIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  );
}

export function MoveNodeDialog({
  node,
  nodes,
  onClose,
  onMoved,
  returnFocusRef,
}: {
  node: TreeNode;
  nodes: readonly TreeNode[];
  onClose: () => void;
  onMoved: (parentId: string | null) => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [visibleLimit, setVisibleLimit] = useState(moveDestinationLimit);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const destinations = useMemo(
    () => getMoveDestinations(nodes, node, query),
    [node, nodes, query],
  );
  const visibleDestinations = destinations.slice(0, visibleLimit);
  const resolveDestination = useMemo(
    () => createNodeDropResolver(nodes, node),
    [node, nodes],
  );

  useEffect(() => {
    const dialog = dialogRef.current;
    const returnFocusTarget = returnFocusRef.current;
    dialog?.showModal();
    const frame = requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => {
      cancelAnimationFrame(frame);
      requestAnimationFrame(() => returnFocusTarget?.focus());
    };
  }, [returnFocusRef]);

  async function move(destination: Pick<NodeDropDestination, "parentId" | "position">) {
    if (pending) {
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await moveNode({
        id: node.id,
        parentId: destination.parentId,
        position: destination.position,
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      onMoved(destination.parentId);
    } catch {
      setError("MindTree couldn’t move that thought. Please try again.");
    } finally {
      setPending(false);
    }
  }

  function close() {
    if (!pending) {
      dialogRef.current?.close();
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="node-dialog"
      aria-labelledby="move-node-title"
      aria-busy={pending}
      onCancel={(event) => {
        if (pending) {
          event.preventDefault();
        }
      }}
      onClose={onClose}
    >
      <div className="dialog-heading">
        <div>
          <p className="pane-eyebrow">Move thought</p>
          <h2 id="move-node-title">Choose a destination for {node.title}</h2>
        </div>
        <button
          className="icon-button dialog-close"
          type="button"
          aria-label="Close move dialog"
          disabled={pending}
          onClick={close}
        >
          <CloseIcon />
        </button>
      </div>

      <label className="dialog-search">
        <span>Search destinations</span>
        <input
          ref={searchInputRef}
          type="search"
          value={query}
          disabled={pending}
          placeholder="Search thought titles"
          onChange={(event) => {
            setQuery(event.target.value);
            setVisibleLimit(moveDestinationLimit);
          }}
        />
      </label>

      <button
        className="move-root-button"
        type="button"
        disabled={pending}
        onClick={() => void move(getRootEndDestination(nodes, node))}
      >
        <strong>Move to root level</strong>
        <span>Place after the last root thought</span>
      </button>

      <div className="move-results" aria-label="Move destinations">
        {destinations.length > visibleLimit ? (
          <p className="move-results-summary">
            Showing the first {visibleLimit} of {destinations.length} destinations. Search
            to narrow the list.
          </p>
        ) : null}
        {visibleDestinations.map((destinationNode) => {
          const options = (["before", "inside", "after"] as const)
            .map((zone) => ({
              zone,
              destination: resolveDestination(destinationNode, zone),
            }))
            .filter(
              (option): option is { zone: NodeDropZone; destination: NodeDropDestination } =>
                option.destination !== null,
            );

          return (
            <div className="move-result" key={destinationNode.id}>
              <div>
                <strong>{destinationNode.title}</strong>
                <span>
                  {formatBreadcrumb(destinationNode)}
                  {destinationNode.archivedAt ? " · Archived" : ""}
                </span>
              </div>
              <div className="move-result__actions">
                {options.map(({ zone, destination }) => (
                  <button
                    className="button button--quiet button--small"
                    type="button"
                    key={zone}
                    disabled={pending}
                    aria-label={`Move ${zone} ${formatBreadcrumb(destinationNode)}`}
                    onClick={() => void move(destination)}
                  >
                    {zone[0].toUpperCase() + zone.slice(1)}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
        {destinations.length > visibleLimit ? (
          <button
            className="button button--quiet move-load-more"
            type="button"
            disabled={pending}
            onClick={() => setVisibleLimit((current) => current + moveDestinationLimit)}
          >
            Load {Math.min(moveDestinationLimit, destinations.length - visibleLimit)} more destinations
          </button>
        ) : null}
        {destinations.length === 0 ? <p>No available destinations.</p> : null}
      </div>

      <div className="dialog-feedback">
        <p className="dialog-status" role="status" aria-live="polite">
          {pending ? "Moving thought…" : ""}
        </p>
        {error ? <p className="dialog-error" role="alert">{error}</p> : null}
      </div>
    </dialog>
  );
}
