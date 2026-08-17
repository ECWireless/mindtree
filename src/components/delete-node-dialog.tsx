"use client";

import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { useRouter } from "next/navigation";

import { deleteNode } from "@/app/actions/nodes";
import type { TreeNode } from "@/lib/nodes/tree";
import { isDialogBackdropClick } from "@/lib/ui/dialog";

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

export function DeleteNodeDialog({
  node,
  onClose,
  onDeleted,
  returnFocusRef,
}: {
  node: TreeNode;
  onClose: () => void;
  onDeleted: (recoveryNodeId: string | null) => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const requestInFlight = useRef(false);
  const restoreFocus = useRef(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    const returnFocusTarget = returnFocusRef.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
    }
    const focusFrame = requestAnimationFrame(() => cancelRef.current?.focus());
    return () => {
      cancelAnimationFrame(focusFrame);
      if (restoreFocus.current) {
        requestAnimationFrame(() => returnFocusTarget?.focus());
      }
    };
  }, [returnFocusRef]);

  useEffect(() => {
    if (pending || !error) {
      return;
    }
    const focusFrame = requestAnimationFrame(() => deleteButtonRef.current?.focus());
    return () => cancelAnimationFrame(focusFrame);
  }, [error, pending]);

  function close() {
    if (!requestInFlight.current) {
      dialogRef.current?.close();
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (requestInFlight.current) {
      return;
    }
    requestInFlight.current = true;
    setPending(true);
    setError(null);
    const pendingFocusFrame = requestAnimationFrame(() => statusRef.current?.focus());
    try {
      const result = await deleteNode({ id: node.id });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      restoreFocus.current = false;
      dialogRef.current?.close();
      onDeleted(result.recoveryNodeId ?? null);
    } catch {
      setError(
        "MindTree couldn’t confirm the deletion. The tree was refreshed; check whether the thought still exists before trying again.",
      );
      router.refresh();
    } finally {
      cancelAnimationFrame(pendingFocusFrame);
      requestInFlight.current = false;
      setPending(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="node-dialog node-dialog--confirm"
      aria-labelledby="delete-node-title"
      aria-describedby="delete-node-description"
      aria-busy={pending}
      onCancel={(event) => {
        if (requestInFlight.current) {
          event.preventDefault();
        }
      }}
      onClick={(event) => {
        if (isDialogBackdropClick(event)) close();
      }}
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <div className="dialog-heading">
          <div>
            <p className="pane-eyebrow">Delete subtree</p>
            <h2 id="delete-node-title">Permanently delete {node.title}?</h2>
          </div>
          <button
            className="dialog-close icon-button"
            type="button"
            aria-label="Close delete dialog"
            data-tooltip="Close"
            disabled={pending}
            onClick={close}
          >
            <CloseIcon />
          </button>
        </div>
        <p id="delete-node-description" className="dialog-copy">
          This permanently deletes this thought, every descendant, and all of their
          conversations, proposals, synthesis history, citations, and embeddings. This cannot be
          undone. Archive instead if you may need this knowledge later.
        </p>
        <div className="dialog-actions">
          <button
            ref={deleteButtonRef}
            className="button button--danger"
            type="submit"
            disabled={pending}
          >
            {pending ? "Deleting…" : "Delete permanently"}
          </button>
          <button
            ref={cancelRef}
            className="button button--quiet"
            type="button"
            disabled={pending}
            onClick={close}
          >
            Cancel
          </button>
        </div>
        <p
          ref={statusRef}
          className="dialog-status"
          role="status"
          aria-live="polite"
          tabIndex={-1}
        >
          {pending ? `Deleting ${node.title}…` : ""}
        </p>
        {error ? <p role="alert" className="dialog-error">{error}</p> : null}
      </form>
    </dialog>
  );
}
