"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
} from "react";

import { createNode, renameNode } from "@/app/actions/nodes";
import { NodeTreeList } from "@/components/node-tree-list";
import { assembleNodeTree, type FlatNode, type TreeNode } from "@/lib/nodes/tree";

import { SignOutButton } from "./auth-buttons";
import { BrandMark } from "./brand-mark";

type DashboardShellProps = {
  email: string;
  nodes: readonly FlatNode[];
  selectedNodeId?: string;
};

function nodeHref(nodeId: string) {
  return `/?node=${encodeURIComponent(nodeId)}`;
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
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
      <path d={expanded ? "m5 9 7 7 7-7" : "m9 5 7 7-7 7"} />
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
      <h1 id="node-detail-title">{node.title}</h1>
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

function DashboardWorkspace({ email, nodes, selectedNodeId }: DashboardShellProps) {
  const router = useRouter();
  const tree = useMemo(() => assembleNodeTree(nodes), [nodes]);
  const selectedNode = selectedNodeId ? tree.byId.get(selectedNodeId) ?? null : null;
  const [expanded, setExpanded] = useState<Set<string>>(
    () =>
      new Set(
        selectedNode?.breadcrumb.slice(0, -1).map(({ id }) => id) ?? [],
      ),
  );
  const [creatingParentId, setCreatingParentId] = useState<
    string | null | undefined
  >(undefined);
  const createReturnFocus = useRef<HTMLElement | null>(null);

  function created(nodeId: string, parentId: string | null) {
    if (parentId !== null) {
      setExpanded((current) => new Set(current).add(parentId));
    }
    setCreatingParentId(undefined);
    createReturnFocus.current = null;
    router.push(nodeHref(nodeId));
  }

  function cancelCreating() {
    setCreatingParentId(undefined);
    requestAnimationFrame(() => createReturnFocus.current?.focus());
  }

  function beginChild(node: TreeNode, trigger: HTMLElement) {
    setExpanded((current) => new Set(current).add(node.id));
    createReturnFocus.current = trigger;
    setCreatingParentId(node.id);
  }

  return (
    <main
      className={`dashboard${selectedNode ? " dashboard--detail" : ""}`}
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
        <label className="tree-search">
          <span className="sr-only">Search nodes</span>
          <input type="search" placeholder="Search thoughts" disabled />
        </label>
        <div className="toolbar-actions">
          <button className="button button--quiet" type="button" disabled>
            Show archived
          </button>
          <button
            className="button button--primary"
            type="button"
            aria-expanded={creatingParentId === null}
            onClick={(event) => {
              if (creatingParentId === null) {
                setCreatingParentId(undefined);
              } else {
                createReturnFocus.current = event.currentTarget;
                setCreatingParentId(null);
              }
            }}
          >
            New root
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

      <div className={`dashboard-main${selectedNode ? " dashboard-main--detail" : ""}`}>
        <nav className="tree-pane" aria-label="Thought tree">
          <p className="pane-eyebrow">Thoughts</p>
          {tree.roots.length > 0 ? (
            <NodeTreeList
              roots={tree.roots}
              expanded={expanded}
              renderNode={(node, depth) => {
                const visualDepth = Math.min(depth, 12);
                const isExpanded = expanded.has(node.id);
                const isSelected = node.id === selectedNode?.id;
                return (
                  <>
                    <div
                      className={`node-row${isSelected ? " node-row--selected" : ""}`}
                      style={{ "--node-depth": visualDepth } as CSSProperties}
                    >
                      {visualDepth > 0 ? (
                        <span className="node-depth-markers" aria-hidden="true">
                          {Array.from({ length: visualDepth }, (_, index) => (
                            <span key={index} />
                          ))}
                        </span>
                      ) : null}
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
                          <ChevronIcon expanded={isExpanded} />
                        </button>
                      ) : (
                        <span className="node-expander node-expander--placeholder" aria-hidden="true" />
                      )}
                      <Link
                        className="node-row__link"
                        href={nodeHref(node.id)}
                        aria-current={isSelected ? "page" : undefined}
                      >
                        <span>{node.title}</span>
                        <small>{node.archivedAt ? "Archived" : "No synthesis yet"}</small>
                      </Link>
                      <button
                        className="add-child-button icon-button"
                        type="button"
                        aria-label={`Add child to ${node.title}`}
                        data-tooltip={`Add child to ${node.title}`}
                        onClick={(event) => beginChild(node, event.currentTarget)}
                      >
                        <PlusIcon />
                      </button>
                    </div>
                    {creatingParentId === node.id && node.id !== selectedNode?.id ? (
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
          ) : (
            <div className="tree-empty">
              <p>No thoughts yet.</p>
              <button
                className="text-action"
                type="button"
                onClick={(event) => {
                  createReturnFocus.current = event.currentTarget;
                  setCreatingParentId(null);
                }}
              >
                Create the first thought
              </button>
            </div>
          )}
        </nav>

        <section className="detail-pane" aria-labelledby={selectedNode ? "node-detail-title" : "detail-empty-title"}>
          {selectedNode ? (
            <>
              <Link className="mobile-back" href="/">
                <span aria-hidden="true">←</span> Back to thoughts
              </Link>
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
              <div className="detail-actions">
                <button
                  className="button button--quiet"
                  type="button"
                  onClick={(event) => beginChild(selectedNode, event.currentTarget)}
                >
                  Add child
                </button>
              </div>
              {creatingParentId === selectedNode.id ? (
                <NodeCreateForm
                  parentId={selectedNode.id}
                  parentTitle={selectedNode.title}
                  onCancel={cancelCreating}
                  onCreated={created}
                />
              ) : null}
              <section className="synthesis-placeholder" aria-labelledby="fixture-synthesis-title">
                <p className="pane-eyebrow">Synthesis</p>
                <h2 id="fixture-synthesis-title">No synthesis yet</h2>
                <p>Approved synthesis will stay distinct from the conversation that shaped it.</p>
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
    </main>
  );
}

export function DashboardShell(props: DashboardShellProps) {
  return <DashboardWorkspace key={props.selectedNodeId ?? "tree"} {...props} />;
}
