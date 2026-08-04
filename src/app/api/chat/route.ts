import {
  createChatTurnInputSchema,
  retryChatTurnInputSchema,
  type ChatMessage,
  type ChatStreamEvent,
  type RetryChatTurnInput,
} from "@/lib/chat/contracts";
import { OPENAI_CHAT_MODEL } from "@/lib/ai/openai-profiles";
import { getServerEnvironment } from "@/lib/env/server";
import { requireAuthorizedSession } from "@/lib/server/authorization";
import { prepareChatContextForUser } from "@/lib/server/chat-context";
import {
  persistChatTurnContentPrefixForUser,
  cancelChatTurnForUser,
  completeChatTurnForUser,
  createChatTurnForUser,
  failChatTurnForUser,
  recordChatTurnContextForUser,
  recordChatTurnProviderResponseForUser,
  retryChatTurnForUser,
} from "@/lib/server/chat-service";
import {
  createOpenAISafetyIdentifier,
  getChatGenerationMode,
  streamChatResponse,
} from "@/lib/server/chat-runtime";
import { OpenAIChatAbortError, OpenAIChatError } from "@/lib/server/openai-chat";

export const runtime = "nodejs";
const MAX_CHAT_REQUEST_BYTES = 128_000;
const PERSISTENCE_BATCH_CHARACTERS = 1_024;
const PERSISTENCE_BATCH_MS = 250;

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

function terminalResponse(turn: {
  userMessage: ChatMessage;
  assistantMessage: ChatMessage;
}): Response | null {
  const status = turn.assistantMessage.status;
  if (status !== "completed" && status !== "failed" && status !== "cancelled") {
    return null;
  }
  const events: ChatStreamEvent[] = [
    { type: "turn", userMessage: turn.userMessage, assistantMessage: turn.assistantMessage },
    { type: status, assistantMessage: turn.assistantMessage },
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
      if (parsed.data.webSearchAuthorized) {
        return jsonError(400, "Web sources are not available yet.");
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
    return terminalResponse(turn) ?? jsonError(409, "The message is already in progress.");
  }

  let preparedContext;
  try {
    preparedContext = await prepareChatContextForUser(userId, input);
    await recordChatTurnContextForUser(userId, {
      ...input,
      model: OPENAI_CHAT_MODEL,
      contextFingerprint: preparedContext.fingerprint,
    });
  } catch {
    const assistantMessage = await failChatTurnForUser(userId, {
      ...input,
      failureCode: "generation-failed",
    });
    return terminalResponse({ userMessage: turn.userMessage, assistantMessage }) ??
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
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(event({ type: "turn", ...turn }));
      let visibleContent = "";
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

      try {
        for await (const providerEvent of streamChatResponse({
          messages: preparedContext.input,
          safetyIdentifier,
          signal: generationSignal,
        })) {
          if (generationSignal.aborted) {
            throw new OpenAIChatAbortError();
          }
          if (providerEvent.type === "started") {
            await recordChatTurnProviderResponseForUser(userId, {
              ...input,
              providerResponseId: providerEvent.providerResponseId,
            });
          } else if (providerEvent.type === "text-delta") {
            visibleContent += providerEvent.content;
            controller.enqueue(event({ type: "delta", content: providerEvent.content }));
            await flushPersistence();
          } else {
            await flushPersistence(true);
            const assistantMessage = await completeChatTurnForUser(userId, input);
            controller.enqueue(event({ type: "completed", assistantMessage }));
          }
        }
      } catch (error) {
        try {
          await flushPersistence(true);
        } catch {
          // Preserve the authoritative persisted prefix and continue to a terminal state.
        }
        try {
          const cancelled =
            generationSignal.aborted || error instanceof OpenAIChatAbortError;
          const assistantMessage = cancelled
            ? await cancelChatTurnForUser(userId, input)
            : await failChatTurnForUser(userId, {
                ...input,
                failureCode:
                  error instanceof OpenAIChatError
                    ? error.failureCode
                    : "generation-failed",
              });
          if (!cancelled && assistantMessage.status === "failed") {
            controller.enqueue(event({ type: "failed", assistantMessage }));
          }
        } catch {
          // The persisted state remains authoritative when the client reloads.
        }
      } finally {
        try {
          controller.close();
        } catch {
          // The downstream reader may already be gone.
        }
      }
    },
    cancel() {
      downstreamAbortController.abort();
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
