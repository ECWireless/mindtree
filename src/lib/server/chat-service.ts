import "server-only";

import { and, asc, desc, eq, lt, max } from "drizzle-orm";
import { DrizzleError, DrizzleQueryError } from "drizzle-orm/errors";

import { chatMessages, nodes } from "@/db/schema";
import { db } from "@/db/client";
import {
  CHAT_PAGE_SIZE,
  chatFailureCodeSchema,
  type ChatMessage,
  type ChatMessagePage,
  type CreateChatTurnInput,
  type FailChatTurnInput,
  type RetryChatTurnInput,
} from "@/lib/chat/contracts";

type ChatTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

type ChatServiceReason =
  | "invalid-cursor"
  | "invalid-failure-code"
  | "node-not-found"
  | "retry-unavailable"
  | "turn-conflict"
  | "turn-not-found"
  | "unavailable";

type ChatCursor = {
  sequence: number;
};

const MAX_ENCODED_CURSOR_LENGTH = 128;

export class ChatServiceError extends Error {
  constructor(public readonly reason: ChatServiceReason) {
    super(reason);
    this.name = "ChatServiceError";
  }
}

function toChatMessage(row: typeof chatMessages.$inferSelect): ChatMessage {
  return {
    id: row.id,
    nodeId: row.nodeId,
    clientMessageId: row.clientMessageId,
    role: row.role,
    status: row.status,
    content: row.content,
    model: row.model,
    providerResponseId: row.providerResponseId,
    failureCode: row.failureCode,
    webSearchAuthorized: row.webSearchAuthorized,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

function encodeCursor(cursor: ChatCursor) {
  return Buffer.from(
    JSON.stringify({ sequence: cursor.sequence }),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(value: string): ChatCursor {
  if (value.length > MAX_ENCODED_CURSOR_LENGTH) {
    throw new ChatServiceError("invalid-cursor");
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("invalid cursor payload");
    }
    const sequence = "sequence" in parsed ? parsed.sequence : undefined;
    if (
      typeof sequence !== "number" ||
      !Number.isSafeInteger(sequence) ||
      sequence < 0
    ) {
      throw new Error("invalid cursor values");
    }
    return { sequence };
  } catch {
    throw new ChatServiceError("invalid-cursor");
  }
}

async function lockOwnedNode(tx: ChatTransaction, userId: string, nodeId: string) {
  const [node] = await tx
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.userId, userId), eq(nodes.id, nodeId)))
    .for("update");
  if (!node) {
    throw new ChatServiceError("node-not-found");
  }
}

type PostgreSqlFailure = {
  code: string;
  constraint?: string;
};

function getPostgreSqlFailure(error: unknown): PostgreSqlFailure | null {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) {
      return null;
    }
    if ("code" in current && typeof current.code === "string") {
      return {
        code: current.code,
        constraint:
          "constraint" in current && typeof current.constraint === "string"
            ? current.constraint
            : undefined,
      };
    }
    current = "cause" in current ? current.cause : null;
  }
  return null;
}

function sanitizeChatServiceError(error: unknown): Error {
  if (error instanceof ChatServiceError) {
    return error;
  }
  const postgresFailure = getPostgreSqlFailure(error);
  if (
    postgresFailure?.code === "23505" &&
    postgresFailure.constraint === "chat_messages_turn_role_unique"
  ) {
    return new ChatServiceError("turn-conflict");
  }
  if (
    error instanceof DrizzleError ||
    error instanceof DrizzleQueryError ||
    postgresFailure !== null
  ) {
    return new ChatServiceError("unavailable");
  }
  return error instanceof Error ? error : new ChatServiceError("unavailable");
}

export async function getChatMessagesForUser(
  userId: string,
  input: { nodeId: string; cursor?: string; limit?: number },
): Promise<ChatMessagePage> {
  const limit = input.limit ?? CHAT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > CHAT_PAGE_SIZE) {
    throw new ChatServiceError("invalid-cursor");
  }
  const cursor = input.cursor ? decodeCursor(input.cursor) : null;

  try {
    return await db.transaction(async (tx) => {
      const [node] = await tx
        .select({ id: nodes.id })
        .from(nodes)
        .where(and(eq(nodes.userId, userId), eq(nodes.id, input.nodeId)));
      if (!node) {
        throw new ChatServiceError("node-not-found");
      }

      const cursorCondition = cursor
        ? lt(chatMessages.sequence, cursor.sequence)
        : undefined;
      const rows = await tx
        .select()
        .from(chatMessages)
        .where(
          and(
            eq(chatMessages.userId, userId),
            eq(chatMessages.nodeId, input.nodeId),
            cursorCondition,
          ),
        )
        .orderBy(desc(chatMessages.sequence))
        .limit(limit + 1);
      const hasMore = rows.length > limit;
      const pageRows = rows.slice(0, limit);
      const oldest = pageRows.at(-1);

      return {
        messages: pageRows.reverse().map(toChatMessage),
        nextCursor:
          hasMore && oldest
            ? encodeCursor({ sequence: oldest.sequence })
            : null,
      };
    });
  } catch (error) {
    throw sanitizeChatServiceError(error);
  }
}

export async function createChatTurnForUser(userId: string, input: CreateChatTurnInput) {
  try {
    return await db.transaction(async (tx) => {
      await lockOwnedNode(tx, userId, input.nodeId);
      const existing = await tx
        .select()
        .from(chatMessages)
        .where(
          and(
            eq(chatMessages.userId, userId),
            eq(chatMessages.nodeId, input.nodeId),
            eq(chatMessages.clientMessageId, input.clientMessageId),
          ),
        )
        .orderBy(asc(chatMessages.role));

      if (existing.length > 0) {
        const userMessage = existing.find((message) => message.role === "user");
        const assistantMessage = existing.find((message) => message.role === "assistant");
        if (
          existing.length !== 2 ||
          !userMessage ||
          !assistantMessage ||
          userMessage.content !== input.content ||
          userMessage.webSearchAuthorized !== input.webSearchAuthorized
        ) {
          throw new ChatServiceError("turn-conflict");
        }
        return {
          userMessage: toChatMessage(userMessage),
          assistantMessage: toChatMessage(assistantMessage),
          replayed: true,
        };
      }

      const userCreatedAt = new Date();
      const [sequenceResult] = await tx
        .select({ value: max(chatMessages.sequence) })
        .from(chatMessages)
        .where(
          and(
            eq(chatMessages.userId, userId),
            eq(chatMessages.nodeId, input.nodeId),
          ),
        );
      const userSequence = (sequenceResult?.value ?? -1) + 1;
      const createdMessages = await tx
        .insert(chatMessages)
        .values([
          {
            userId,
            nodeId: input.nodeId,
            clientMessageId: input.clientMessageId,
            sequence: userSequence,
            role: "user",
            status: "completed",
            content: input.content,
            webSearchAuthorized: input.webSearchAuthorized,
            createdAt: userCreatedAt,
            updatedAt: userCreatedAt,
            completedAt: userCreatedAt,
          },
          {
            userId,
            nodeId: input.nodeId,
            clientMessageId: input.clientMessageId,
            sequence: userSequence + 1,
            role: "assistant",
            status: "pending",
            createdAt: userCreatedAt,
            updatedAt: userCreatedAt,
          },
        ])
        .returning();
      const userMessage = createdMessages.find((message) => message.role === "user");
      const assistantMessage = createdMessages.find((message) => message.role === "assistant");
      if (!userMessage || !assistantMessage) {
        throw new ChatServiceError("unavailable");
      }

      return {
        userMessage: toChatMessage(userMessage),
        assistantMessage: toChatMessage(assistantMessage),
        replayed: false,
      };
    });
  } catch (error) {
    throw sanitizeChatServiceError(error);
  }
}

export async function failChatTurnForUser(userId: string, input: FailChatTurnInput) {
  try {
    return await db.transaction(async (tx) => {
      await lockOwnedNode(tx, userId, input.nodeId);
      const failureCode = chatFailureCodeSchema.safeParse(input.failureCode);
      if (!failureCode.success) {
        throw new ChatServiceError("invalid-failure-code");
      }
      const [assistantMessage] = await tx
        .select()
        .from(chatMessages)
        .where(
          and(
            eq(chatMessages.userId, userId),
            eq(chatMessages.nodeId, input.nodeId),
            eq(chatMessages.clientMessageId, input.clientMessageId),
            eq(chatMessages.role, "assistant"),
          ),
        )
        .for("update");
      if (!assistantMessage) {
        throw new ChatServiceError("turn-not-found");
      }
      if (assistantMessage.status !== "pending" && assistantMessage.status !== "streaming") {
        throw new ChatServiceError("retry-unavailable");
      }

      const [failed] = await tx
        .update(chatMessages)
        .set({ status: "failed", failureCode: failureCode.data, updatedAt: new Date() })
        .where(eq(chatMessages.id, assistantMessage.id))
        .returning();
      return toChatMessage(failed);
    });
  } catch (error) {
    throw sanitizeChatServiceError(error);
  }
}

export async function retryChatTurnForUser(userId: string, input: RetryChatTurnInput) {
  try {
    return await db.transaction(async (tx) => {
      await lockOwnedNode(tx, userId, input.nodeId);
      const messages = await tx
        .select()
        .from(chatMessages)
        .where(
          and(
            eq(chatMessages.userId, userId),
            eq(chatMessages.nodeId, input.nodeId),
            eq(chatMessages.clientMessageId, input.clientMessageId),
          ),
        )
        .orderBy(asc(chatMessages.role))
        .for("update");
      const userMessage = messages.find((message) => message.role === "user");
      const assistantMessage = messages.find((message) => message.role === "assistant");
      if (!userMessage || !assistantMessage) {
        throw new ChatServiceError("turn-not-found");
      }
      if (assistantMessage.status !== "failed") {
        throw new ChatServiceError("retry-unavailable");
      }

      const [retriedAssistant] = await tx
        .update(chatMessages)
        .set({
          status: "pending",
          content: "",
          model: null,
          providerResponseId: null,
          failureCode: null,
          completedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(chatMessages.id, assistantMessage.id))
        .returning();

      return {
        userMessage: toChatMessage(userMessage),
        assistantMessage: toChatMessage(retriedAssistant),
      };
    });
  } catch (error) {
    throw sanitizeChatServiceError(error);
  }
}
