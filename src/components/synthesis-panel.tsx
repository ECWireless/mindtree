"use client";

import { useMemo, useState, type Ref } from "react";
import { useRouter } from "next/navigation";

import {
  approveSynthesisProposal,
  rejectSynthesisProposal,
} from "@/app/actions/synthesis";
import { SynthesisDocumentContent } from "@/components/chat-message-content";
import { createSynthesisDiff } from "@/lib/synthesis/diff";
import type {
  SynthesisDecisionSummary,
  SynthesisVersion,
  SynthesisWorkspace,
} from "@/lib/synthesis/contracts";

function formatDecisionTime(value: string) {
  return `${new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value))} UTC`;
}

export function synthesisStatusLabel(status: SynthesisDecisionSummary["status"]) {
  if (status === "approved") return "Proposal approved";
  if (status === "rejected") return "Proposal rejected";
  return "Proposal superseded";
}

export function PublishedSynthesisArtifact({
  synthesis,
  staleAt,
  headingRef,
}: {
  synthesis: SynthesisVersion;
  staleAt: string | null;
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  const titleId = `published-synthesis-${synthesis.id}`;
  return (
    <section className="synthesis-published" aria-labelledby={titleId}>
      <h2 id={titleId} ref={headingRef} tabIndex={-1}>Summary</h2>
      {staleAt ? (
        <div className="synthesis-published__stale" role="status">
          <p className="synthesis-published__stale-label">Update available</p>
          <p>
            This Summary may no longer reflect the current branch. Open Chat to request a refreshed Summary.
          </p>
        </div>
      ) : null}
      <div className="synthesis-document__content">
        <SynthesisDocumentContent content={synthesis.content} />
      </div>
    </section>
  );
}

function SynthesisDiff({
  id,
  baseContent,
  proposalContent,
}: {
  id: string;
  baseContent: string | null;
  proposalContent: string;
}) {
  const diff = useMemo(
    () => createSynthesisDiff(baseContent, proposalContent),
    [baseContent, proposalContent],
  );
  const diffTitleId = `synthesis-diff-${id}`;
  return (
    <div className="synthesis-diff" aria-labelledby={diffTitleId}>
      <div className="synthesis-diff__heading">
        <h4 id={diffTitleId}>
          {baseContent === null ? "First proposal" : "Changes from published synthesis"}
        </h4>
        <p>+ Added · − Removed · = Unchanged</p>
      </div>
      {diff.limited ? (
        <p className="synthesis-diff__notice">
          Detailed comparison was simplified to keep this long revision responsive.
        </p>
      ) : null}
      <ol className="synthesis-diff__parts">
        {diff.parts.map((part, index) => {
          const label = part.kind === "added"
            ? "Added"
            : part.kind === "removed"
              ? "Removed"
              : "Unchanged";
          const marker = part.kind === "added" ? "+" : part.kind === "removed" ? "−" : "=";
          return (
            <li
              className={`synthesis-diff__part synthesis-diff__part--${part.kind}`}
              key={`${part.kind}-${index}`}
            >
              <span className="synthesis-diff__marker" aria-hidden="true">{marker}</span>
              <span className="sr-only">{label}: </span>
              <pre>{part.content}</pre>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function SynthesisProposalArtifact({
  nodeId,
  published,
  proposal,
  generationBusy,
  headingRef,
  onDecisionSettled,
}: {
  nodeId: string;
  published: SynthesisVersion | null;
  proposal: SynthesisVersion;
  generationBusy: boolean;
  headingRef?: Ref<HTMLHeadingElement>;
  onDecisionSettled: (decision: "approve" | "reject") => void;
}) {
  const router = useRouter();
  const [decisionPending, setDecisionPending] = useState<"approve" | "reject" | null>(null);
  const [decisionError, setDecisionError] = useState("");
  const titleId = `pending-synthesis-${proposal.id}`;

  async function decide(decision: "approve" | "reject") {
    if (decisionPending || generationBusy) return;
    setDecisionPending(decision);
    setDecisionError("");
    try {
      const result = await (decision === "approve"
        ? approveSynthesisProposal
        : rejectSynthesisProposal)({ nodeId, proposalId: proposal.id });
      if (!result.ok) {
        setDecisionError(result.message);
        setDecisionPending(null);
        router.refresh();
        return;
      }
      onDecisionSettled(decision);
      router.refresh();
    } catch {
      setDecisionError("MindTree couldn’t save that synthesis decision. Please try again.");
      setDecisionPending(null);
      router.refresh();
    }
  }

  return (
    <section className="synthesis-proposal" aria-labelledby={titleId}>
      <div className="synthesis-proposal__heading">
        <div>
          <p className="synthesis-proposal__state">Pending proposal</p>
          <h3 id={titleId} ref={headingRef} tabIndex={-1}>Proposed synthesis</h3>
        </div>
      </div>
      <div className="synthesis-document__content">
        <SynthesisDocumentContent content={proposal.content} />
      </div>
      <SynthesisDiff
        id={proposal.id}
        baseContent={published?.content ?? null}
        proposalContent={proposal.content}
      />

      <p className="synthesis-proposal__refine-hint">
        To refine this proposal, describe the changes in your next message.
      </p>
      {generationBusy ? (
        <p className="synthesis-proposal__busy" role="status">
          Finish or stop the current assistant response before deciding this proposal.
        </p>
      ) : null}
      <div className="synthesis-proposal__actions" aria-label="Proposal decision">
        <button
          className="button button--primary"
          type="button"
          disabled={decisionPending !== null || generationBusy}
          onClick={() => void decide("approve")}
        >
          {decisionPending === "approve" ? "Approving…" : "Approve and publish"}
        </button>
        <button
          className="button button--quiet"
          type="button"
          disabled={decisionPending !== null || generationBusy}
          onClick={() => void decide("reject")}
        >
          {decisionPending === "reject" ? "Rejecting…" : "Reject proposal"}
        </button>
      </div>
      {decisionError ? <p className="synthesis-panel__error" role="alert">{decisionError}</p> : null}
    </section>
  );
}

export function SynthesisDecidedArtifact({
  decision,
}: {
  decision: SynthesisDecisionSummary;
}) {
  const [open, setOpen] = useState(false);
  const titleId = `decided-synthesis-${decision.id}`;
  return (
    <details
      className="synthesis-proposal synthesis-proposal--decided"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        {synthesisStatusLabel(decision.status)} · {formatDecisionTime(decision.decidedAt)}
      </summary>
      {open ? (
        <section aria-labelledby={titleId}>
          <h3 id={titleId}>Proposed synthesis</h3>
          <div className="synthesis-document__content">
            <SynthesisDocumentContent content={decision.content} />
          </div>
          <SynthesisDiff
            id={decision.id}
            baseContent={decision.baseContent}
            proposalContent={decision.content}
          />
        </section>
      ) : null}
    </details>
  );
}

export function SynthesisDecisionHistory({ history }: Pick<SynthesisWorkspace, "history">) {
  if (history.length === 0) return null;
  return (
    <details className="synthesis-history">
      <summary>Recent synthesis decisions ({history.length})</summary>
      <ol className="synthesis-history__list">
        {history.map((decision) => (
          <li key={decision.id}>
            <SynthesisDecidedArtifact decision={decision} />
          </li>
        ))}
      </ol>
    </details>
  );
}
