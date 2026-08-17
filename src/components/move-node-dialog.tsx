"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useRouter } from "next/navigation";

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
import { isDialogBackdropClick } from "@/lib/ui/dialog";

const moveDestinationLimit = 100;
const placementZones = ["before", "inside", "after"] as const;

function CloseIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  );
}

function ArrowUpIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="m6 10 6-6 6 6M12 4v16" />
    </svg>
  );
}

function ArrowLeftIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="m10 6-6 6 6 6M4 12h16" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="m9 5 7 7-7 7" />
    </svg>
  );
}

function MoveIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7.5h7l2 2h9v9H3z" />
      <path d="m10 14 2-2 2 2M12 12v5" />
    </svg>
  );
}

function placementDescription(zone: NodeDropZone, target: TreeNode) {
  if (zone === "before") {
    return `Place immediately before ${target.title}`;
  }
  if (zone === "inside") {
    return `Place as the last child of ${target.title}`;
  }
  return `Place immediately after ${target.title}`;
}

export function getMoveSearchPage(
  nodes: readonly TreeNode[],
  node: TreeNode,
  query: string,
  visibleLimit = moveDestinationLimit,
) {
  const results = query.trim() ? getMoveDestinations(nodes, node, query) : [];
  return { results, visibleResults: results.slice(0, visibleLimit) };
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
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const upOneLevelButtonRef = useRef<HTMLButtonElement>(null);
  const moveHereButtonRef = useRef<HTMLButtonElement>(null);
  const firstPlacementButtonRef = useRef<HTMLButtonElement>(null);
  const [query, setQuery] = useState("");
  const [visibleLimit, setVisibleLimit] = useState(moveDestinationLimit);
  const [browseParentId, setBrowseParentId] = useState<string | null>(node.parentId);
  const [browseFocusTarget, setBrowseFocusTarget] = useState<"move" | "up" | null>(null);
  const [placementTargetId, setPlacementTargetId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const destinations = useMemo(
    () => getMoveDestinations(nodes, node, ""),
    [node, nodes],
  );
  const destinationById = useMemo(
    () => new Map(destinations.map((destination) => [destination.id, destination])),
    [destinations],
  );
  const resolveDestination = useMemo(
    () => createNodeDropResolver(nodes, node),
    [node, nodes],
  );
  const eligibleChildCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const destination of destinations) {
      if (destination.parentId !== null) {
        counts.set(destination.parentId, (counts.get(destination.parentId) ?? 0) + 1);
      }
    }
    return counts;
  }, [destinations]);
  const searchPage = useMemo(
    () => getMoveSearchPage(nodes, node, query, visibleLimit),
    [node, nodes, query, visibleLimit],
  );
  const { results: searchResults, visibleResults: visibleSearchResults } = searchPage;
  const browseParent = browseParentId === null ? null : destinationById.get(browseParentId) ?? null;
  const browseNodes = destinations.filter((destination) => destination.parentId === browseParentId);
  const placementTarget = placementTargetId ? destinationById.get(placementTargetId) ?? null : null;
  const placementOptions = placementTarget
    ? placementZones.flatMap((zone) => {
        const destination = resolveDestination(placementTarget, zone);
        return destination ? [{ destination, zone }] : [];
      })
    : [];
  const moveHereDestination = browseParentId === null
    ? getRootEndDestination(nodes, node)
    : browseParent
      ? resolveDestination(browseParent, "inside")
      : null;
  useEffect(() => {
    const dialog = dialogRef.current;
    const returnFocusTarget = returnFocusRef.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
    }
    const focusFrame = requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => {
      cancelAnimationFrame(focusFrame);
      requestAnimationFrame(() => returnFocusTarget?.focus());
    };
  }, [returnFocusRef]);

  useEffect(() => {
    if (!browseFocusTarget) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      const focusTarget = browseFocusTarget === "move"
        ? moveHereButtonRef.current
        : upOneLevelButtonRef.current;
      focusTarget?.focus();
      setBrowseFocusTarget(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [browseFocusTarget]);

  useEffect(() => {
    if (!placementTarget) {
      return;
    }
    const frame = requestAnimationFrame(() => firstPlacementButtonRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [placementTarget]);

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
      setError(
        "MindTree couldn’t confirm the move. The tree was refreshed; check the thought’s current location before trying again.",
      );
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  function close() {
    if (!pending) {
      dialogRef.current?.close();
    }
  }

  function choosePlacement(destination: TreeNode) {
    setPlacementTargetId(destination.id);
    setError(null);
  }

  function returnToDestinations() {
    setPlacementTargetId(null);
    requestAnimationFrame(() => {
      if (query.trim()) {
        searchInputRef.current?.focus();
      } else {
        moveHereButtonRef.current?.focus();
      }
    });
  }

  function browse(parentId: string | null) {
    const destination = parentId === null ? null : destinationById.get(parentId) ?? null;
    const canMoveToLevel = parentId === null || (
      destination !== null && resolveDestination(destination, "inside") !== null
    );
    setBrowseParentId(parentId);
    setBrowseFocusTarget(canMoveToLevel ? "move" : "up");
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
      onClick={(event) => {
        if (isDialogBackdropClick(event)) close();
      }}
      onClose={onClose}
    >
      <div className="dialog-heading">
        <div>
          <p className="pane-eyebrow">Move thought</p>
          <h2 id="move-node-title">Choose a new location for {node.title}</h2>
        </div>
        <button
          className="dialog-close icon-button"
          type="button"
          aria-label="Close move dialog"
          data-tooltip="Close"
          disabled={pending}
          onClick={close}
        >
          <CloseIcon />
        </button>
      </div>

      <label className="dialog-search">
        <span className="field-label">Search destinations</span>
        <input
          ref={searchInputRef}
          type="search"
          value={query}
          disabled={pending}
          placeholder="Search thought titles"
          onChange={(event) => {
            setQuery(event.target.value);
            setVisibleLimit(moveDestinationLimit);
            setPlacementTargetId(null);
          }}
        />
      </label>

      {placementTarget ? (
        <div className="move-placement">
          <div className="move-browser__toolbar">
            <button
              className="icon-button"
              type="button"
              aria-label="Back to destinations"
              data-tooltip="Back to destinations"
              disabled={pending}
              onClick={returnToDestinations}
            >
              <ArrowLeftIcon />
            </button>
            <div aria-live="polite" aria-atomic="true">
              <small>Place relative to</small>
              <strong>{formatBreadcrumb(placementTarget)}</strong>
            </div>
          </div>
          <div className="move-placement__choices" aria-label="Placement options">
            {placementOptions.map(({ destination, zone }, index) => (
              <button
                ref={index === 0 ? firstPlacementButtonRef : undefined}
                className="dialog-result"
                type="button"
                key={zone}
                disabled={pending}
                aria-label={`Move ${zone} ${formatBreadcrumb(placementTarget)}`}
                onClick={() => void move(destination)}
              >
                <strong>{zone[0].toUpperCase() + zone.slice(1)}</strong>
                <span>{placementDescription(zone, placementTarget)}</span>
              </button>
            ))}
          </div>
        </div>
      ) : query.trim() ? (
        <div className="dialog-results" aria-label="Search move destinations">
          <button
            className="dialog-result"
            type="button"
            disabled={pending}
            onClick={() => void move(getRootEndDestination(nodes, node))}
          >
            <strong>Root</strong>
            <span>Place after the existing root thoughts</span>
          </button>
          {visibleSearchResults.map((destination) => (
            <button
              className="dialog-result"
              type="button"
              key={destination.id}
              disabled={pending}
              onClick={() => choosePlacement(destination)}
            >
              <strong>{destination.title}</strong>
              <span>
                {formatBreadcrumb(destination)}
                {destination.archivedAt ? " · Archived" : ""}
              </span>
            </button>
          ))}
          {searchResults.length > visibleLimit ? (
            <button
              className="dialog-result dialog-load-more"
              type="button"
              disabled={pending}
              onClick={() => setVisibleLimit((current) => current + moveDestinationLimit)}
            >
              <strong>Load more destinations</strong>
              <span>
                Show {Math.min(moveDestinationLimit, searchResults.length - visibleLimit)} more
              </span>
            </button>
          ) : null}
          {searchResults.length === 0 ? (
            <p className="dialog-empty">No matching thought destinations.</p>
          ) : null}
        </div>
      ) : (
        <div className="move-browser">
          <div className="move-browser__toolbar">
            <button
              ref={upOneLevelButtonRef}
              className="icon-button"
              type="button"
              aria-label="Up one level"
              data-tooltip="Up one level"
              disabled={browseParentId === null || pending}
              onClick={() => browse(browseParent?.parentId ?? null)}
            >
              <ArrowUpIcon />
            </button>
            <div aria-live="polite" aria-atomic="true">
              <small>Browsing</small>
              <strong>{browseParent ? formatBreadcrumb(browseParent) : "Root"}</strong>
            </div>
            <button
              ref={moveHereButtonRef}
              className="move-here-button"
              type="button"
              disabled={pending || moveHereDestination === null}
              onClick={() => moveHereDestination && void move(moveHereDestination)}
            >
              <MoveIcon />
              <span>Move here</span>
            </button>
          </div>
          <div className="move-browser__nodes" aria-label="Thoughts at this level">
            {browseNodes.map((destination) => (
              <div className="move-browser__node" key={destination.id}>
                <button
                  className="move-browser__destination"
                  type="button"
                  disabled={pending}
                  aria-label={`Browse ${formatBreadcrumb(destination)}`}
                  onClick={() => browse(destination.id)}
                >
                  <span>
                    <strong>{destination.title}</strong>
                    <small>
                      {(eligibleChildCounts.get(destination.id) ?? 0) === 1
                        ? "1 child"
                        : `${eligibleChildCounts.get(destination.id) ?? 0} children`}
                      {destination.archivedAt ? " · Archived" : ""}
                    </small>
                  </span>
                  <ChevronRightIcon />
                </button>
                <button
                  className="move-browser__place icon-button"
                  type="button"
                  disabled={pending}
                  aria-label={`Choose placement relative to ${formatBreadcrumb(destination)}`}
                  data-tooltip="Choose placement"
                  onClick={() => choosePlacement(destination)}
                >
                  <MoveIcon />
                </button>
              </div>
            ))}
            {browseNodes.length === 0 ? (
              <p className="dialog-empty">No other thoughts at this level.</p>
            ) : null}
          </div>
        </div>
      )}

      <p className="dialog-status" role="status" aria-live="polite">
        {pending ? "Moving thought…" : ""}
      </p>
      {error ? <p role="alert" className="dialog-error">{error}</p> : null}
    </dialog>
  );
}
