"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";

import { loadChatMessages, loadChatTurn } from "@/app/actions/chat";
import { ChatMessageContent } from "@/components/chat-message-content";
import {
  MAX_USER_MESSAGE_LENGTH,
  type ChatMessage,
  type ChatMessagePage,
  type ChatStreamEvent,
} from "@/lib/chat/contracts";

type ChatPanelProps = {
  nodeId: string;
  nodeTitle: string;
  initialPage: ChatMessagePage;
  generationEnabled: boolean;
};

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

function createOptimisticTurn(nodeId: string, clientMessageId: string, content: string) {
  const createdAt = new Date().toISOString();
  const base = {
    nodeId,
    clientMessageId,
    model: null,
    providerResponseId: null,
    failureCode: null,
    webSearchAuthorized: false,
    proposalRequested: false,
    refinementProposalId: null,
    createdAt,
    updatedAt: createdAt,
    completedAt: null,
  };
  return [
    { ...base, id: `local-user-${clientMessageId}`, role: "user", status: "completed", content, completedAt: createdAt },
    { ...base, id: `local-assistant-${clientMessageId}`, role: "assistant", status: "pending", content: "" },
  ] satisfies ChatMessage[];
}

export function ChatPanel({ nodeId, nodeTitle, initialPage, generationEnabled }: ChatPanelProps) {
  const composerHelpId = `chat-composer-help-${nodeId}`;
  const [messages, setMessages] = useState(initialPage.messages);
  const [cursor, setCursor] = useState(initialPage.nextCursor);
  const [draft, setDraft] = useState("");
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [activeClientMessageId, setActiveClientMessageId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const abortController = useRef<AbortController | null>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const followNewest = useRef(true);
  const paginationHeight = useRef<number | null>(null);
  const unacknowledgedContent = useRef(new Map<string, string>());

  useEffect(() => () => abortController.current?.abort(), []);
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
      unacknowledgedContent.current.delete(clientMessageId);
      return turn.find((message) => message.role === "assistant") ?? null;
    } catch {
      return null;
    }
  }

  async function streamTurn(payload: Record<string, unknown>) {
    const controller = new AbortController();
    abortController.current = controller;
    const clientMessageId = String(payload.clientMessageId);
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
            unacknowledgedContent.current.delete(clientMessageId);
            setMessages((current) => replaceTurn(current, clientMessageId, [streamEvent.userMessage, streamEvent.assistantMessage]));
          } else if (streamEvent.type === "delta") {
            setMessages((current) => current.map((message) =>
              message.id === assistantId
                ? { ...message, content: `${message.content}${streamEvent.content}`, status: "streaming" }
                : message,
            ));
          } else {
            terminalReceived = true;
            setMessages((current) => replaceMessage(current, streamEvent.assistantMessage));
            setAnnouncement(
              streamEvent.type === "completed"
                ? "Assistant response completed."
                : streamEvent.type === "cancelled"
                  ? "Assistant response stopped."
                  : "Assistant response failed.",
            );
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
        if (reconciled?.status === "completed") setAnnouncement("Assistant response completed.");
        if (reconciled?.status === "failed") setAnnouncement("Assistant response failed.");
        if (reconciled?.status === "cancelled") setAnnouncement("Assistant response stopped.");
        if (!reconciled) {
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
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || activeClientMessageId || !generationEnabled) return;
    const clientMessageId = crypto.randomUUID();
    unacknowledgedContent.current.set(clientMessageId, content);
    setMessages((current) => mergeMessages(current, createOptimisticTurn(nodeId, clientMessageId, content)));
    setDraft("");
    void streamTurn({ nodeId, clientMessageId, content, webSearchAuthorized: false });
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
    const content = unacknowledgedContent.current.get(message.clientMessageId);
    void streamTurn(content
      ? { nodeId, clientMessageId: message.clientMessageId, content, webSearchAuthorized: false }
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

  return (
    <section className="chat-panel" aria-labelledby="node-chat-title">
      <div className="chat-panel__heading">
        <div>
          <p className="pane-eyebrow">Conversation</p>
          <h2 id="node-chat-title">Develop this thought</h2>
        </div>
        {cursor ? (
          <button type="button" className="secondary-button" disabled={loadingOlder} onClick={() => void loadOlder()}>
            {loadingOlder ? "Loading…" : "Load older"}
          </button>
        ) : null}
      </div>
      {loadError ? <p className="chat-panel__error" role="alert">{loadError}</p> : null}
      <div
        className="chat-history"
        ref={historyRef}
        aria-label={`Conversation for ${nodeTitle}`}
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
              {message.role === "assistant" ? <ChatMessageContent content={message.content} /> : <p>{message.content}</p>}
              {message.role === "assistant" && (message.status === "pending" || message.status === "streaming") ? (
                <div className="chat-message__failure">
                  <p className="chat-message__state">Thinking…</p>
                  {message.clientMessageId !== activeClientMessageId ? (
                    <button type="button" onClick={() => void stop(message.clientMessageId)}>Stop response</button>
                  ) : null}
                </div>
              ) : null}
              {message.role === "assistant" && message.status === "cancelled" ? <p className="chat-message__state">Response stopped.</p> : null}
              {message.role === "assistant" && (message.status === "failed" || message.status === "cancelled") ? (
                <div className="chat-message__failure">
                  <p>{message.status === "failed" ? "That response didn’t finish." : "Try this response again?"}</p>
                  <button type="button" disabled={Boolean(activeClientMessageId) || !generationEnabled} onClick={() => retry(message)}>Retry</button>
                </div>
              ) : null}
            </div>
          </article>
        ))}
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
            placeholder={generationEnabled ? "Message this thought…" : "Assistant replies require OpenAI configuration."}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={keyDown}
          />
          <div className="chat-composer__actions">
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
        </form>
      </div>
      <p className="sr-only" aria-live="polite" role="status">{announcement}</p>
    </section>
  );
}
