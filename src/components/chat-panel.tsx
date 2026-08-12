"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { useRouter } from "next/navigation";

import { loadChatMessages, loadChatTurn } from "@/app/actions/chat";
import { ChatMessageContent } from "@/components/chat-message-content";
import {
  SynthesisDecidedArtifact,
  SynthesisDecisionHistory,
  SynthesisProposalArtifact,
} from "@/components/synthesis-panel";
import {
  MAX_USER_MESSAGE_LENGTH,
  type ChatMessage,
  type ChatMessagePage,
  type ChatStreamEvent,
} from "@/lib/chat/contracts";
import {
  WEB_RESEARCH_PROGRESS_MESSAGE,
  chatFailureMessage,
} from "@/lib/chat/presentation";
import type { SynthesisDecisionSummary, SynthesisWorkspace } from "@/lib/synthesis/contracts";

type ChatPanelProps = {
  nodeId: string;
  nodeTitle: string;
  initialPage: ChatMessagePage;
  synthesisWorkspace: SynthesisWorkspace;
  generationEnabled: boolean;
  open: boolean;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onApprovalSettled: () => void;
};

function CloseIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  );
}

function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]) {
  const orderedIds = [...current, ...incoming].map((message) => message.id);
  const byId = new Map([...current, ...incoming].map((message) => [message.id, message]));
  return [...new Set(orderedIds)].map((id) => byId.get(id)!);
}

function replaceMessage(current: ChatMessage[], next: ChatMessage) {
  return current.map((message) => (message.id === next.id ? next : message));
}

function replaceTurn(current: ChatMessage[], clientMessageId: string, next: ChatMessage[]) {
  const replaced: ChatMessage[] = [];
  let inserted = false;
  for (const message of current) {
    if (message.clientMessageId === clientMessageId) {
      if (!inserted) replaced.push(...next);
      inserted = true;
    } else {
      replaced.push(message);
    }
  }
  if (!inserted) replaced.push(...next);
  return replaced;
}

function createOptimisticTurn(
  nodeId: string,
  clientMessageId: string,
  content: string,
  webSearchAuthorized: boolean,
) {
  const createdAt = new Date().toISOString();
  const base = {
    nodeId,
    clientMessageId,
    model: null,
    providerResponseId: null,
    failureCode: null,
    webSearchAuthorized: false,
    createdAt,
    updatedAt: createdAt,
    completedAt: null,
  };
  return [
    {
      ...base,
      id: `local-user-${clientMessageId}`,
      role: "user",
      status: "completed",
      content,
      webSearchAuthorized,
      proposalRequested: false,
      refinementProposalId: null,
      completedAt: createdAt,
    },
    {
      ...base,
      id: `local-assistant-${clientMessageId}`,
      role: "assistant",
      status: "pending",
      content: "",
      proposalRequested: false,
      refinementProposalId: null,
    },
  ] satisfies ChatMessage[];
}

export function ChatPanel({
  nodeId,
  nodeTitle,
  initialPage,
  synthesisWorkspace,
  generationEnabled,
  open,
  returnFocusRef,
  onClose,
  onApprovalSettled,
}: ChatPanelProps) {
  const router = useRouter();
  const composerHelpId = `chat-composer-help-${nodeId}`;
  const webDisclosureId = `chat-web-disclosure-${nodeId}`;
  const [messages, setMessages] = useState(initialPage.messages);
  const [cursor, setCursor] = useState(initialPage.nextCursor);
  const [draft, setDraft] = useState("");
  const [useWebSources, setUseWebSources] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [activeClientMessageId, setActiveClientMessageId] = useState<string | null>(null);
  const [researchingClientMessageId, setResearchingClientMessageId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [loadedDecisions, setLoadedDecisions] = useState<SynthesisDecisionSummary[]>([]);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const restoreFocusOnClose = useRef(true);
  const pendingProposalFocusOnOpen = useRef(false);
  const abortController = useRef<AbortController | null>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const proposalHeadingRef = useRef<HTMLHeadingElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const followNewest = useRef(true);
  const paginationHeight = useRef<number | null>(null);
  const previousPendingProposalId = useRef(synthesisWorkspace.pending?.id ?? null);
  const decisionFocus = useRef<"approve" | "reject" | null>(null);
  const unacknowledgedTurns = useRef(new Map<
    string,
    { content: string; webSearchAuthorized: boolean }
  >());

  useEffect(() => () => abortController.current?.abort(), []);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      restoreFocusOnClose.current = true;
      dialog.showModal();
      const frame = requestAnimationFrame(() => {
        const history = historyRef.current;
        if (history && followNewest.current) history.scrollTop = history.scrollHeight;
        if (pendingProposalFocusOnOpen.current) {
          pendingProposalFocusOnOpen.current = false;
          proposalHeadingRef.current?.focus();
        } else {
          draftRef.current?.focus();
        }
      });
      return () => cancelAnimationFrame(frame);
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);
  useLayoutEffect(() => {
    const history = historyRef.current;
    if (!history) return;
    if (paginationHeight.current !== null) {
      history.scrollTop += history.scrollHeight - paginationHeight.current;
      paginationHeight.current = null;
    } else if (followNewest.current) {
      history.scrollTop = history.scrollHeight;
    }
  }, [messages]);
  useLayoutEffect(() => {
    const textarea = draftRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
  }, [draft]);
  useEffect(() => {
    const nextPendingId = synthesisWorkspace.pending?.id ?? null;
    const previousPendingId = previousPendingProposalId.current;
    previousPendingProposalId.current = nextPendingId;
    if (nextPendingId && nextPendingId !== previousPendingId) {
      if (!open) {
        pendingProposalFocusOnOpen.current = true;
        return;
      }
      const frame = requestAnimationFrame(() => proposalHeadingRef.current?.focus());
      return () => cancelAnimationFrame(frame);
    }
    if (previousPendingId && !nextPendingId) {
      const target = decisionFocus.current;
      decisionFocus.current = null;
      const frame = requestAnimationFrame(() => {
        if (target !== "approve") draftRef.current?.focus();
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [open, synthesisWorkspace.pending?.id, synthesisWorkspace.published?.id]);

  async function loadOlder() {
    if (!cursor || loadingOlder) return;
    const history = historyRef.current;
    paginationHeight.current = history?.scrollHeight ?? null;
    setLoadingOlder(true);
    setLoadError("");
    try {
      const result = await loadChatMessages({ nodeId, cursor });
      if (result.ok) {
        setMessages((current) => mergeMessages(result.page.messages, current));
        setLoadedDecisions((current) => [...new Map(
          [...current, ...result.decisions].map((decision) => [decision.id, decision]),
        ).values()]);
        setCursor(result.page.nextCursor);
      } else {
        paginationHeight.current = null;
        setLoadError(result.message);
      }
    } catch {
      paginationHeight.current = null;
      setLoadError("Older messages could not be loaded.");
    } finally {
      setLoadingOlder(false);
    }
  }

  async function reconcileTurn(clientMessageId: string) {
    try {
      const result = await loadChatTurn({ nodeId, clientMessageId });
      if (!result.ok) return null;
      const turn = result.messages;
      if (turn.length === 0) return null;
      setMessages((current) => replaceTurn(current, clientMessageId, turn));
      unacknowledgedTurns.current.delete(clientMessageId);
      return {
        assistant: turn.find((message) => message.role === "assistant") ?? null,
        webSearchAuthorized:
          turn.find((message) => message.role === "user")?.webSearchAuthorized === true,
        proposalCreated:
          turn.find((message) => message.role === "user")?.proposalRequested ?? false,
      };
    } catch {
      return null;
    }
  }

  async function streamTurn(payload: Record<string, unknown>) {
    const controller = new AbortController();
    abortController.current = controller;
    const clientMessageId = String(payload.clientMessageId);
    let webSearchAuthorized = payload.webSearchAuthorized === true;
    setActiveClientMessageId(clientMessageId);
    setAnnouncement("Assistant response started.");
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error("unavailable");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let assistantId = "";
      let terminalReceived = false;
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line) continue;
          const streamEvent = JSON.parse(line) as ChatStreamEvent;
          if (streamEvent.type === "turn") {
            assistantId = streamEvent.assistantMessage.id;
            webSearchAuthorized = streamEvent.userMessage.webSearchAuthorized;
            unacknowledgedTurns.current.delete(clientMessageId);
            setMessages((current) => replaceTurn(current, clientMessageId, [streamEvent.userMessage, streamEvent.assistantMessage]));
          } else if (streamEvent.type === "delta") {
            setMessages((current) => current.map((message) =>
              message.id === assistantId
                ? { ...message, content: `${message.content}${streamEvent.content}`, status: "streaming" }
                : message,
            ));
          } else if (streamEvent.type === "research-status") {
            setResearchingClientMessageId(clientMessageId);
            setAnnouncement(WEB_RESEARCH_PROGRESS_MESSAGE);
          } else {
            terminalReceived = true;
            setMessages((current) => replaceMessage(current, streamEvent.assistantMessage));
            setAnnouncement(
              streamEvent.type === "completed"
                ? streamEvent.proposalCreated
                  ? "Synthesis proposal request completed."
                  : "Assistant response completed."
                : streamEvent.type === "cancelled"
                  ? "Assistant response stopped."
                  : chatFailureMessage({
                      failureCode: streamEvent.assistantMessage.failureCode,
                      webSearchAuthorized,
                    }),
            );
            if (streamEvent.type === "completed" && streamEvent.proposalCreated) {
              router.refresh();
            }
          }
        }
        if (done) break;
      }
      if (!terminalReceived) throw new Error("stream ended before a terminal event");
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        setAnnouncement("Assistant response stopped.");
        setMessages((current) => current.map((message) =>
          message.clientMessageId === clientMessageId && message.role === "assistant"
            ? { ...message, status: "cancelled" }
            : message,
        ));
      } else {
        setAnnouncement("Assistant response could not be completed.");
        const reconciled = await reconcileTurn(clientMessageId);
        if (reconciled?.assistant?.status === "completed") {
          setAnnouncement(reconciled.proposalCreated
            ? "Synthesis proposal request completed."
            : "Assistant response completed.");
          if (reconciled.proposalCreated) router.refresh();
        }
        if (reconciled?.assistant?.status === "failed") {
          setAnnouncement(chatFailureMessage({
            failureCode: reconciled.assistant.failureCode,
            webSearchAuthorized: reconciled.webSearchAuthorized,
          }));
        }
        if (reconciled?.assistant?.status === "cancelled") setAnnouncement("Assistant response stopped.");
        if (!reconciled) {
          setAnnouncement(chatFailureMessage({
            failureCode: "stream-disconnected",
            webSearchAuthorized,
          }));
          setMessages((current) => current.map((message) =>
            message.clientMessageId === clientMessageId && message.role === "assistant"
              ? { ...message, status: "failed", failureCode: "stream-disconnected" }
              : message,
          ));
        }
      }
    } finally {
      abortController.current = null;
      setActiveClientMessageId(null);
      setResearchingClientMessageId(null);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || activeClientMessageId || !generationEnabled) return;
    const clientMessageId = crypto.randomUUID();
    const webSearchAuthorized = useWebSources;
    unacknowledgedTurns.current.set(clientMessageId, { content, webSearchAuthorized });
    setMessages((current) => mergeMessages(
      current,
      createOptimisticTurn(nodeId, clientMessageId, content, webSearchAuthorized),
    ));
    setDraft("");
    setUseWebSources(false);
    void streamTurn({
      nodeId,
      clientMessageId,
      content,
      webSearchAuthorized,
    });
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.nativeEvent.isComposing
    ) {
      return;
    }
    event.preventDefault();
    if (!draft.trim() || activeClientMessageId || !generationEnabled) return;
    event.currentTarget.form?.requestSubmit();
  }

  function retry(message: ChatMessage) {
    if (activeClientMessageId || !generationEnabled) return;
    const unacknowledged = unacknowledgedTurns.current.get(message.clientMessageId);
    void streamTurn(unacknowledged
      ? {
          nodeId,
          clientMessageId: message.clientMessageId,
          content: unacknowledged.content,
          webSearchAuthorized: unacknowledged.webSearchAuthorized,
        }
      : { nodeId, clientMessageId: message.clientMessageId, retry: true });
  }

  async function stop(clientMessageId = activeClientMessageId) {
    if (!clientMessageId) return;
    if (clientMessageId === activeClientMessageId) abortController.current?.abort();
    try {
      const response = await fetch("/api/chat", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodeId, clientMessageId }),
      });
      if (!response.ok) throw new Error("stop failed");
      const result = await response.json() as { assistantMessage: ChatMessage };
      setMessages((current) => replaceMessage(current, result.assistantMessage));
      setAnnouncement("Assistant response stopped.");
    } catch {
      await reconcileTurn(clientMessageId);
    }
  }

  const pendingMessageId = synthesisWorkspace.pending?.generatingMessageId ?? null;
  const pendingAppearsInHistory = pendingMessageId !== null && messages.some(
    (message) => message.role === "assistant" && message.id === pendingMessageId,
  );
  const allDecisions = [...new Map(
    [...synthesisWorkspace.history, ...loadedDecisions]
      .map((decision) => [decision.id, decision]),
  ).values()];
  const decisionsByMessageId = new Map(
    allDecisions.map((decision) => [decision.generatingMessageId, decision]),
  );
  const visibleAssistantMessageIds = new Set(
    messages
      .filter((message) => message.role === "assistant")
      .map((message) => message.id),
  );
  const webSearchClientMessageIds = new Set(
    messages
      .filter((message) => message.role === "user" && message.webSearchAuthorized)
      .map((message) => message.clientMessageId),
  );
  const decisionsOutsidePage = allDecisions.filter(
    (decision) => !visibleAssistantMessageIds.has(decision.generatingMessageId),
  );

  function decisionSettled(decision: "approve" | "reject") {
    decisionFocus.current = decision;
    setAnnouncement(
      decision === "approve"
        ? "Proposal approved and published."
        : "Proposal rejected. The published synthesis is unchanged.",
    );
    if (decision === "approve") {
      restoreFocusOnClose.current = false;
      onApprovalSettled();
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="node-dialog chat-dialog"
      aria-labelledby={`chat-dialog-title-${nodeId}`}
      onCancel={() => {
        restoreFocusOnClose.current = true;
      }}
      onClose={() => {
        onClose();
        if (restoreFocusOnClose.current) {
          requestAnimationFrame(() => returnFocusRef.current?.focus());
        }
      }}
    >
      <div className="dialog-heading">
        <div>
          <p className="pane-eyebrow">Conversation</p>
          <h2 id={`chat-dialog-title-${nodeId}`}>Chat about {nodeTitle}</h2>
        </div>
        <button
          className="dialog-close icon-button"
          type="button"
          aria-label="Close chat"
          data-tooltip="Close chat"
          onClick={() => {
            restoreFocusOnClose.current = true;
            dialogRef.current?.close();
          }}
        >
          <CloseIcon />
        </button>
      </div>
      <section className="chat-panel" aria-label={`Conversation for ${nodeTitle}`}>
        <div className="chat-panel__top">
          <div className="chat-panel__heading">
            <h3 className="sr-only">Messages</h3>
            {cursor ? (
              <button type="button" className="secondary-button" disabled={loadingOlder} onClick={() => void loadOlder()}>
                {loadingOlder ? "Loading…" : "Load older"}
              </button>
            ) : null}
          </div>
          {loadError ? <p className="chat-panel__error" role="alert">{loadError}</p> : null}
        </div>
        <div
          className="chat-history"
          ref={historyRef}
          aria-label={`Conversation messages for ${nodeTitle}`}
          onScroll={(event) => {
            const history = event.currentTarget;
            followNewest.current = history.scrollHeight - history.scrollTop - history.clientHeight < 64;
          }}
        >
        {messages.length === 0 ? (
          <p className="chat-history__empty">No messages yet. Start by naming what you want to understand.</p>
        ) : messages.map((message) => (
          <article className={`chat-message chat-message--${message.role}`} key={message.id}>
            <p className="chat-message__label">{message.role === "user" ? "You" : "Assistant"}</p>
            <div className="chat-message__content">
              {message.role === "assistant" ? (
                <ChatMessageContent
                  content={message.content}
                  citations={message.citations ?? []}
                />
              ) : (
                <>
                  <p>{message.content}</p>
                  {message.webSearchAuthorized ? (
                    <p className="chat-message__source-note">Web sources enabled for this message.</p>
                  ) : null}
                </>
              )}
              {message.role === "assistant" && (message.status === "pending" || message.status === "streaming") ? (
                <div className="chat-message__failure">
                  <p className="chat-message__state">
                    {message.clientMessageId === researchingClientMessageId
                      ? WEB_RESEARCH_PROGRESS_MESSAGE
                      : "Thinking…"}
                  </p>
                  {message.clientMessageId !== activeClientMessageId ? (
                    <button type="button" onClick={() => void stop(message.clientMessageId)}>Stop response</button>
                  ) : null}
                </div>
              ) : null}
              {message.role === "assistant" && message.status === "cancelled" ? <p className="chat-message__state">Response stopped.</p> : null}
              {message.role === "assistant" && (message.status === "failed" || message.status === "cancelled") ? (
                <div className="chat-message__failure">
                  <p>
                    {message.status === "failed"
                      ? chatFailureMessage({
                          failureCode: message.failureCode,
                          webSearchAuthorized: webSearchClientMessageIds.has(
                            message.clientMessageId,
                          ),
                        })
                      : "Try this response again?"}
                  </p>
                  <button type="button" disabled={Boolean(activeClientMessageId) || !generationEnabled} onClick={() => retry(message)}>Retry</button>
                </div>
              ) : null}
              {message.role === "assistant" && synthesisWorkspace.pending?.generatingMessageId === message.id ? (
                <SynthesisProposalArtifact
                  key={synthesisWorkspace.pending.id}
                  nodeId={nodeId}
                  published={synthesisWorkspace.published}
                  proposal={synthesisWorkspace.pending}
                  generationBusy={Boolean(activeClientMessageId)}
                  headingRef={proposalHeadingRef}
                  onDecisionSettled={decisionSettled}
                />
              ) : null}
              {message.role === "assistant" &&
              synthesisWorkspace.pending?.generatingMessageId !== message.id &&
              decisionsByMessageId.has(message.id) ? (
                <SynthesisDecidedArtifact decision={decisionsByMessageId.get(message.id)!} />
              ) : null}
            </div>
          </article>
        ))}
        {synthesisWorkspace.pending && !pendingAppearsInHistory ? (
          <SynthesisProposalArtifact
            key={synthesisWorkspace.pending.id}
            nodeId={nodeId}
            published={synthesisWorkspace.published}
            proposal={synthesisWorkspace.pending}
            generationBusy={Boolean(activeClientMessageId)}
            headingRef={proposalHeadingRef}
            onDecisionSettled={decisionSettled}
          />
        ) : null}
        <SynthesisDecisionHistory history={decisionsOutsidePage} />
        </div>
        <form className="chat-composer" onSubmit={submit}>
          <label className="sr-only" htmlFor={`chat-draft-${nodeId}`}>Message</label>
          <p className="sr-only" id={composerHelpId}>
            {generationEnabled
              ? `Enter to send. Shift+Enter for a new line. Maximum ${MAX_USER_MESSAGE_LENGTH.toLocaleString()} characters.`
              : "History remains available; configure OPENAI_API_KEY to generate replies."}
          </p>
          <textarea
            ref={draftRef}
            id={`chat-draft-${nodeId}`}
            value={draft}
            maxLength={MAX_USER_MESSAGE_LENGTH}
            rows={1}
            disabled={!generationEnabled}
            aria-describedby={composerHelpId}
            placeholder={generationEnabled
              ? synthesisWorkspace.pending
                ? "Message this thought or refine the proposal…"
                : "Message this thought…"
              : "Assistant replies require OpenAI configuration."}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={keyDown}
          />
          <div className="chat-composer__actions">
            <label className="chat-composer__web-toggle">
              <input
                type="checkbox"
                checked={useWebSources}
                disabled={!generationEnabled || Boolean(activeClientMessageId)}
                aria-describedby={webDisclosureId}
                onChange={(event) => setUseWebSources(event.target.checked)}
              />
              <span>Use web sources</span>
            </label>
            <small aria-hidden="true">
              {generationEnabled ? (
                <>
                  <span className="chat-composer__hint">Enter to send · Shift+Enter for a new line</span>
                  <span>{draft.length.toLocaleString()} / {MAX_USER_MESSAGE_LENGTH.toLocaleString()}</span>
                </>
              ) : (
                <span>History remains available; configure OPENAI_API_KEY to generate replies.</span>
              )}
            </small>
            {activeClientMessageId ? (
              <button type="button" className="secondary-button" onClick={() => void stop()}>Stop</button>
            ) : (
              <button
                className="chat-composer__send"
                type="submit"
                disabled={!generationEnabled || draft.trim().length === 0}
              >
                Send
              </button>
            )}
          </div>
          <p className="chat-composer__web-disclosure" id={webDisclosureId}>
            Applies to the next message only. External sources may change.
          </p>
        </form>
        <p className="sr-only" aria-live="polite" role="status">{announcement}</p>
      </section>
    </dialog>
  );
}
