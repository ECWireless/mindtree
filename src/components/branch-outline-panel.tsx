"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { BranchMapIcon } from "@/components/branch-map-icon";
import { BranchOutlineDocumentContent } from "@/components/chat-message-content";
import type {
  BranchOutlineStreamEvent,
  BranchOutlineVersion,
  BranchOutlineWorkspace,
} from "@/lib/branch-outlines/contracts";

function failureMessage(
  generation: BranchOutlineVersion | null,
  hasCurrentOutline: boolean,
) {
  if (generation?.failureCode === "inputs-changed") {
    return "This branch changed during generation. Try again with its latest content.";
  }
  if (generation?.failureCode === "provider-refusal") {
    return "The Branch Outline could not be generated from this content.";
  }
  if (
    generation?.failureCode === "provider-timeout" ||
    generation?.failureCode === "stream-disconnected"
  ) {
    return hasCurrentOutline
      ? "Generation was interrupted. Your previous Branch Outline is unchanged."
      : "Generation was interrupted. Please try again.";
  }
  return "MindTree couldn’t generate the Branch Outline. Please try again.";
}

export function BranchOutlinePanel({
  nodeId,
  initialWorkspace,
  generationEnabled,
}: {
  nodeId: string;
  initialWorkspace: BranchOutlineWorkspace;
  generationEnabled: boolean;
}) {
  const router = useRouter();
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const [requestPending, setRequestPending] = useState(false);
  const [streamedContent, setStreamedContent] = useState("");
  const [requestError, setRequestError] = useState<string | null>(null);
  const pendingId = workspace.pending?.id ?? null;

  useEffect(() => {
    if (!pendingId || requestPending) return;
    let active = true;
    const reconcile = async () => {
      try {
        const response = await fetch(
          `/api/branch-outline?nodeId=${encodeURIComponent(nodeId)}`,
          { cache: "no-store" },
        );
        if (!response.ok) return;
        const next = await response.json() as BranchOutlineWorkspace;
        if (active) setWorkspace(next);
      } catch {
        // A later poll can reconcile transient request failures.
      }
    };
    void reconcile();
    const interval = window.setInterval(() => void reconcile(), 2_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [nodeId, pendingId, requestPending]);

  const generating = requestPending || workspace.pending !== null;
  const actionLabel = workspace.current ? "Regenerate" : "Generate";
  const visibleFailure = requestError ?? (
    workspace.latestFailure
      ? failureMessage(workspace.latestFailure, workspace.current !== null)
      : null
  );

  async function generate() {
    if (generating || !generationEnabled) return;
    const hadCurrentOutline = workspace.current !== null;
    setRequestPending(true);
    setRequestError(null);
    setStreamedContent("");
    let terminalSeen = false;
    try {
      const response = await fetch("/api/branch-outline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodeId, clientRequestId: crypto.randomUUID() }),
      });
      if (!response.ok || !response.body) {
        const body = await response.json().catch(() => null) as { message?: string } | null;
        throw new Error(body?.message || "The Branch Outline could not be started.");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      while (true) {
        const { done, value } = await reader.read();
        buffered += decoder.decode(value, { stream: !done });
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          if (!line) continue;
          const event = JSON.parse(line) as BranchOutlineStreamEvent;
          if (event.type === "generation") {
            setWorkspace((current) => ({ ...current, pending: event.generation }));
          } else if (event.type === "delta") {
            setStreamedContent((current) => current + event.content);
          } else if (event.type === "completed") {
            terminalSeen = true;
            setWorkspace((current) => event.installed
              ? {
                  current: event.generation,
                  pending: null,
                  latestFailure: null,
                  staleAt: null,
                  staleReason: null,
                }
              : { ...current, pending: null });
            setStreamedContent("");
            if (!event.installed) router.refresh();
          } else if (event.type === "failed") {
            terminalSeen = true;
            setWorkspace((current) => ({
              ...current,
              pending: null,
              latestFailure: event.generation,
            }));
            setRequestError(failureMessage(event.generation, hadCurrentOutline));
            setStreamedContent("");
          }
        }
        if (done) break;
      }
      if (!terminalSeen) throw new Error("Generation ended before the outline was ready.");
    } catch (error) {
      setRequestError(
        error instanceof Error
          ? error.message
          : "MindTree couldn’t generate the Branch Outline.",
      );
      setWorkspace((current) => ({ ...current, pending: null }));
      setStreamedContent("");
    } finally {
      setRequestPending(false);
    }
  }

  return (
    <section
      className={`branch-outline${workspace.staleAt ? " branch-outline--stale" : ""}`}
      aria-labelledby={`branch-outline-${nodeId}`}
    >
      <div className="branch-outline__heading">
        <div className="branch-outline__identity">
          <span className="branch-outline__mark">
            <BranchMapIcon />
          </span>
          <div>
            <h2 id={`branch-outline-${nodeId}`}>Branch Outline</h2>
            {workspace.staleAt ? (
              <p className="branch-outline__state">Stale · the branch has changed</p>
            ) : null}
          </div>
        </div>
        <button
          className="button button--quiet branch-outline__action"
          type="button"
          disabled={generating || !generationEnabled}
          onClick={() => void generate()}
        >
          {generating ? "Generating…" : actionLabel}
        </button>
      </div>

      <div className="branch-outline__canvas">
        {workspace.current ? (
          <div
            key={workspace.current.id}
            className="branch-outline__content branch-outline__content--current synthesis-document__content"
          >
            <BranchOutlineDocumentContent content={workspace.current.content} />
          </div>
        ) : (
          <div className="branch-outline__empty-state">
            <span className="branch-outline__empty-node" aria-hidden="true" />
            <p className="branch-outline__empty">
              No Branch Outline yet. Generate one from this Summary and its direct children.
            </p>
          </div>
        )}

        {streamedContent ? (
          <div
            className="branch-outline__preview branch-outline__content synthesis-document__content"
            aria-label="Generating Branch Outline preview"
          >
            <BranchOutlineDocumentContent content={streamedContent} />
          </div>
        ) : null}
        {generating ? (
          <p className="branch-outline__busy" role="status">Generating Branch Outline…</p>
        ) : null}
        {visibleFailure ? (
          <p className="branch-outline__error" role="alert">{visibleFailure}</p>
        ) : null}
        {!generationEnabled ? (
          <p className="branch-outline__empty">
            Branch Outline generation is unavailable right now.
          </p>
        ) : null}
      </div>
    </section>
  );
}
