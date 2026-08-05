import "server-only";

import { and, asc, desc, eq, inArray, lt, max } from "drizzle-orm";
import { DrizzleError, DrizzleQueryError } from "drizzle-orm/errors";

import { chatMessages, nodes } from "@/db/schema";
import { db } from "@/db/client";
import {
  CHAT_PAGE_SIZE,
  MAX_ASSISTANT_MESSAGE_LENGTH,
  chatFailureCodeSchema,
  type ChatMessage,
  type ChatMessagePage,
  type CreateChatTurnInput,
  type FailChatTurnInput,
  type RetryChatTurnInput,
} from "@/lib/chat/contracts";
import {
  insertPendingSynthesisProposal,
  type PendingSynthesisProposalInput,
} from "@/lib/server/synthesis-service";

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
  sequence: bigint;
};

const MAX_ENCODED_CURSOR_LENGTH = 128;
const BIGINT_NEGATIVE_ONE = BigInt(-1);
const BIGINT_ONE = BigInt(1);
const BIGINT_TWO = BigInt(2);
const POSTGRES_BIGINT_MAX = BigInt("9223372036854775807");
export const CHAT_STALE_AFTER_MS = 5 * 60 * 1_000;

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
    proposalRequested: row.proposalRequested,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

function encodeCursor(cursor: ChatCursor) {
  return Buffer.from(
    JSON.stringify({ sequence: cursor.sequence.toString() }),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(value: string): ChatCursor {
  if (value.length > MAX_ENCODED_CURSOR_LENGTH) {
    throw new ChatServiceError("invalid-cursor");
  }
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value) {
      throw new Error("invalid cursor encoding");
    }
    const parsed: unknown = JSON.parse(decoded.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("invalid cursor payload");
    }
    const sequence = "sequence" in parsed ? parsed.sequence : undefined;
    if (
      typeof sequence !== "string" ||
      !/^(0|[1-9]\d*)$/.test(sequence)
    ) {
      throw new Error("invalid cursor values");
    }
    const parsedSequence = BigInt(sequence);
    if (parsedSequence > POSTGRES_BIGINT_MAX) {
      throw new Error("invalid cursor values");
    }
    return { sequence: parsedSequence };
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

      await tx
        .update(chatMessages)
        .set({
          status: "failed",
          failureCode: "stream-disconnected",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatMessages.userId, userId),
            eq(chatMessages.nodeId, input.nodeId),
            eq(chatMessages.role, "assistant"),
            inArray(chatMessages.status, ["pending", "streaming"]),
            lt(chatMessages.updatedAt, new Date(Date.now() - CHAT_STALE_AFTER_MS)),
          ),
        );

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

export async function getChatTurnForUser(userId: string, input: RetryChatTurnInput) {
  try {
    return await db.transaction(async (tx) => {
      await lockOwnedNode(tx, userId, input.nodeId);
      await tx
        .update(chatMessages)
        .set({ status: "failed", failureCode: "stream-disconnected", updatedAt: new Date() })
        .where(
          and(
            eq(chatMessages.userId, userId),
            eq(chatMessages.nodeId, input.nodeId),
            eq(chatMessages.clientMessageId, input.clientMessageId),
            eq(chatMessages.role, "assistant"),
            inArray(chatMessages.status, ["pending", "streaming"]),
            lt(chatMessages.updatedAt, new Date(Date.now() - CHAT_STALE_AFTER_MS)),
          ),
        );
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
        .orderBy(asc(chatMessages.sequence));
      if (messages.length !== 2) throw new ChatServiceError("turn-not-found");
      return messages.map(toChatMessage);
    });
  } catch (error) {
    throw sanitizeChatServiceError(error);
  }
}

export async function createChatTurnForUser(
  userId: string,
  input: CreateChatTurnInput,
  options: { claimAssistant?: boolean } = {},
) {
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
          userMessage.webSearchAuthorized !== input.webSearchAuthorized ||
          userMessage.proposalRequested !== (input.proposalRequested ?? false)
        ) {
          throw new ChatServiceError("turn-conflict");
        }
        let returnedAssistant = assistantMessage;
        let generationClaimed = false;
        if (options.claimAssistant && assistantMessage.status === "pending") {
          const [claimed] = await tx
            .update(chatMessages)
            .set({ status: "streaming", updatedAt: new Date() })
            .where(eq(chatMessages.id, assistantMessage.id))
            .returning();
          returnedAssistant = claimed;
          generationClaimed = true;
        }
        return {
          userMessage: toChatMessage(userMessage),
          assistantMessage: toChatMessage(returnedAssistant),
          replayed: true,
          generationClaimed,
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
      const currentSequence = sequenceResult?.value ?? BIGINT_NEGATIVE_ONE;
      if (currentSequence > POSTGRES_BIGINT_MAX - BIGINT_TWO) {
        throw new ChatServiceError("unavailable");
      }
      const userSequence = currentSequence + BIGINT_ONE;
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
            proposalRequested: input.proposalRequested ?? false,
            createdAt: userCreatedAt,
            updatedAt: userCreatedAt,
            completedAt: userCreatedAt,
          },
          {
            userId,
            nodeId: input.nodeId,
            clientMessageId: input.clientMessageId,
            sequence: userSequence + BIGINT_ONE,
            role: "assistant",
            status: options.claimAssistant ? "streaming" : "pending",
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
        generationClaimed: Boolean(options.claimAssistant),
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

export async function retryChatTurnForUser(
  userId: string,
  input: RetryChatTurnInput,
  options: { claimAssistant?: boolean } = {},
) {
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
      if (assistantMessage.status !== "failed" && assistantMessage.status !== "cancelled") {
        throw new ChatServiceError("retry-unavailable");
      }

      const [retriedAssistant] = await tx
        .update(chatMessages)
        .set({
          status: options.claimAssistant ? "streaming" : "pending",
          content: "",
          model: null,
          providerResponseId: null,
          contextFingerprint: null,
          failureCode: null,
          completedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(chatMessages.id, assistantMessage.id))
        .returning();

      return {
        userMessage: toChatMessage(userMessage),
        assistantMessage: toChatMessage(retriedAssistant),
        replayed: false,
        generationClaimed: Boolean(options.claimAssistant),
      };
    });
  } catch (error) {
    throw sanitizeChatServiceError(error);
  }
}

async function updateAssistantTurnForUser(
  userId: string,
  input: RetryChatTurnInput,
  update: (
    message: typeof chatMessages.$inferSelect,
  ) => Partial<typeof chatMessages.$inferInsert>,
) {
  try {
    return await db.transaction(async (tx) => {
      await lockOwnedNode(tx, userId, input.nodeId);
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

      const [updated] = await tx
        .update(chatMessages)
        .set({ ...update(assistantMessage), updatedAt: new Date() })
        .where(eq(chatMessages.id, assistantMessage.id))
        .returning();
      return toChatMessage(updated);
    });
  } catch (error) {
    throw sanitizeChatServiceError(error);
  }
}

export function persistChatTurnContentPrefixForUser(
  userId: string,
  input: RetryChatTurnInput & { contentPrefix: string },
) {
  if (
    !input.contentPrefix ||
    input.contentPrefix.length > MAX_ASSISTANT_MESSAGE_LENGTH
  ) {
    throw new ChatServiceError("unavailable");
  }
  return updateAssistantTurnForUser(userId, input, (message) => {
    if (message.status !== "streaming") {
      throw new ChatServiceError("retry-unavailable");
    }
    if (message.content === input.contentPrefix) {
      return { status: "streaming" };
    }
    if (message.content.startsWith(input.contentPrefix)) {
      return { status: "streaming" };
    }
    if (!input.contentPrefix.startsWith(message.content)) {
      throw new ChatServiceError("retry-unavailable");
    }
    return { status: "streaming", content: input.contentPrefix };
  });
}

export function recordChatTurnContextForUser(
  userId: string,
  input: RetryChatTurnInput & { model: string; contextFingerprint: string },
) {
  if (
    input.model.length < 1 ||
    input.model.length > 100 ||
    !/^[0-9a-f]{64}$/.test(input.contextFingerprint)
  ) {
    throw new ChatServiceError("unavailable");
  }

  return updateAssistantTurnForUser(userId, input, (message) => {
    if (
      message.status !== "streaming" ||
      (message.model !== null && message.model !== input.model) ||
      (message.contextFingerprint !== null &&
        message.contextFingerprint !== input.contextFingerprint)
    ) {
      throw new ChatServiceError("retry-unavailable");
    }
    return {
      model: input.model,
      contextFingerprint: input.contextFingerprint,
    };
  });
}

export function recordChatTurnProviderResponseForUser(
  userId: string,
  input: RetryChatTurnInput & { providerResponseId: string },
) {
  if (input.providerResponseId.length < 1 || input.providerResponseId.length > 255) {
    throw new ChatServiceError("unavailable");
  }

  return updateAssistantTurnForUser(userId, input, (message) => {
    if (
      message.status !== "streaming" ||
      message.model === null ||
      message.contextFingerprint === null ||
      (message.providerResponseId !== null &&
        message.providerResponseId !== input.providerResponseId)
    ) {
      throw new ChatServiceError("retry-unavailable");
    }
    return { providerResponseId: input.providerResponseId };
  });
}

export function startChatTurnForUser(userId: string, input: RetryChatTurnInput) {
  return updateAssistantTurnForUser(userId, input, (message) => {
    if (message.status !== "pending") {
      throw new ChatServiceError("retry-unavailable");
    }
    return { status: "streaming" };
  });
}

export async function completeChatTurnForUser(
  userId: string,
  input: RetryChatTurnInput,
  options: { proposal?: PendingSynthesisProposalInput } = {},
) {
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
        .orderBy(asc(chatMessages.sequence))
        .for("update");
      const userMessage = messages.find((message) => message.role === "user");
      const assistantMessage = messages.find((message) => message.role === "assistant");
      if (!userMessage || !assistantMessage) {
        throw new ChatServiceError("turn-not-found");
      }
      if (
        (assistantMessage.status !== "pending" && assistantMessage.status !== "streaming") ||
        assistantMessage.content.length === 0
      ) {
        throw new ChatServiceError("retry-unavailable");
      }

      if (options.proposal) {
        if (
          !userMessage.proposalRequested ||
          assistantMessage.model !== options.proposal.model ||
          assistantMessage.contextFingerprint !== options.proposal.inputFingerprint
        ) {
          throw new ChatServiceError("retry-unavailable");
        }
        await insertPendingSynthesisProposal(tx, {
          ...options.proposal,
          userId,
          nodeId: input.nodeId,
          generatingMessageId: assistantMessage.id,
        });
      }

      const completedAt = new Date();
      const [completed] = await tx
        .update(chatMessages)
        .set({
          status: "completed",
          completedAt,
          failureCode: null,
          updatedAt: completedAt,
        })
        .where(eq(chatMessages.id, assistantMessage.id))
        .returning();
      return toChatMessage(completed);
    });
  } catch (error) {
    throw sanitizeChatServiceError(error);
  }
}

export function cancelChatTurnForUser(userId: string, input: RetryChatTurnInput) {
  return updateAssistantTurnForUser(userId, input, (message) => {
    if (message.status !== "pending" && message.status !== "streaming") {
      throw new ChatServiceError("retry-unavailable");
    }
    return { status: "cancelled", completedAt: null, failureCode: null };
  });
}
