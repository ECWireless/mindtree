"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

import {
  createBranchShareLink,
  recoverBranchShareLink,
  revokeBranchShareLink,
} from "@/app/actions/sharing";
import type { BranchShareLinkState } from "@/lib/sharing/contracts";
import { isDialogBackdropClick } from "@/lib/ui/dialog";

type ShareThoughtTrailProps = {
  archived: boolean;
  initialLink: BranchShareLinkState | null;
  nodeId: string;
  nodeTitle: string;
  onClose: () => void;
  open: boolean;
  recoveryEnabled: boolean;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
};

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

function publicTrailUrl(secret: string, nodeId: string) {
  const url = new URL(`/share/${secret}`, window.location.origin);
  url.searchParams.set("node", nodeId);
  return url.toString();
}

async function writeToClipboard(value: string) {
  if (!navigator.clipboard?.writeText) return false;
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

export function ShareThoughtTrail({
  archived,
  initialLink,
  nodeId,
  nodeTitle,
  onClose,
  open,
  recoveryEnabled,
  returnFocusRef,
}: ShareThoughtTrailProps) {
  const [link, setLink] = useState(initialLink);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [pending, setPending] = useState<"create" | "recover" | "revoke" | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [recoveryAttempt, setRecoveryAttempt] = useState(0);
  const focusTarget = useRef<"create" | "url" | null>(null);
  const recoveryAttemptedForLink = useRef<string | null>(null);
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocusTarget = useRef<HTMLButtonElement | null>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open) {
      returnFocusTarget.current = returnFocusRef.current;
      if (!dialog.open) dialog.showModal();
      const focusFrame = requestAnimationFrame(() => closeButtonRef.current?.focus());
      return () => cancelAnimationFrame(focusFrame);
    }

    if (dialog.open) dialog.close();
  }, [open, returnFocusRef]);

  useEffect(() => {
    if (
      !open ||
      !recoveryEnabled ||
      !link?.recoverable ||
      shareUrl ||
      pending !== null ||
      recoveryAttemptedForLink.current === link.id
    ) {
      return;
    }
    recoveryAttemptedForLink.current = link.id;
    const recoverActiveLink = async () => {
      setPending("recover");
      setMessage("");
      setError("");
      try {
        const result = await recoverBranchShareLink({ nodeId });
        if (!result.ok) {
          setError(result.message);
          return;
        }
        setLink(result.link);
        setShareUrl(publicTrailUrl(result.secret, nodeId));
      } catch {
        setError("MindTree couldn’t retrieve the active share link. Please try again.");
      } finally {
        setPending(null);
      }
    };
    void recoverActiveLink();
  }, [link, nodeId, open, pending, recoveryAttempt, recoveryEnabled, shareUrl]);

  useEffect(() => {
    if (pending !== null || focusTarget.current === null) return;
    if (focusTarget.current === "url") {
      urlInputRef.current?.focus();
      urlInputRef.current?.select();
    } else {
      createButtonRef.current?.focus();
    }
    focusTarget.current = null;
  }, [pending]);

  async function copy(url: string) {
    const copied = await writeToClipboard(url);
    setMessage(copied
      ? "Share link copied."
      : "Copy was unavailable. Select and copy the link below.");
  }

  async function share(url: string) {
    setMessage("");
    if (!navigator.share) {
      await copy(url);
      return;
    }
    try {
      await navigator.share({
        title: `${nodeTitle} · MindTree`,
        text: `Read-only thought trail: ${nodeTitle}`,
        url,
      });
      setMessage("Shared.");
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      await copy(url);
    }
  }

  async function create() {
    if (pending || archived || !recoveryEnabled) return;
    setPending("create");
    setMessage("");
    setError("");
    try {
      const result = await createBranchShareLink({ nodeId });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      const url = publicTrailUrl(result.secret, nodeId);
      setLink(result.link);
      setShareUrl(url);
      focusTarget.current = "url";
      await copy(url);
    } catch {
      setError(
        "MindTree couldn’t confirm whether the share link was created. Refresh before trying again.",
      );
    } finally {
      setPending(null);
    }
  }

  async function revoke() {
    if (pending || !link) return;
    setPending("revoke");
    setMessage("");
    setError("");
    try {
      const result = await revokeBranchShareLink({ nodeId });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setLink(null);
      setShareUrl(null);
      recoveryAttemptedForLink.current = null;
      focusTarget.current = "create";
      setMessage(result.revoked ? "Share link revoked." : "The share link was already revoked.");
    } catch {
      setError(
        "MindTree couldn’t confirm whether the share link was revoked. Refresh before trying again.",
      );
    } finally {
      setPending(null);
    }
  }

  function close() {
    if (pending === null || pending === "recover") dialogRef.current?.close();
  }

  function retryRecovery() {
    if (!link || pending !== null) return;
    recoveryAttemptedForLink.current = null;
    setRecoveryAttempt((current) => current + 1);
  }

  function closed() {
    recoveryAttemptedForLink.current = null;
    onClose();
    requestAnimationFrame(() => returnFocusTarget.current?.focus());
  }

  return (
    <dialog
      ref={dialogRef}
      id={`share-trail-dialog-${nodeId}`}
      className="node-dialog share-trail-dialog"
      aria-labelledby={`share-trail-${nodeId}`}
      aria-describedby={`share-trail-description-${nodeId}`}
      aria-busy={pending !== null}
      onCancel={(event) => {
        if (pending !== null && pending !== "recover") event.preventDefault();
      }}
      onClick={(event) => {
        if (isDialogBackdropClick(event)) close();
      }}
      onClose={closed}
    >
      <section className="share-trail">
        <div className="dialog-heading share-trail__heading">
          <div>
            <p className="pane-eyebrow">Read-only sharing</p>
            <h2 id={`share-trail-${nodeId}`}>Share this thought trail</h2>
          </div>
          <button
            ref={closeButtonRef}
            className="dialog-close icon-button"
            type="button"
            aria-label="Close sharing dialog"
            data-tooltip="Close"
            disabled={pending !== null && pending !== "recover"}
            onClick={close}
          >
            <CloseIcon />
          </button>
        </div>

        {link ? (
          <>
            <p id={`share-trail-description-${nodeId}`}>
              {archived
                ? `${nodeTitle} is archived, so its share link is unavailable until it is unarchived.`
                : `Anyone with the link can read ${nodeTitle} and its current active descendants.`}
            </p>
            {shareUrl ? (
              <div className="share-trail__link">
                <label htmlFor={`share-trail-url-${nodeId}`}>Share link</label>
                <input
                  ref={urlInputRef}
                  id={`share-trail-url-${nodeId}`}
                  type="url"
                  value={shareUrl}
                  readOnly
                  autoComplete="off"
                  spellCheck={false}
                  onFocus={(event) => event.currentTarget.select()}
                />
                <button
                  className="button button--quiet"
                  type="button"
                  disabled={pending !== null}
                  onClick={() => void copy(shareUrl)}
                >
                  Copy link
                </button>
                <button
                  className="button button--quiet"
                  type="button"
                  disabled={pending !== null}
                  onClick={() => void share(shareUrl)}
                >
                  Share…
                </button>
                <p className="share-trail__message" role="status" aria-live="polite">
                  {message}
                </p>
              </div>
            ) : link.recoverable && recoveryEnabled ? (
              <div className="share-trail__recovery">
                <p className="share-trail__note" role="status">
                  {error
                    ? "The active link is not available to copy right now."
                    : "Loading the active share link…"}
                </p>
                {error && pending === null ? (
                  <button
                    className="button button--quiet"
                    type="button"
                    onClick={retryRecovery}
                  >
                    Retry
                  </button>
                ) : null}
              </div>
            ) : link.recoverable ? (
              <p className="share-trail__note">
                Configure SHARE_LINK_ENCRYPTION_KEY to retrieve this active link.
              </p>
            ) : (
              <p className="share-trail__note">
                This older link remains active but cannot be displayed again. Revoke it and create a new persistent link to replace it.
              </p>
            )}
            <button
              className="button button--danger share-trail__revoke"
              type="button"
              disabled={pending !== null}
              onClick={() => void revoke()}
            >
              {pending === "revoke" ? "Revoking…" : "Revoke link"}
            </button>
          </>
        ) : (
          <>
            <p id={`share-trail-description-${nodeId}`}>
              Create an unguessable link to this thought and its current active descendants. Chat and editing controls stay private.
            </p>
            <button
              ref={createButtonRef}
              className="button button--quiet"
              type="button"
              disabled={pending !== null || archived || !recoveryEnabled}
              onClick={() => void create()}
            >
              {pending === "create" ? "Creating…" : "Create and copy link"}
            </button>
            {archived ? (
              <p className="share-trail__note">Unarchive this thought before sharing its trail.</p>
            ) : !recoveryEnabled ? (
              <p className="share-trail__note">
                Configure SHARE_LINK_ENCRYPTION_KEY before creating a persistent link.
              </p>
            ) : null}
          </>
        )}

        {!shareUrl ? (
          <p className="share-trail__message" role="status" aria-live="polite">{message}</p>
        ) : null}
        {error ? <p className="share-trail__error" role="alert">{error}</p> : null}
      </section>
    </dialog>
  );
}
