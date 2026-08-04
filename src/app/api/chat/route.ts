import {
  createChatTurnInputSchema,
  retryChatTurnInputSchema,
  type ChatMessage,
  type ChatStreamEvent,
} from "@/lib/chat/contracts";
import { requireAuthorizedSession } from "@/lib/server/authorization";
import {
  appendChatTurnContentForUser,
  cancelChatTurnForUser,
  completeChatTurnForUser,
  createChatTurnForUser,
  failChatTurnForUser,
  retryChatTurnForUser,
} from "@/lib/server/chat-service";
import { generateDeterministicChatReply, isDeterministicChatFixtureEnabled } from "@/lib/server/chat-runtime";

export const runtime = "nodejs";
const MAX_CHAT_REQUEST_BYTES = 128_000;

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
}) {
  const events: ChatStreamEvent[] = [
    { type: "turn", userMessage: turn.userMessage, assistantMessage: turn.assistantMessage },
    { type: turn.assistantMessage.status as "completed" | "failed" | "cancelled", assistantMessage: turn.assistantMessage },
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

  if (!isDeterministicChatFixtureEnabled()) {
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
  const retry = typeof body === "object" && body !== null && "retry" in body && body.retry === true;
  const parsed = retry
    ? retryChatTurnInputSchema.safeParse(body)
    : createChatTurnInputSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(400, "The message is invalid.");
  }

  const userId = session.user.id;
  const input = parsed.data;
  let turn;
  try {
    turn = retry
      ? await retryChatTurnForUser(userId, input, { claimAssistant: true })
      : await createChatTurnForUser(userId, parsed.data as never, { claimAssistant: true });
  } catch {
    return jsonError(409, "The message could not be started.");
  }

  if (!turn.generationClaimed) {
    if (["completed", "failed", "cancelled"].includes(turn.assistantMessage.status)) {
      return terminalResponse(turn);
    }
    return jsonError(409, "The message is already in progress.");
  }

  const encoder = new TextEncoder();
  const event = (value: ChatStreamEvent) => encoder.encode(`${JSON.stringify(value)}\n`);
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(event({ type: "turn", ...turn }));
      try {
        for await (const content of generateDeterministicChatReply(turn.userMessage.content)) {
          if (request.signal.aborted) {
            await cancelChatTurnForUser(userId, input);
            return;
          }
          await appendChatTurnContentForUser(userId, { ...input, content });
          controller.enqueue(event({ type: "delta", content }));
        }
        const assistantMessage = await completeChatTurnForUser(userId, input);
        controller.enqueue(event({ type: "completed", assistantMessage }));
      } catch {
        try {
          const assistantMessage = request.signal.aborted
            ? await cancelChatTurnForUser(userId, input)
            : await failChatTurnForUser(userId, { ...input, failureCode: "generation-failed" });
          if (!request.signal.aborted && assistantMessage.status === "failed") {
            controller.enqueue(event({ type: "failed", assistantMessage }));
          }
        } catch {
          // The persisted state remains authoritative when the client reloads.
        }
      } finally {
        controller.close();
      }
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
