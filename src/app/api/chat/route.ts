import {
  createChatTurnInputSchema,
  MAX_ASSISTANT_MESSAGE_LENGTH,
  retryChatTurnInputSchema,
  type ChatMessage,
  type ChatStreamEvent,
  type RetryChatTurnInput,
} from "@/lib/chat/contracts";
import {
  OPENAI_CHAT_MODEL,
  OPENAI_SYNTHESIS_MODEL,
} from "@/lib/ai/openai-profiles";
import { getServerEnvironment } from "@/lib/env/server";
import { requireAuthorizedSession } from "@/lib/server/authorization";
import {
  buildSynthesisInputWithExternalEvidence,
  isSynthesisOutlineInputCurrentForUser,
  prepareChatContextForUser,
} from "@/lib/server/chat-context";
import {
  createExternalCitationEvidence,
  mergeExternalCitationEvidenceBounded,
  type ExternalCitationEvidence,
} from "@/lib/server/external-citations";
import {
  createDeterministicExternalPdfInput,
  fetchAuthorizedExternalPdf,
  findAuthorizedExternalPdfSource,
  type ExternalPdfInput,
} from "@/lib/server/external-pdf-source";
import {
  persistChatTurnContentPrefixForUser,
  cancelChatTurnForUser,
  completeChatTurnForUser,
  createChatTurnForUser,
  failChatTurnForUser,
  recordChatTurnContextForUser,
  recordChatTurnProviderResponseForUser,
  recordChatTurnSynthesisIntentForUser,
  retryChatTurnForUser,
  synthesisProposalExistsForMessageForUser,
} from "@/lib/server/chat-service";
import {
  createOpenAISafetyIdentifier,
  getChatGenerationMode,
  streamChatResponse,
} from "@/lib/server/chat-runtime";
import { scheduleChatStreamHeartbeats } from "@/lib/server/chat-stream";
import {
  OpenAIChatAbortError,
  OpenAIChatError,
  type NormalizedOpenAIChatEvent,
} from "@/lib/server/openai-chat";

export const runtime = "nodejs";
const MAX_CHAT_REQUEST_BYTES = 128_000;
const PERSISTENCE_BATCH_CHARACTERS = 1_024;
const PERSISTENCE_BATCH_MS = 250;
const STALE_BRANCH_OUTLINE_SUMMARY_NOTICE =
  "Regenerate the stale Branch Outline before requesting a new Summary. You can still discuss the existing outline here.";

class ChatRequestTooLargeError extends Error {}

function jsonError(status: number, message: string) {
  return Response.json({ message }, { status });
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CHAT_REQUEST_BYTES) {
    throw new ChatRequestTooLargeError();
  }
  if (!request.body) throw new Error("missing body");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > MAX_CHAT_REQUEST_BYTES) {
      await reader.cancel();
      throw new ChatRequestTooLargeError();
    }
    chunks.push(value);
  }
  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(body));
}

async function terminalResponse(userId: string, turn: {
  userMessage: ChatMessage;
  assistantMessage: ChatMessage;
}): Promise<Response | null> {
  const status = turn.assistantMessage.status;
  if (status !== "completed" && status !== "failed" && status !== "cancelled") {
    return null;
  }
  const proposalCreated = status === "completed"
    ? await synthesisProposalExistsForMessageForUser(userId, {
        nodeId: turn.assistantMessage.nodeId,
        messageId: turn.assistantMessage.id,
      })
    : false;
  const events: ChatStreamEvent[] = [
    { type: "turn", userMessage: turn.userMessage, assistantMessage: turn.assistantMessage },
    status === "completed"
      ? {
          type: "completed",
          assistantMessage: turn.assistantMessage,
          proposalCreated,
        }
      : { type: status, assistantMessage: turn.assistantMessage },
  ];
  return new Response(events.map((value) => JSON.stringify(value)).join("\n") + "\n", {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request) {
  let session;
  try {
    session = await requireAuthorizedSession(request.headers);
  } catch {
    return jsonError(401, "Authentication is required.");
  }

  if (getChatGenerationMode() === "unavailable") {
    return jsonError(503, "Assistant replies are not available yet.");
  }

  let body: unknown;
  try {
    body = await readBoundedJson(request);
  } catch (error) {
    if (error instanceof ChatRequestTooLargeError) {
      return jsonError(413, "The message is too large.");
    }
    return jsonError(400, "The message could not be read.");
  }
  const retryRequested =
    typeof body === "object" && body !== null && "retry" in body && body.retry === true;
  const userId = session.user.id;
  let turn: Awaited<ReturnType<typeof createChatTurnForUser>>;
  let input: RetryChatTurnInput;
  try {
    if (retryRequested) {
      const parsed = retryChatTurnInputSchema.safeParse(body);
      if (!parsed.success) {
        return jsonError(400, "The message is invalid.");
      }
      input = parsed.data;
      turn = await retryChatTurnForUser(userId, input, { claimAssistant: true });
    } else {
      const parsed = createChatTurnInputSchema.safeParse(body);
      if (!parsed.success) {
        return jsonError(400, "The message is invalid.");
      }
      input = {
        nodeId: parsed.data.nodeId,
        clientMessageId: parsed.data.clientMessageId,
      };
      turn = await createChatTurnForUser(userId, parsed.data, { claimAssistant: true });
    }
  } catch {
    return jsonError(409, "The message could not be started.");
  }

  if (!turn.generationClaimed) {
    return await terminalResponse(userId, turn) ??
      jsonError(409, "The message is already in progress.");
  }
  const webSearchAuthorized = turn.userMessage.webSearchAuthorized;
  let externalPdfSource: ExternalPdfInput | null = null;
  if (webSearchAuthorized) {
    try {
      const source = findAuthorizedExternalPdfSource(turn.userMessage.content);
      if (source) {
        externalPdfSource = getChatGenerationMode() === "deterministic-fixture"
          ? createDeterministicExternalPdfInput(source)
          : await fetchAuthorizedExternalPdf(source, { signal: request.signal });
      }
    } catch {
      const assistantMessage = await failChatTurnForUser(userId, {
        ...input,
        failureCode: "response-invalid",
      });
      return await terminalResponse(userId, {
        userMessage: turn.userMessage,
        assistantMessage,
      }) ?? jsonError(400, "The external PDF URL is invalid.");
    }
  }

  let preparedContext;
  try {
    preparedContext = await prepareChatContextForUser(userId, input);
  } catch {
    const assistantMessage = await failChatTurnForUser(userId, {
      ...input,
      failureCode: "generation-failed",
    });
    return await terminalResponse(userId, {
      userMessage: turn.userMessage,
      assistantMessage,
    }) ??
      jsonError(500, "The response could not be prepared.");
  }

  const authEnvironment = getServerEnvironment(["authentication"]);
  const safetyIdentifier = createOpenAISafetyIdentifier(
    userId,
    authEnvironment.BETTER_AUTH_SECRET,
  );

  const encoder = new TextEncoder();
  const event = (value: ChatStreamEvent) => encoder.encode(`${JSON.stringify(value)}\n`);
  const downstreamAbortController = new AbortController();
  const generationSignal = AbortSignal.any([
    request.signal,
    downstreamAbortController.signal,
  ]);
  let downstreamDisconnected = false;
  let generationTask: Promise<void> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      generationTask = (async () => {
      const enqueueEvent = (streamEvent: ChatStreamEvent) => {
        try {
          controller.enqueue(event(streamEvent));
        } catch {
          downstreamDisconnected = true;
          downstreamAbortController.abort();
        }
      };
      enqueueEvent({ type: "turn", ...turn });
      const stopHeartbeats = scheduleChatStreamHeartbeats(enqueueEvent);
      let visibleContent = "";
      let providerContextRecorded = false;
      let providerResponseRecorded = false;
      let persistedCharacterCount = 0;
      let lastPersistenceAt = Date.now();
      const flushPersistence = async (force = false) => {
        if (
          visibleContent.length === persistedCharacterCount ||
          (!force &&
            visibleContent.length - persistedCharacterCount <
              PERSISTENCE_BATCH_CHARACTERS &&
            Date.now() - lastPersistenceAt < PERSISTENCE_BATCH_MS)
        ) {
          return;
        }
        const contentPrefix = visibleContent;
        await persistChatTurnContentPrefixForUser(userId, {
          ...input,
          contentPrefix,
        });
        persistedCharacterCount = contentPrefix.length;
        lastPersistenceAt = Date.now();
      };
      const emitVisibleContent = async (content: string) => {
        if (visibleContent.length + content.length > MAX_ASSISTANT_MESSAGE_LENGTH) {
          throw new OpenAIChatError("response-invalid");
        }
        visibleContent += content;
        enqueueEvent({ type: "delta", content });
        await flushPersistence();
      };

      try {
        let synthesisProviderInput = preparedContext.synthesisInput;
        let synthesisProviderFingerprint = preparedContext.synthesisFingerprint;
        let externalEvidence: ExternalCitationEvidence[] = preparedContext.externalEvidence;
        let chatExternalCitations: Extract<
          NormalizedOpenAIChatEvent,
          { type: "completed" }
        >["externalCitations"] = [];
        const consumeProviderPhase = async (phase: "conversation" | "synthesis") => {
          if (!providerContextRecorded || phase === "synthesis") {
            await recordChatTurnContextForUser(userId, {
              ...input,
              model: OPENAI_CHAT_MODEL,
              contextFingerprint: phase === "synthesis"
                ? synthesisProviderFingerprint
                : preparedContext.fingerprint,
              replaceExistingContext: providerContextRecorded && phase === "synthesis",
            });
            providerContextRecorded = true;
          }
          let completedEvent: Extract<
            NormalizedOpenAIChatEvent,
            { type: "completed" }
          > | null = null;
          for await (const providerEvent of streamChatResponse({
            messages: phase === "synthesis"
              ? synthesisProviderInput
              : preparedContext.input,
            phase,
            safetyIdentifier,
            signal: generationSignal,
            webSearchAuthorized: phase === "conversation" && webSearchAuthorized,
            externalPdfSource: phase === "conversation" ? externalPdfSource : null,
          })) {
            if (generationSignal.aborted) {
              throw new OpenAIChatAbortError();
            }
            if (providerEvent.type === "started") {
              if (!providerResponseRecorded || phase === "synthesis") {
                await recordChatTurnProviderResponseForUser(userId, {
                  ...input,
                  providerResponseId: providerEvent.providerResponseId,
                  replaceExistingProviderResponse: phase === "synthesis",
                });
                providerResponseRecorded = true;
              }
            } else if (providerEvent.type === "text-delta") {
              await emitVisibleContent(providerEvent.content);
            } else if (providerEvent.type === "research-status") {
              enqueueEvent({
                type: "research-status",
                status: providerEvent.status,
              });
            } else {
              completedEvent = providerEvent;
            }
          }
          if (!completedEvent) throw new OpenAIChatError("response-invalid");
          return completedEvent;
        };

        const refinementProposalId =
          preparedContext.snapshot.node.refinementProposal.state === "pending"
            ? preparedContext.snapshot.node.refinementProposal.versionId
            : null;
        let synthesisRouted = turn.userMessage.proposalRequested && !webSearchAuthorized;
        const outlineIsStale =
          preparedContext.snapshot.node.branchOutline.state === "stale";
        const outlineIsCurrent = () =>
          !outlineIsStale && isSynthesisOutlineInputCurrentForUser(
            userId,
            input.nodeId,
            preparedContext.outlineInput,
          );
        const installExternalEvidence = () => {
          if (externalEvidence.length === 0) return;
          const bounded = buildSynthesisInputWithExternalEvidence(
            preparedContext.snapshot,
            externalEvidence,
          );
          synthesisProviderInput = bounded.input;
          synthesisProviderFingerprint = bounded.fingerprint;
          externalEvidence = bounded.externalEvidence;
        };
        let finalResult: Extract<NormalizedOpenAIChatEvent, { type: "completed" }>;
        if (synthesisRouted) {
          if (!(await outlineIsCurrent())) {
            await emitVisibleContent(STALE_BRANCH_OUTLINE_SUMMARY_NOTICE);
            await flushPersistence(true);
            const assistantMessage = await completeChatTurnForUser(userId, input);
            enqueueEvent({
              type: "completed",
              assistantMessage,
              proposalCreated: false,
            });
            return;
          }
          installExternalEvidence();
          finalResult = await consumeProviderPhase("synthesis");
        } else {
          const conversationResult = await consumeProviderPhase("conversation");
          synthesisRouted = conversationResult.synthesisRequested ||
            (webSearchAuthorized && turn.userMessage.proposalRequested);
          finalResult = conversationResult;
          chatExternalCitations = conversationResult.externalCitations ?? [];
          if (webSearchAuthorized) {
            const currentEvidence = createExternalCitationEvidence({
              content: visibleContent,
              citations: chatExternalCitations,
              owner: "assistant-message",
              ownerId: turn.assistantMessage.id,
            });
            externalEvidence = mergeExternalCitationEvidenceBounded([
              currentEvidence,
              preparedContext.externalEvidence,
            ]);
          }
          if (synthesisRouted) {
            await recordChatTurnSynthesisIntentForUser(userId, {
              ...input,
              refinementProposalId,
            });
            if (visibleContent.length > 0 && !visibleContent.endsWith("\n\n")) {
              await emitVisibleContent(visibleContent.endsWith("\n") ? "\n" : "\n\n");
            }
            if (!(await outlineIsCurrent())) {
              await emitVisibleContent(STALE_BRANCH_OUTLINE_SUMMARY_NOTICE);
              await flushPersistence(true);
              const assistantMessage = await completeChatTurnForUser(userId, input, {
                externalCitations: chatExternalCitations,
              });
              enqueueEvent({
                type: "completed",
                assistantMessage,
                proposalCreated: false,
              });
              return;
            }
            installExternalEvidence();
            finalResult = await consumeProviderPhase("synthesis");
          }
        }
        if (synthesisRouted && finalResult.proposal === null) {
          throw new OpenAIChatError("response-invalid");
        }
        await flushPersistence(true);
        const assistantMessage = await completeChatTurnForUser(
          userId,
          input,
          finalResult.proposal
            ? {
                externalCitations: chatExternalCitations,
                proposal: {
                  baseVersionId:
                    preparedContext.snapshot.node.publishedSynthesis.state === "published"
                      ? preparedContext.snapshot.node.publishedSynthesis.versionId
                      : null,
                  draft: finalResult.proposal,
                  model: OPENAI_SYNTHESIS_MODEL,
                  reasoningMode: "pro",
                  reasoningEffort: "high",
                  inputFingerprint: synthesisProviderFingerprint,
                  outlineInput: preparedContext.outlineInput,
                  relatedInputs: preparedContext.relatedInputs,
                  externalEvidence,
                  refinementProposalId,
                },
              }
            : { externalCitations: chatExternalCitations },
        );
        enqueueEvent({
          type: "completed",
          assistantMessage,
          proposalCreated: finalResult.proposal !== null,
        });
      } catch (error) {
        try {
          await flushPersistence(true);
        } catch {
          // Preserve the authoritative persisted prefix and continue to a terminal state.
        }
        try {
          const interrupted = downstreamDisconnected ||
            generationSignal.aborted ||
            error instanceof OpenAIChatAbortError;
          const assistantMessage = await failChatTurnForUser(userId, {
            ...input,
            failureCode: interrupted
              ? "stream-disconnected"
              : error instanceof OpenAIChatError
              ? error.failureCode
              : "generation-failed",
          });
          if (assistantMessage.status === "failed") {
            enqueueEvent({ type: "failed", assistantMessage });
          }
        } catch {
          // The persisted state remains authoritative when the client reloads.
        }
      } finally {
        stopHeartbeats();
        try {
          controller.close();
        } catch {
          // The downstream reader may already be gone.
        }
      }
    })();
  },
    async cancel() {
      downstreamDisconnected = true;
      downstreamAbortController.abort();
      await generationTask?.catch(() => undefined);
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export async function DELETE(request: Request) {
  let session;
  try {
    session = await requireAuthorizedSession(request.headers);
  } catch {
    return jsonError(401, "Authentication is required.");
  }

  let body: unknown;
  try {
    body = await readBoundedJson(request);
  } catch (error) {
    if (error instanceof ChatRequestTooLargeError) {
      return jsonError(413, "The cancellation request is too large.");
    }
    return jsonError(400, "The cancellation request could not be read.");
  }
  const parsed = retryChatTurnInputSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(400, "The cancellation request is invalid.");
  }

  try {
    const assistantMessage = await cancelChatTurnForUser(session.user.id, parsed.data);
    return Response.json({ assistantMessage });
  } catch {
    return jsonError(409, "The response could not be stopped.");
  }
}
