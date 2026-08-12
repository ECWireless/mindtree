import "server-only";

import { and, asc, desc, eq, inArray, lt, max } from "drizzle-orm";
import { DrizzleError, DrizzleQueryError } from "drizzle-orm/errors";

import { chatMessages, citations, nodes, synthesisVersions } from "@/db/schema";
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
import type { ExternalCitationView } from "@/lib/citations/contracts";
import {
  insertPendingSynthesisProposal,
  type PendingSynthesisProposalInput,
} from "@/lib/server/synthesis-service";

type ChatTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

type ChatServiceReason =
  | "invalid-cursor"
  | "invalid-failure-code"
  | "node-not-found"
  | "proposal-conflict"
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

function toChatMessage(
  row: typeof chatMessages.$inferSelect,
  externalCitations: ExternalCitationView[] = [],
): ChatMessage {
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
    refinementProposalId: row.refinementProposalId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    citations: externalCitations,
  };
}

async function getExternalCitationViewsForMessages(
  tx: ChatTransaction,
  userId: string,
  messageIds: readonly string[],
) {
  const byMessageId = new Map<string, ExternalCitationView[]>();
  if (messageIds.length === 0) return byMessageId;
  const rows = await tx
    .select({
      assistantMessageId: citations.assistantMessageId,
      ordinal: citations.ordinal,
      startUtf16: citations.startUtf16,
      endUtf16: citations.endUtf16,
      title: citations.externalTitle,
      url: citations.externalUrl,
    })
    .from(citations)
    .where(and(
      eq(citations.userId, userId),
      eq(citations.kind, "external"),
      inArray(citations.assistantMessageId, [...messageIds]),
    ))
    .orderBy(
      asc(citations.assistantMessageId),
      asc(citations.startUtf16),
      asc(citations.ordinal),
    );
  for (const row of rows) {
    if (row.assistantMessageId === null || row.title === null || row.url === null) {
      throw new ChatServiceError("unavailable");
    }
    const views = byMessageId.get(row.assistantMessageId) ?? [];
    views.push({
      kind: "external",
      ordinal: row.ordinal,
      startUtf16: row.startUtf16,
      endUtf16: row.endUtf16,
      title: row.title,
      url: row.url,
    });
    byMessageId.set(row.assistantMessageId, views);
  }
  return byMessageId;
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
    .select({
      id: nodes.id,
      publishedSynthesisVersionId: nodes.publishedSynthesisVersionId,
    })
    .from(nodes)
    .where(and(eq(nodes.userId, userId), eq(nodes.id, nodeId)))
    .for("update");
  if (!node) {
    throw new ChatServiceError("node-not-found");
  }
  return node;
}

async function requireProposalIntentAvailable(
  tx: ChatTransaction,
  input: {
    userId: string;
    nodeId: string;
    proposalRequested: boolean;
    refinementProposalId: string | null;
    publishedSynthesisVersionId: string | null;
  },
) {
  if (!input.proposalRequested) {
    if (input.refinementProposalId !== null) {
      throw new ChatServiceError("proposal-conflict");
    }
    return;
  }

  const pending = await tx
    .select({
      id: synthesisVersions.id,
      baseVersionId: synthesisVersions.baseVersionId,
    })
    .from(synthesisVersions)
    .where(
      and(
        eq(synthesisVersions.userId, input.userId),
        eq(synthesisVersions.nodeId, input.nodeId),
        eq(synthesisVersions.status, "pending"),
      ),
    )
    .limit(2)
    .for("update");
  if (
    pending.length > 1 ||
    (input.refinementProposalId === null && pending.length !== 0) ||
    (input.refinementProposalId !== null &&
      (pending.length !== 1 ||
        pending[0]?.id !== input.refinementProposalId ||
        pending[0]?.baseVersionId !== input.publishedSynthesisVersionId))
  ) {
    throw new ChatServiceError("proposal-conflict");
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
      const citationViews = await getExternalCitationViewsForMessages(
        tx,
        userId,
        pageRows.filter(({ role }) => role === "assistant").map(({ id }) => id),
      );

      return {
        messages: pageRows.reverse().map((row) =>
          toChatMessage(row, citationViews.get(row.id) ?? [])
        ),
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

export async function synthesisProposalExistsForMessageForUser(
  userId: string,
  input: { nodeId: string; messageId: string },
) {
  try {
    const [proposal] = await db
      .select({ id: synthesisVersions.id })
      .from(synthesisVersions)
      .where(and(
        eq(synthesisVersions.userId, userId),
        eq(synthesisVersions.nodeId, input.nodeId),
        eq(synthesisVersions.generatingMessageId, input.messageId),
      ))
      .limit(1);
    return proposal !== undefined;
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
      const assistantMessage = messages.find(({ role }) => role === "assistant");
      const citationViews = await getExternalCitationViewsForMessages(
        tx,
        userId,
        assistantMessage ? [assistantMessage.id] : [],
      );
      return messages.map((row) =>
        toChatMessage(row, citationViews.get(row.id) ?? [])
      );
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
      const lockedNode = await lockOwnedNode(tx, userId, input.nodeId);
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
          (input.proposalRequested !== undefined &&
            userMessage.proposalRequested !== input.proposalRequested) ||
          (input.refinementProposalId !== undefined &&
            userMessage.refinementProposalId !== input.refinementProposalId)
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
        const citationViews = await getExternalCitationViewsForMessages(
          tx,
          userId,
          returnedAssistant.status === "completed" ? [returnedAssistant.id] : [],
        );
        return {
          userMessage: toChatMessage(userMessage),
          assistantMessage: toChatMessage(
            returnedAssistant,
            citationViews.get(returnedAssistant.id) ?? [],
          ),
          replayed: true,
          generationClaimed,
        };
      }

      await requireProposalIntentAvailable(tx, {
        userId,
        nodeId: input.nodeId,
        proposalRequested: input.proposalRequested ?? false,
        refinementProposalId: input.refinementProposalId ?? null,
        publishedSynthesisVersionId: lockedNode.publishedSynthesisVersionId,
      });

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
            refinementProposalId: input.refinementProposalId ?? null,
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
      const lockedNode = await lockOwnedNode(tx, userId, input.nodeId);
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

      await requireProposalIntentAvailable(tx, {
        userId,
        nodeId: input.nodeId,
        proposalRequested: userMessage.proposalRequested,
        refinementProposalId: userMessage.refinementProposalId,
        publishedSynthesisVersionId: lockedNode.publishedSynthesisVersionId,
      });

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
  input: RetryChatTurnInput & {
    model: string;
    contextFingerprint: string;
    replaceExistingContext?: boolean;
  },
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
        !input.replaceExistingContext &&
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

export async function recordChatTurnSynthesisIntentForUser(
  userId: string,
  input: RetryChatTurnInput & { refinementProposalId: string | null },
) {
  try {
    await db.transaction(async (tx) => {
      const lockedNode = await lockOwnedNode(tx, userId, input.nodeId);
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
      if (assistantMessage.status !== "streaming") {
        throw new ChatServiceError("retry-unavailable");
      }
      if (userMessage.proposalRequested) {
        if (userMessage.refinementProposalId !== input.refinementProposalId) {
          throw new ChatServiceError("retry-unavailable");
        }
        return;
      }
      if (userMessage.refinementProposalId !== null) {
        throw new ChatServiceError("retry-unavailable");
      }
      await requireProposalIntentAvailable(tx, {
        userId,
        nodeId: input.nodeId,
        proposalRequested: true,
        refinementProposalId: input.refinementProposalId,
        publishedSynthesisVersionId: lockedNode.publishedSynthesisVersionId,
      });
      await tx
        .update(chatMessages)
        .set({
          proposalRequested: true,
          refinementProposalId: input.refinementProposalId,
          updatedAt: new Date(),
        })
        .where(eq(chatMessages.id, userMessage.id));
    });
  } catch (error) {
    throw sanitizeChatServiceError(error);
  }
}

export function recordChatTurnProviderResponseForUser(
  userId: string,
  input: RetryChatTurnInput & {
    providerResponseId: string;
    replaceExistingProviderResponse?: boolean;
  },
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
        !input.replaceExistingProviderResponse &&
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
  options: {
    proposal?: PendingSynthesisProposalInput;
    externalCitations?: ExternalCitationView[];
  } = {},
) {
  try {
    return await db.transaction(async (tx) => {
      const lockedNode = await lockOwnedNode(tx, userId, input.nodeId);
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

      const externalCitations = options.externalCitations ?? [];
      if (externalCitations.length > 0) {
        if (!userMessage.webSearchAuthorized) {
          throw new ChatServiceError("retry-unavailable");
        }
        const seenOccurrences = new Set<string>();
        for (const citation of externalCitations) {
          const occurrence = `${citation.ordinal}:${citation.startUtf16}:${citation.endUtf16}`;
          if (
            citation.kind !== "external" ||
            !Number.isSafeInteger(citation.ordinal) ||
            citation.ordinal < 1 ||
            citation.ordinal > 32 ||
            !Number.isSafeInteger(citation.startUtf16) ||
            citation.startUtf16 < 0 ||
            citation.endUtf16 !== citation.startUtf16 ||
            citation.endUtf16 > assistantMessage.content.length ||
            seenOccurrences.has(occurrence)
          ) {
            throw new ChatServiceError("retry-unavailable");
          }
          seenOccurrences.add(occurrence);
        }
        await tx.insert(citations).values(externalCitations.map((citation) => ({
          userId,
          ownerNodeId: input.nodeId,
          assistantMessageId: assistantMessage.id,
          synthesisVersionId: null,
          kind: "external" as const,
          ordinal: citation.ordinal,
          startUtf16: citation.startUtf16,
          endUtf16: citation.endUtf16,
          externalUrl: citation.url,
          externalTitle: citation.title,
        })));
      } else if (userMessage.webSearchAuthorized) {
        throw new ChatServiceError("retry-unavailable");
      }

      if (options.proposal) {
        if (
          !userMessage.proposalRequested ||
          userMessage.refinementProposalId !==
            (options.proposal.refinementProposalId ?? null) ||
          lockedNode.publishedSynthesisVersionId !== options.proposal.baseVersionId ||
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
      return toChatMessage(completed, externalCitations);
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
