"use client";

import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type SetStateAction,
} from "react";

import {
  archiveNode,
  createNode,
  moveNode,
  renameNode,
  unarchiveNode,
} from "@/app/actions/nodes";
import { DeleteNodeDialog } from "@/components/delete-node-dialog";
import { BranchOutlinePanel } from "@/components/branch-outline-panel";
import { ChatPanel } from "@/components/chat-panel";
import { MoveNodeDialog } from "@/components/move-node-dialog";
import { NodeConstellation } from "@/components/node-constellation";
import { NodeConstellationIcon } from "@/components/node-constellation-icon";
import { NodeTreeList } from "@/components/node-tree-list";
import { ShareThoughtTrail } from "@/components/share-thought-trail";
import { ExternalReferences } from "@/components/chat-message-content";
import { PublishedSynthesisArtifact } from "@/components/synthesis-panel";
import type { ChatMessagePage } from "@/lib/chat/contracts";
import type { BranchOutlineWorkspace } from "@/lib/branch-outlines/contracts";
import {
  createNodeDropResolver,
  formatBreadcrumb,
  getNodeDropZone,
  getVisibleNodeRoots,
  searchNodes,
  type NodeDropDestination,
  type NodeDropZone,
} from "@/lib/nodes/presentation";
import { assembleNodeTree, type FlatNode, type TreeNode } from "@/lib/nodes/tree";
import type { SynthesisWorkspace } from "@/lib/synthesis/contracts";
import type { BranchShareLinkState } from "@/lib/sharing/contracts";

import { SignOutButton } from "./auth-buttons";
import { BrandMark } from "./brand-mark";

type DashboardShellProps = {
  email: string;
  nodes: readonly FlatNode[];
  selectedNodeId?: string;
  initialChatPage?: ChatMessagePage;
  initialSynthesisWorkspace?: SynthesisWorkspace;
  initialBranchOutlineWorkspace?: BranchOutlineWorkspace;
  initialShareLink?: BranchShareLinkState | null;
  shareLinkEncryptionEnabled?: boolean;
  chatGenerationEnabled?: boolean;
  branchOutlineGenerationEnabled?: boolean;
};

const pendingTreeFocusKey = "mindtree:pending-tree-focus";
const pendingShowArchivedKey = "mindtree:pending-show-archived";
const pendingNewRootFocusKey = "mindtree:pending-new-root-focus";

function nodeHref(nodeId: string) {
  return `/?node=${encodeURIComponent(nodeId)}`;
}

function ChevronIcon() {
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
      <path d="m9 5 7 7-7 7" />
    </svg>
  );
}

function PlusIcon() {
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
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg
      className="search-icon"
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m16.5 16.5 4 4" />
    </svg>
  );
}

function EyeIcon() {
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
      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
      <circle cx="12" cy="12" r="2.5" />
    </svg>
  );
}

function EyeOffIcon() {
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
      <path d="M3 3l18 18" />
      <path d="M10.6 5.2A10.8 10.8 0 0 1 12 5c6 0 9.5 7 9.5 7a16.8 16.8 0 0 1-2.1 3" />
      <path d="M6.1 6.1A16.5 16.5 0 0 0 2.5 12S6 19 12 19c1.6 0 3-.5 4.3-1.1" />
    </svg>
  );
}

function ArchiveIcon() {
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
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8" />
      <path d="M10 12h4" />
    </svg>
  );
}

function UnarchiveIcon() {
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
      <path d="M4 7v5h5" />
      <path d="M5.6 16.5A8 8 0 1 0 6 7L4 9" />
    </svg>
  );
}

function MoveIcon() {
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
      <path d="M3 7.5h7l2 2h9v9H3z" />
      <path d="m10 14 2-2 2 2M12 12v5" />
    </svg>
  );
}

function ShareIcon() {
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
      <path d="M10.5 13.5a4.5 4.5 0 0 0 6.4 0l2-2a4.5 4.5 0 0 0-6.4-6.4l-1.1 1.1" />
      <path d="M13.5 10.5a4.5 4.5 0 0 0-6.4 0l-2 2a4.5 4.5 0 0 0 6.4 6.4l1.1-1.1" />
    </svg>
  );
}

function DeleteIcon() {
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
      <path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13" />
      <path d="M10 11v5M14 11v5" />
    </svg>
  );
}

function GripIcon() {
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
      <circle cx="9" cy="6" r="1" />
      <circle cx="15" cy="6" r="1" />
      <circle cx="9" cy="12" r="1" />
      <circle cx="15" cy="12" r="1" />
      <circle cx="9" cy="18" r="1" />
      <circle cx="15" cy="18" r="1" />
    </svg>
  );
}

function dropZoneForEvent(
  event: DragMoveEvent | DragEndEvent,
  pointerY: number | null,
): NodeDropZone | null {
  const activeRect = event.active.rect.current.translated;
  const overRect = event.over?.rect;
  if (!activeRect || !overRect) {
    return null;
  }

  return getNodeDropZone(pointerY ?? activeRect.top + activeRect.height / 2, overRect);
}

function describeDrop(node: TreeNode, zone: NodeDropZone) {
  return zone === "inside" ? `Move inside ${node.title}` : `Move ${zone} ${node.title}`;
}

function DraggableNodeRow({
  children,
  dragPending,
  dropIntent,
  expandPending,
  isSelected,
  node,
  registerRow,
  visualDepth,
}: {
  children: ReactNode;
  dragPending: boolean;
  dropIntent: NodeDropDestination | null;
  expandPending: boolean;
  isSelected: boolean;
  node: TreeNode;
  registerRow: (nodeId: string, element: HTMLDivElement | null) => void;
  visualDepth: number;
}) {
  const {
    isDragging,
    listeners,
    setActivatorNodeRef,
    setNodeRef: setDraggableNodeRef,
  } = useDraggable({ id: node.id, disabled: dragPending });
  const { setNodeRef: setDroppableNodeRef } = useDroppable({
    id: node.id,
    disabled: dragPending,
  });
  const setRowRef = useCallback(
    (element: HTMLDivElement | null) => {
      setDraggableNodeRef(element);
      setDroppableNodeRef(element);
      registerRow(node.id, element);
    },
    [node.id, registerRow, setDraggableNodeRef, setDroppableNodeRef],
  );
  const isDropTarget = dropIntent?.targetId === node.id;

  return (
    <div
      ref={setRowRef}
      className={[
        "node-row",
        isSelected ? "node-row--selected" : "",
        node.archivedAt ? "node-row--archived" : "",
        isDragging ? "node-row--dragging" : "",
        expandPending ? "node-row--drag-expand-pending" : "",
      ].filter(Boolean).join(" ")}
      data-drop-zone={isDropTarget ? dropIntent.zone : undefined}
      data-drop-label={isDropTarget ? describeDrop(node, dropIntent.zone) : undefined}
      style={{ "--node-depth": visualDepth } as CSSProperties}
    >
      {visualDepth > 0 ? (
        <span className="node-depth-markers" aria-hidden="true">
          {Array.from({ length: visualDepth }, (_, index) => (
            <span key={index} />
          ))}
        </span>
      ) : null}
      <span
        ref={setActivatorNodeRef}
        className="node-drag-handle"
        data-tooltip={`Drag ${node.title}`}
        aria-hidden="true"
        {...listeners}
      >
        <GripIcon />
      </span>
      {children}
    </div>
  );
}

function NodeCreateForm({
  parentId,
  parentTitle,
  onCancel,
  onCreated,
}: {
  parentId: string | null;
  parentTitle?: string;
  onCancel: () => void;
  onCreated: (nodeId: string, parentId: string | null) => void;
}) {
  const [title, setTitle] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = parentTitle ? `Child thought title for ${parentTitle}` : "Root thought title";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const result = await createNode({ title, parentId });
      if (!result.ok) {
        setError(result.fieldErrors?.title?.[0] ?? result.message);
        return;
      }
      onCreated(result.nodeId, parentId);
    } catch {
      setError("MindTree couldn’t add that thought. Please try again.");
    } finally {
      setPending(false);
    }
  }

  function keyDown(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key === "Escape" && !pending) {
      event.preventDefault();
      onCancel();
    }
  }

  return (
    <form className="node-create" onSubmit={submit} onKeyDown={keyDown}>
      <label>
        <span className="sr-only">{label}</span>
        <input
          autoFocus
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={parentTitle ? "Child thought" : "Root thought"}
          maxLength={200}
          disabled={pending}
        />
      </label>
      <button className="button button--primary button--small" type="submit" disabled={pending}>
        {pending ? "Adding…" : "Add"}
      </button>
      <button
        className="button button--quiet button--small"
        type="button"
        disabled={pending}
        onClick={onCancel}
      >
        Cancel
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </form>
  );
}

function TitleEditor({ node, onSaved }: { node: TreeNode; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(node.title);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) {
      return;
    }
    if (draft.trim() === node.title) {
      setEditing(false);
      setDraft(node.title);
      return;
    }

    setPending(true);
    setError(null);
    try {
      const result = await renameNode({ id: node.id, title: draft });
      if (!result.ok) {
        setError(result.fieldErrors?.title?.[0] ?? result.message);
        return;
      }
      setEditing(false);
      onSaved();
    } catch {
      setError("MindTree couldn’t rename that thought. Please try again.");
    } finally {
      setPending(false);
    }
  }

  function cancel() {
    setDraft(node.title);
    setError(null);
    setEditing(false);
    requestAnimationFrame(() => editButtonRef.current?.focus());
  }

  if (editing) {
    return (
      <form className="inline-editor inline-editor--title" onSubmit={save}>
        <label>
          <span className="sr-only">Thought title</span>
          <input
            autoFocus
            value={draft}
            maxLength={200}
            disabled={pending}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !pending) {
                event.preventDefault();
                cancel();
              }
            }}
          />
        </label>
        <button className="button button--primary button--small" type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </button>
        <button
          className="button button--quiet button--small"
          type="button"
          disabled={pending}
          onClick={cancel}
        >
          Cancel
        </button>
        {error ? <p role="alert">{error}</p> : null}
      </form>
    );
  }

  return (
    <div className="detail-title">
      <h1 id="node-detail-title" tabIndex={-1}>{node.title}</h1>
      <button
        ref={editButtonRef}
        className="text-action"
        type="button"
        onClick={() => {
          setDraft(node.title);
          setError(null);
          setEditing(true);
        }}
      >
        Edit title
      </button>
    </div>
  );
}

type DashboardWorkspaceProps = DashboardShellProps & {
  expanded: Set<string>;
  setExpanded: Dispatch<SetStateAction<Set<string>>>;
};

function DashboardWorkspace({
  email,
  nodes,
  selectedNodeId,
  initialChatPage,
  initialSynthesisWorkspace,
  initialBranchOutlineWorkspace,
  initialShareLink,
  shareLinkEncryptionEnabled = true,
  chatGenerationEnabled = false,
  branchOutlineGenerationEnabled = false,
  expanded,
  setExpanded,
}: DashboardWorkspaceProps) {
  const router = useRouter();
  const tree = useMemo(() => assembleNodeTree(nodes), [nodes]);
  const selectedNode = selectedNodeId ? tree.byId.get(selectedNodeId) ?? null : null;
  const [showArchived, setShowArchived] = useState(selectedNode?.archivedAt != null);
  const [constellationOpen, setConstellationOpen] = useState(false);
  const [creatingParentId, setCreatingParentId] = useState<
    string | null | undefined
  >(undefined);
  const [creatingChildSurface, setCreatingChildSurface] = useState<"tree" | "detail" | null>(null);
  const [searchText, setSearchText] = useState("");
  const [activeSearchIndex, setActiveSearchIndex] = useState(-1);
  const [moveDialogOpen, setMoveDialogOpen] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [chatDialogOpen, setChatDialogOpen] = useState(false);
  const [lifecyclePending, setLifecyclePending] = useState(false);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const [lifecycleStatus, setLifecycleStatus] = useState("");
  const [dragPending, setDragPending] = useState(false);
  const [dragError, setDragError] = useState<string | null>(null);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [dropIntent, setDropIntent] = useState<NodeDropDestination | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const createReturnFocus = useRef<HTMLElement | null>(null);
  const moveTriggerRef = useRef<HTMLButtonElement>(null);
  const shareTriggerRef = useRef<HTMLButtonElement>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement>(null);
  const chatTriggerRef = useRef<HTMLButtonElement>(null);
  const summaryHeadingRef = useRef<HTMLHeadingElement>(null);
  const approvalPreviousPublishedId = useRef<string | null | undefined>(undefined);
  const constellationTriggerRef = useRef<HTMLButtonElement>(null);
  const mobileConstellationTriggerRef = useRef<HTMLButtonElement>(null);
  const pendingConstellationFocus = useRef<"toolbar" | "mobile-detail" | null>(null);
  const newRootTriggerRef = useRef<HTMLButtonElement>(null);
  const lifecycleRequestInFlight = useRef(false);
  const pendingTreeFocus = useRef<string | null>(null);
  const nodeRowRefs = useRef(new Map<string, HTMLDivElement>());
  const pendingMoveLayout = useRef(new Map<string, DOMRect>());
  const dragPointerId = useRef<number | null>(null);
  const dragPointerY = useRef<number | null>(null);
  const lastPrimaryPointer = useRef<{ id: number; y: number } | null>(null);
  const rowLinkRefs = useRef(new Map<string, HTMLAnchorElement>());
  const searchOptionRefs = useRef(new Map<number, HTMLLIElement>());
  const searchResults = useMemo(
    () => searchNodes(tree.ordered, searchText),
    [searchText, tree.ordered],
  );
  const visibleRoots = useMemo(
    () => getVisibleNodeRoots(tree.roots, showArchived),
    [showArchived, tree.roots],
  );
  const synthesisWorkspace = initialSynthesisWorkspace ?? {
    published: null,
    staleAt: null,
    pending: null,
    history: [],
  };
  const branchOutlineWorkspace = initialBranchOutlineWorkspace ?? {
    current: null,
    pending: null,
    latestFailure: null,
    staleAt: null,
    staleReason: null,
  };

  useEffect(() => {
    const trackPointer = (event: PointerEvent) => {
      if (event.isPrimary) {
        lastPrimaryPointer.current = { id: event.pointerId, y: event.clientY };
        if (dragPointerId.current === event.pointerId) {
          dragPointerY.current = event.clientY;
        }
      }
    };
    window.addEventListener("pointermove", trackPointer, true);
    return () => window.removeEventListener("pointermove", trackPointer, true);
  }, []);

  const registerNodeRow = useCallback((nodeId: string, element: HTMLDivElement | null) => {
    if (element) {
      nodeRowRefs.current.set(nodeId, element);
    } else {
      nodeRowRefs.current.delete(nodeId);
    }
  }, []);

  const captureMoveLayout = useCallback(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      pendingMoveLayout.current.clear();
      return;
    }
    pendingMoveLayout.current = new Map(
      [...nodeRowRefs.current].map(([nodeId, element]) => [
        nodeId,
        element.getBoundingClientRect(),
      ]),
    );
  }, []);

  useLayoutEffect(() => {
    if (pendingMoveLayout.current.size === 0) return;
    const previousLayout = pendingMoveLayout.current;
    pendingMoveLayout.current = new Map();
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    for (const [nodeId, element] of nodeRowRefs.current) {
      const previous = previousLayout.get(nodeId);
      if (!previous) continue;
      const current = element.getBoundingClientRect();
      const deltaX = previous.left - current.left;
      const deltaY = previous.top - current.top;
      if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) continue;
      element.animate(
        [
          { transform: `translate(${deltaX}px, ${deltaY}px)` },
          { transform: "translate(0, 0)" },
        ],
        {
          duration: 420,
          easing: "cubic-bezier(0.16, 1, 0.3, 1)",
        },
      );
    }
  }, [nodes]);

  useEffect(() => {
    const previousPublishedId = approvalPreviousPublishedId.current;
    const nextPublishedId = synthesisWorkspace.published?.id ?? null;
    if (previousPublishedId === undefined || previousPublishedId === nextPublishedId) return;
    approvalPreviousPublishedId.current = undefined;
    const frame = requestAnimationFrame(() => summaryHeadingRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [synthesisWorkspace.published?.id]);
  const activeDragNode = activeDragId ? tree.byId.get(activeDragId) ?? null : null;
  const activeDropResolver = useMemo(
    () => activeDragNode ? createNodeDropResolver(tree.ordered, activeDragNode) : null,
    [activeDragNode, tree.ordered],
  );
  const autoExpandTarget = dropIntent ? tree.byId.get(dropIntent.targetId) : undefined;
  const autoExpandCandidateId =
    dropIntent?.zone === "inside" &&
    autoExpandTarget &&
    autoExpandTarget.children.length > 0 &&
    !expanded.has(autoExpandTarget.id)
      ? autoExpandTarget.id
      : null;

  useEffect(() => {
    if (selectedNode?.archivedAt === null || selectedNode?.archivedAt === undefined) {
      return;
    }
    const frame = requestAnimationFrame(() => setShowArchived(true));
    return () => cancelAnimationFrame(frame);
  }, [selectedNode?.archivedAt, selectedNode?.id]);

  useEffect(() => {
    let showArchivedFrame: number | null = null;
    let newRootFocusFrame: number | null = null;
    let newRootSettleFrame: number | null = null;
    if (sessionStorage.getItem(pendingShowArchivedKey) === "true") {
      showArchivedFrame = requestAnimationFrame(() => {
        sessionStorage.removeItem(pendingShowArchivedKey);
        setShowArchived(true);
      });
    }
    const nodeId = sessionStorage.getItem(pendingTreeFocusKey);
    if (nodeId && tree.byId.has(nodeId)) {
      sessionStorage.removeItem(pendingTreeFocusKey);
      pendingTreeFocus.current = nodeId;
    }
    if (sessionStorage.getItem(pendingNewRootFocusKey) === "true") {
      newRootFocusFrame = requestAnimationFrame(() => {
        newRootSettleFrame = requestAnimationFrame(() => {
          newRootTriggerRef.current?.focus();
          sessionStorage.removeItem(pendingNewRootFocusKey);
        });
      });
    }
    return () => {
      if (showArchivedFrame !== null) {
        cancelAnimationFrame(showArchivedFrame);
      }
      if (newRootFocusFrame !== null) {
        cancelAnimationFrame(newRootFocusFrame);
      }
      if (newRootSettleFrame !== null) {
        cancelAnimationFrame(newRootSettleFrame);
      }
    };
  }, [tree]);

  useEffect(() => {
    if (constellationOpen) {
      return;
    }
    const nodeId = pendingTreeFocus.current;
    if (!nodeId || !tree.byId.has(nodeId)) {
      return;
    }
    let settleFrame: number | null = null;
    const frame = requestAnimationFrame(() => {
      settleFrame = requestAnimationFrame(() => {
        const target = window.matchMedia("(max-width: 760px)").matches
          ? document.getElementById("node-detail-title")
          : rowLinkRefs.current.get(nodeId);
        target?.scrollIntoView({ block: "center" });
        target?.focus();
        pendingTreeFocus.current = null;
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      if (settleFrame !== null) {
        cancelAnimationFrame(settleFrame);
      }
    };
  }, [constellationOpen, tree]);

  useEffect(() => {
    const target = pendingConstellationFocus.current;
    if (
      (target === "toolbar" && !constellationOpen) ||
      (target === "mobile-detail" && constellationOpen) ||
      target === null
    ) {
      return;
    }
    pendingConstellationFocus.current = null;
    const frame = requestAnimationFrame(() => {
      if (target === "toolbar") {
        constellationTriggerRef.current?.focus();
      } else {
        mobileConstellationTriggerRef.current?.focus();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [constellationOpen]);

  useEffect(() => {
    if (activeSearchIndex < 0) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      searchOptionRefs.current.get(activeSearchIndex)?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [activeSearchIndex]);

  useEffect(() => {
    if (!autoExpandCandidateId) {
      return;
    }
    const delay = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 500 : 1_200;
    const timer = window.setTimeout(() => {
      setExpanded((current) => new Set(current).add(autoExpandCandidateId));
    }, delay);
    return () => window.clearTimeout(timer);
  }, [autoExpandCandidateId, setExpanded]);

  function created(nodeId: string, parentId: string | null) {
    if (parentId !== null) {
      setExpanded((current) => new Set(current).add(parentId));
    }
    setCreatingParentId(undefined);
    setCreatingChildSurface(null);
    createReturnFocus.current = null;
    router.push(nodeHref(nodeId));
  }

  function cancelCreating() {
    setCreatingParentId(undefined);
    setCreatingChildSurface(null);
    requestAnimationFrame(() => createReturnFocus.current?.focus());
  }

  function beginChild(
    node: TreeNode,
    trigger: HTMLElement,
    surface: "tree" | "detail" = "tree",
  ) {
    setExpanded((current) => {
      const next = new Set(current);
      for (const item of node.breadcrumb) {
        next.add(item.id);
      }
      return next;
    });
    createReturnFocus.current = trigger;
    setCreatingChildSurface(surface);
    setCreatingParentId(node.id);
  }

  function registerRowLink(nodeId: string, element: HTMLAnchorElement | null) {
    if (element) {
      rowLinkRefs.current.set(nodeId, element);
    } else {
      rowLinkRefs.current.delete(nodeId);
    }
  }

  function chooseSearchResult(node: TreeNode) {
    setConstellationOpen(false);
    if (node.archivedAt !== null) {
      setShowArchived(true);
    }
    setSearchText("");
    setActiveSearchIndex(-1);
    setExpanded((current) => {
      const next = new Set(current);
      for (const ancestor of node.breadcrumb.slice(0, -1)) {
        next.add(ancestor.id);
      }
      return next;
    });
    pendingTreeFocus.current = node.id;
    if (node.id !== selectedNode?.id) {
      sessionStorage.setItem(pendingTreeFocusKey, node.id);
      router.push(nodeHref(node.id));
      return;
    }
    requestAnimationFrame(() => {
      const link = rowLinkRefs.current.get(node.id);
      link?.scrollIntoView({ block: "center" });
      link?.focus();
      pendingTreeFocus.current = null;
    });
  }

  function openNodeFromConstellation(nodeId: string) {
    const node = tree.byId.get(nodeId);
    if (!node) {
      return;
    }
    if (node.archivedAt !== null) {
      setShowArchived(true);
    }
    setExpanded((current) => {
      const next = new Set(current);
      for (const ancestor of node.breadcrumb.slice(0, -1)) {
        next.add(ancestor.id);
      }
      return next;
    });
    pendingTreeFocus.current = node.id;
    setConstellationOpen(false);
    if (node.id !== selectedNode?.id) {
      sessionStorage.setItem(pendingTreeFocusKey, node.id);
      router.push(nodeHref(node.id));
    }
  }

  function resolveDropIntent(event: DragMoveEvent | DragEndEvent) {
    const source = tree.byId.get(String(event.active.id));
    const target = event.over ? tree.byId.get(String(event.over.id)) : undefined;
    const zone = dropZoneForEvent(event, dragPointerY.current);
    if (!source || !target || !zone) {
      return null;
    }
    const resolver = activeDropResolver ?? createNodeDropResolver(tree.ordered, source);
    return resolver(target, zone);
  }

  async function dropped(event: DragEndEvent) {
    const destination = resolveDropIntent(event);
    const sourceId = String(event.active.id);
    dragPointerId.current = null;
    dragPointerY.current = null;
    setActiveDragId(null);
    setDropIntent(null);
    if (!destination || dragPending) {
      return;
    }

    setDragPending(true);
    setDragError(null);
    try {
      const result = await moveNode({
        id: sourceId,
        parentId: destination.parentId,
        position: destination.position,
      });
      if (!result.ok) {
        setDragError(result.message);
        return;
      }
      captureMoveLayout();
      if (destination.parentId !== null) {
        const parentId = destination.parentId;
        setExpanded((current) => new Set(current).add(parentId));
      }
      pendingTreeFocus.current = sourceId;
      router.refresh();
    } catch {
      setDragError(
        "MindTree couldn’t confirm the move. The tree was refreshed; check the thought’s current location before trying again.",
      );
      router.refresh();
    } finally {
      setDragPending(false);
    }
  }

  function moved(parentId: string | null) {
    captureMoveLayout();
    setMoveDialogOpen(false);
    if (parentId !== null) {
      const parent = tree.byId.get(parentId);
      setExpanded((current) => {
        const next = new Set(current);
        for (const ancestor of parent?.breadcrumb ?? []) {
          next.add(ancestor.id);
        }
        return next;
      });
    }
    if (selectedNode) {
      pendingTreeFocus.current = selectedNode.id;
    }
    router.refresh();
  }

  function deleted(recoveryNodeId: string | null) {
    setDeleteDialogOpen(false);

    if (recoveryNodeId) {
      sessionStorage.setItem(pendingTreeFocusKey, recoveryNodeId);
      router.push(nodeHref(recoveryNodeId));
      return;
    }
    sessionStorage.setItem(pendingNewRootFocusKey, "true");
    router.push("/");
  }

  async function changeArchiveState() {
    if (!selectedNode || lifecycleRequestInFlight.current) {
      return;
    }
    lifecycleRequestInFlight.current = true;
    setLifecyclePending(true);
    setLifecycleError(null);
    setLifecycleStatus(
      `${selectedNode.archivedAt ? "Unarchiving" : "Archiving"} ${selectedNode.title}…`,
    );
    setCreatingParentId(undefined);
    setCreatingChildSurface(null);
    try {
      const result = selectedNode.archivedAt
        ? await unarchiveNode({ id: selectedNode.id })
        : await archiveNode({ id: selectedNode.id });
      if (!result.ok) {
        setLifecycleStatus("");
        setLifecycleError(result.message);
        return;
      }
      setLifecycleStatus(
        `${selectedNode.title} ${selectedNode.archivedAt ? "unarchived" : "archived"}.`,
      );
      if (selectedNode.archivedAt === null) {
        setShowArchived(true);
      }
      router.refresh();
    } catch {
      setLifecycleStatus("");
      setLifecycleError(
        selectedNode.archivedAt
          ? "MindTree couldn’t confirm the unarchive. The tree was refreshed; check the thought’s current state before trying again."
          : "MindTree couldn’t confirm the archive. The tree was refreshed; check the thought’s current state before trying again.",
      );
      router.refresh();
    } finally {
      lifecycleRequestInFlight.current = false;
      setLifecyclePending(false);
    }
  }

  return (
    <main
      className={[
        "dashboard",
        selectedNode && !constellationOpen ? "dashboard--detail" : "",
        constellationOpen ? "dashboard--constellation" : "",
      ].filter(Boolean).join(" ")}
      data-testid="dashboard-shell"
    >
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
        <div className="toolbar-count">
          <p className="eyebrow">{nodes.length === 1 ? "1 node" : `${nodes.length} nodes`}</p>
        </div>
        <div className="tree-search">
          <SearchIcon />
          <label>
            <span className="sr-only">Search thought titles</span>
            <input
              role="combobox"
              type="search"
              value={searchText}
              placeholder="Search thoughts"
              aria-autocomplete="list"
              aria-controls={searchText.trim() ? "tree-search-results" : undefined}
              aria-describedby="tree-search-status"
              aria-expanded={Boolean(searchText.trim())}
              aria-activedescendant={
                activeSearchIndex >= 0 ? `tree-search-result-${activeSearchIndex}` : undefined
              }
              onChange={(event) => {
                setSearchText(event.target.value);
                setActiveSearchIndex(-1);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setSearchText("");
                  setActiveSearchIndex(-1);
                  return;
                }
                if (searchResults.length === 0) {
                  return;
                }
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  setActiveSearchIndex((current) => {
                    if (event.key === "ArrowDown") {
                      return current >= searchResults.length - 1 ? 0 : current + 1;
                    }
                    return current <= 0 ? searchResults.length - 1 : current - 1;
                  });
                  return;
                }
                if (event.key === "Enter" && activeSearchIndex >= 0) {
                  event.preventDefault();
                  chooseSearchResult(searchResults[activeSearchIndex]);
                }
              }}
            />
          </label>
          <p id="tree-search-status" className="sr-only" role="status" aria-live="polite">
            {searchText.trim()
              ? searchResults.length === 0
                ? "No matching thoughts."
                : `${searchResults.length} ${searchResults.length === 1 ? "result" : "results"} available.`
              : ""}
          </p>
          {searchText.trim() ? (
            <ul
              id="tree-search-results"
              className="search-results"
              aria-label="Search results"
              role="listbox"
            >
              {searchResults.map((node, index) => (
                <li
                  id={`tree-search-result-${index}`}
                  className="search-result"
                  key={node.id}
                  role="option"
                  ref={(element) => {
                    if (element) {
                      searchOptionRefs.current.set(index, element);
                    } else {
                      searchOptionRefs.current.delete(index);
                    }
                  }}
                  aria-selected={index === activeSearchIndex}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => chooseSearchResult(node)}
                >
                  <strong>{node.title}</strong>
                  <span>
                    {formatBreadcrumb(node)}
                    {node.archivedAt ? " · Archived" : ""}
                  </span>
                </li>
              ))}
              {searchResults.length === 0 ? (
                <li className="search-results__empty">No matching thoughts.</li>
              ) : null}
            </ul>
          ) : null}
        </div>
        <div className="toolbar-actions">
          <button
            className="icon-button icon-button--toggle"
            type="button"
            aria-label="Show archived"
            aria-pressed={showArchived}
            data-tooltip={showArchived ? "Hide archived" : "Show archived"}
            onClick={() => {
              const next = !showArchived;
              setShowArchived(next);
              if (!next && selectedNode?.archivedAt != null) {
                router.push("/");
              }
            }}
          >
            {showArchived ? <EyeOffIcon /> : <EyeIcon />}
          </button>
          <button
            ref={constellationTriggerRef}
            className="icon-button icon-button--toggle"
            type="button"
            aria-label="Node constellation"
            aria-pressed={constellationOpen}
            data-tooltip={
              constellationOpen ? "Return to thought tree" : "Open node constellation"
            }
            onClick={() => {
              setCreatingParentId(undefined);
              setCreatingChildSurface(null);
              setConstellationOpen((current) => {
                if (
                  current &&
                  selectedNode &&
                  window.matchMedia("(max-width: 760px)").matches
                ) {
                  pendingConstellationFocus.current = "mobile-detail";
                }
                return !current;
              });
            }}
          >
            <NodeConstellationIcon />
          </button>
          <button
            ref={newRootTriggerRef}
            className="icon-button icon-button--primary"
            type="button"
            aria-label="New root thought"
            aria-expanded={creatingParentId === null}
            data-tooltip="New root thought"
            onClick={(event) => {
              setConstellationOpen(false);
              if (creatingParentId === null) {
                setCreatingParentId(undefined);
              } else {
                createReturnFocus.current = event.currentTarget;
                setCreatingChildSurface(null);
                setCreatingParentId(null);
              }
            }}
          >
            <PlusIcon />
          </button>
        </div>
      </div>

      {creatingParentId === null ? (
        <div className="root-create-panel">
          <NodeCreateForm
            parentId={null}
            onCancel={cancelCreating}
            onCreated={created}
          />
        </div>
      ) : null}

      {constellationOpen ? (
        <NodeConstellation
          variant="owner"
          nodes={tree.ordered}
          selectedNodeId={selectedNode?.id}
          showArchived={showArchived}
          onCreateRoot={() => {
            createReturnFocus.current =
              constellationTriggerRef.current ?? newRootTriggerRef.current;
            setConstellationOpen(false);
            setCreatingChildSurface(null);
            setCreatingParentId(null);
          }}
          onOpenNode={openNodeFromConstellation}
          onShowArchived={() => setShowArchived(true)}
        />
      ) : (
      <div className={`dashboard-main${selectedNode ? " dashboard-main--detail" : ""}`}>
        <nav className="tree-pane" aria-label="Thought tree">
          <p className="pane-eyebrow">Thoughts</p>
          {tree.roots.length === 0 ? (
            <div className="tree-empty">
              <p>No thoughts yet.</p>
              <button
                className="text-action"
                type="button"
                onClick={(event) => {
                  createReturnFocus.current = event.currentTarget;
                  setCreatingChildSurface(null);
                  setCreatingParentId(null);
                }}
              >
                Create the first thought
              </button>
            </div>
          ) : visibleRoots.length === 0 ? (
            <div className="tree-empty">
              <p>No active thoughts.</p>
              <button className="text-action" type="button" onClick={() => setShowArchived(true)}>
                Show archived thoughts
              </button>
            </div>
          ) : (
            <>
              {dragPending ? <p className="tree-move-status" role="status">Moving thought…</p> : null}
              {dragError ? <p className="tree-move-error" role="alert">{dragError}</p> : null}
              <DndContext
                sensors={sensors}
                collisionDetection={pointerWithin}
                measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
                onDragStart={(event: DragStartEvent) => {
                  const activatorEvent = event.activatorEvent;
                  const pointerId = "pointerId" in activatorEvent &&
                    typeof activatorEvent.pointerId === "number"
                    ? activatorEvent.pointerId
                    : null;
                  const lastPointer = lastPrimaryPointer.current;
                  dragPointerId.current = pointerId;
                  dragPointerY.current = pointerId !== null && lastPointer?.id === pointerId
                    ? lastPointer.y
                    : "clientY" in activatorEvent &&
                    typeof activatorEvent.clientY === "number"
                      ? activatorEvent.clientY
                      : null;
                  setActiveDragId(String(event.active.id));
                  setDragError(null);
                }}
                onDragMove={(event: DragMoveEvent) => setDropIntent(resolveDropIntent(event))}
                onDragEnd={(event: DragEndEvent) => void dropped(event)}
                onDragCancel={() => {
                  dragPointerId.current = null;
                  dragPointerY.current = null;
                  setActiveDragId(null);
                  setDropIntent(null);
                }}
              >
                <NodeTreeList
                  roots={visibleRoots}
                  expanded={expanded}
                  renderNode={(node, depth) => {
                    const visualDepth = Math.min(depth, 12);
                    const isExpanded = expanded.has(node.id);
                    const isSelected = node.id === selectedNode?.id;
                    return (
                      <>
                        <DraggableNodeRow
                          node={node}
                          visualDepth={visualDepth}
                          isSelected={isSelected}
                          dragPending={dragPending}
                          dropIntent={dropIntent}
                          expandPending={autoExpandCandidateId === node.id}
                          registerRow={registerNodeRow}
                        >
                      {node.children.length > 0 ? (
                        <button
                          className="node-expander"
                          type="button"
                          aria-label={`${isExpanded ? "Collapse" : "Expand"} ${node.title}`}
                          aria-expanded={isExpanded}
                          onClick={() =>
                            setExpanded((current) => {
                              const next = new Set(current);
                              if (next.has(node.id)) {
                                next.delete(node.id);
                              } else {
                                next.add(node.id);
                              }
                              return next;
                            })
                          }
                        >
                          <ChevronIcon />
                        </button>
                      ) : (
                        <span className="node-expander node-expander--placeholder" aria-hidden="true" />
                      )}
                      <Link
                        ref={(element) => registerRowLink(node.id, element)}
                        className="node-row__link"
                        href={nodeHref(node.id)}
                        aria-current={isSelected ? "page" : undefined}
                      >
                        <span>{node.title}</span>
                        <small>{node.archivedAt ? "Archived" : "Active"}</small>
                      </Link>
                      {node.archivedAt === null ? (
                        <button
                          className="add-child-button icon-button"
                          type="button"
                          aria-label={`Add child to ${node.title}`}
                          data-tooltip={`Add child to ${node.title}`}
                          onClick={(event) => beginChild(node, event.currentTarget)}
                        >
                          <PlusIcon />
                        </button>
                      ) : (
                        <span className="add-child-button" aria-hidden="true" />
                      )}
                        </DraggableNodeRow>
                        {creatingParentId === node.id && creatingChildSurface === "tree" ? (
                          <div
                            className="tree-child-create"
                            style={{ "--node-depth": Math.min(depth + 1, 12) } as CSSProperties}
                          >
                            <NodeCreateForm
                              parentId={node.id}
                              parentTitle={node.title}
                              onCancel={cancelCreating}
                              onCreated={created}
                            />
                          </div>
                        ) : null}
                      </>
                    );
                  }}
                />
                <DragOverlay dropAnimation={null}>
                  {activeDragNode ? (
                    <div className="node-drag-overlay">
                      <GripIcon />
                      <span>{activeDragNode.title}</span>
                    </div>
                  ) : null}
                </DragOverlay>
              </DndContext>
            </>
          )}
        </nav>

        <section className="detail-pane" aria-labelledby={selectedNode ? "node-detail-title" : "detail-empty-title"}>
          {selectedNode ? (
            <>
              <div className="mobile-detail-nav">
                <Link
                  className="mobile-back"
                  href="/"
                  onClick={() => {
                    if (showArchived) {
                      sessionStorage.setItem(pendingShowArchivedKey, "true");
                    }
                  }}
                >
                  <span aria-hidden="true">←</span> Back to thoughts
                </Link>
                <button
                  ref={mobileConstellationTriggerRef}
                  className="icon-button icon-button--toggle mobile-constellation-trigger"
                  type="button"
                  aria-label="Open node constellation"
                  data-tooltip="Open node constellation"
                  onClick={() => {
                    pendingConstellationFocus.current = "toolbar";
                    setCreatingParentId(undefined);
                    setCreatingChildSurface(null);
                    setConstellationOpen(true);
                  }}
                >
                  <NodeConstellationIcon />
                </button>
              </div>
              <nav className="breadcrumbs" aria-label="Breadcrumb">
                <ol>
                  {selectedNode.breadcrumb.map((item, index) => (
                    <li key={item.id}>
                      {index < selectedNode.breadcrumb.length - 1 ? (
                        <Link href={nodeHref(item.id)}>{item.title}</Link>
                      ) : (
                        <span aria-current="page">{item.title}</span>
                      )}
                    </li>
                  ))}
                </ol>
              </nav>
              <TitleEditor
                key={`${selectedNode.id}:${selectedNode.title}`}
                node={selectedNode}
                onSaved={() => router.refresh()}
              />
              <p className="node-status-line">
                {selectedNode.archivedAt ? "Archived" : "Active"}
              </p>
              <button
                ref={chatTriggerRef}
                className="button button--primary node-chat-button"
                type="button"
                onClick={() => setChatDialogOpen(true)}
              >
                Chat
              </button>
              <div className="node-actions" aria-label="Thought actions">
                {selectedNode.archivedAt === null ? (
                  <button
                    className="icon-button"
                    type="button"
                    aria-label="Add child"
                    data-tooltip="Add child"
                    onClick={(event) => beginChild(
                      selectedNode,
                      event.currentTarget,
                      window.matchMedia("(max-width: 760px)").matches ? "detail" : "tree",
                    )}
                  >
                    <PlusIcon />
                  </button>
                ) : null}
                <button
                  className="icon-button"
                  type="button"
                  aria-label={
                    lifecyclePending
                      ? "Saving archive state"
                      : selectedNode.archivedAt
                        ? "Unarchive"
                        : "Archive"
                  }
                  data-tooltip={selectedNode.archivedAt ? "Unarchive thought" : "Archive thought"}
                  disabled={lifecyclePending}
                  onClick={() => void changeArchiveState()}
                >
                  {selectedNode.archivedAt ? <UnarchiveIcon /> : <ArchiveIcon />}
                </button>
                <button
                  ref={moveTriggerRef}
                  className="icon-button"
                  type="button"
                  aria-label="Move To…"
                  data-tooltip="Move To…"
                  onClick={() => setMoveDialogOpen(true)}
                >
                  <MoveIcon />
                </button>
                <button
                  ref={shareTriggerRef}
                  className="icon-button"
                  type="button"
                  aria-label="Share thought trail"
                  aria-haspopup="dialog"
                  aria-controls={`share-trail-dialog-${selectedNode.id}`}
                  data-tooltip="Share thought trail"
                  onClick={() => setShareDialogOpen(true)}
                >
                  <ShareIcon />
                </button>
                <button
                  ref={deleteTriggerRef}
                  className="icon-button icon-button--danger"
                  type="button"
                  aria-label="Delete"
                  data-tooltip="Delete thought"
                  onClick={() => setDeleteDialogOpen(true)}
                >
                  <DeleteIcon />
                </button>
              </div>
              <p className="sr-only" role="status" aria-live="polite">
                {lifecycleStatus}
              </p>
              {lifecycleError ? <p role="alert">{lifecycleError}</p> : null}
              <div className="node-summary">
                {synthesisWorkspace.published ? (
                  <PublishedSynthesisArtifact
                    key={synthesisWorkspace.published.id}
                    synthesis={synthesisWorkspace.published}
                    staleAt={synthesisWorkspace.staleAt}
                    headingRef={summaryHeadingRef}
                  />
                ) : (
                  <section aria-labelledby={`node-summary-${selectedNode.id}`}>
                    <h2
                      id={`node-summary-${selectedNode.id}`}
                      ref={summaryHeadingRef}
                      tabIndex={-1}
                    >
                      Summary
                    </h2>
                    <p className="synthesis-conversation-empty">
                      No Summary is published yet. Open Chat when this thought is ready to synthesize.
                    </p>
                  </section>
                )}
              </div>
              {synthesisWorkspace.published ? (
                <ExternalReferences
                  key={synthesisWorkspace.published.id}
                  citations={synthesisWorkspace.published.citations.filter(
                    (citation) => citation.kind === "external",
                  )}
                  headingLevel={2}
                />
              ) : null}
              <BranchOutlinePanel
                key={[
                  selectedNode.id,
                  branchOutlineWorkspace.current?.id ?? "none",
                  branchOutlineWorkspace.pending?.id ?? "none",
                  branchOutlineWorkspace.latestFailure?.id ?? "none",
                  branchOutlineWorkspace.staleAt ?? "current",
                ].join(":")}
                nodeId={selectedNode.id}
                initialWorkspace={branchOutlineWorkspace}
                generationEnabled={branchOutlineGenerationEnabled}
              />
              {creatingParentId === selectedNode.id && creatingChildSurface === "detail" ? (
                <NodeCreateForm
                  parentId={selectedNode.id}
                  parentTitle={selectedNode.title}
                  onCancel={cancelCreating}
                  onCreated={created}
                />
              ) : null}
            </>
          ) : (
            <div className="empty-state">
              <p className="pane-eyebrow">MindTree</p>
              <h1 id="detail-empty-title">
                {tree.roots.length === 0 ? "Start with one thought." : "Choose a thought."}
              </h1>
              <p>
                {tree.roots.length === 0
                  ? "Create a root thought, then grow it at any depth."
                  : "Select any thought to open its workspace."}
              </p>
            </div>
          )}
        </section>
      </div>
      )}
      {selectedNode && moveDialogOpen ? (
        <MoveNodeDialog
          node={selectedNode}
          nodes={tree.ordered}
          onClose={() => setMoveDialogOpen(false)}
          onMoved={moved}
          returnFocusRef={moveTriggerRef}
        />
      ) : null}
      {selectedNode && deleteDialogOpen ? (
        <DeleteNodeDialog
          node={selectedNode}
          onClose={() => setDeleteDialogOpen(false)}
          onDeleted={deleted}
          returnFocusRef={deleteTriggerRef}
        />
      ) : null}
      {selectedNode ? (
        <ShareThoughtTrail
          key={`share-${selectedNode.id}`}
          archived={selectedNode.archivedAt !== null}
          initialLink={initialShareLink ?? null}
          nodeId={selectedNode.id}
          nodeTitle={selectedNode.title}
          open={shareDialogOpen}
          onClose={() => setShareDialogOpen(false)}
          recoveryEnabled={shareLinkEncryptionEnabled}
          returnFocusRef={shareTriggerRef}
        />
      ) : null}
      {selectedNode ? (
        <ChatPanel
          key={`chat-${selectedNode.id}`}
          nodeId={selectedNode.id}
          nodeTitle={selectedNode.title}
          initialPage={initialChatPage ?? { messages: [], nextCursor: null }}
          synthesisWorkspace={synthesisWorkspace}
          generationEnabled={chatGenerationEnabled}
          open={chatDialogOpen}
          returnFocusRef={chatTriggerRef}
          onClose={() => setChatDialogOpen(false)}
          onApprovalSettled={() => {
            approvalPreviousPublishedId.current = synthesisWorkspace.published?.id ?? null;
            setChatDialogOpen(false);
          }}
        />
      ) : null}
    </main>
  );
}

export function DashboardShell(props: DashboardShellProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const tree = assembleNodeTree(props.nodes);
    const selectedNode = props.selectedNodeId
      ? tree.byId.get(props.selectedNodeId) ?? null
      : null;
    return new Set(
      selectedNode?.breadcrumb.slice(0, -1).map(({ id }) => id) ?? [],
    );
  });

  return (
    <DashboardWorkspace
      key={props.selectedNodeId ?? "tree"}
      {...props}
      expanded={expanded}
      setExpanded={setExpanded}
    />
  );
}
