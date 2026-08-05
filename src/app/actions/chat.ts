"use server";

import {
  loadChatMessagesInputSchema,
  retryChatTurnInputSchema,
  type ChatMessage,
  type ChatMessagePage,
} from "@/lib/chat/contracts";
import { requireAuthorizedSession } from "@/lib/server/authorization";
import {
  ChatServiceError,
  getChatMessagesForUser,
  getChatTurnForUser,
} from "@/lib/server/chat-service";
import { getSynthesisWorkspaceForUser } from "@/lib/server/synthesis-service";
import type { SynthesisDecisionSummary } from "@/lib/synthesis/contracts";

export type LoadChatMessagesResult =
  | { ok: true; page: ChatMessagePage; decisions: SynthesisDecisionSummary[] }
  | { ok: false; message: string };

export async function loadChatMessages(input: unknown): Promise<LoadChatMessagesResult> {
  const session = await requireAuthorizedSession();
  const parsed = loadChatMessagesInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: "Older messages could not be loaded." };
  }

  try {
    const page = await getChatMessagesForUser(session.user.id, parsed.data);
    const workspace = await getSynthesisWorkspaceForUser(
      session.user.id,
      parsed.data.nodeId,
      {
        generatingMessageIds: page.messages
          .filter((message) => message.role === "assistant")
          .map((message) => message.id),
      },
    );
    return { ok: true, page, decisions: workspace.history };
  } catch (error) {
    if (error instanceof ChatServiceError) {
      return { ok: false, message: "Older messages could not be loaded." };
    }
    throw error;
  }
}

export type LoadChatTurnResult =
  | { ok: true; messages: ChatMessage[] }
  | { ok: false; message: string };

export async function loadChatTurn(input: unknown): Promise<LoadChatTurnResult> {
  const session = await requireAuthorizedSession();
  const parsed = retryChatTurnInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "The message state could not be refreshed." };

  try {
    const messages = await getChatTurnForUser(session.user.id, parsed.data);
    return { ok: true, messages };
  } catch (error) {
    if (error instanceof ChatServiceError) {
      return { ok: false, message: "The message state could not be refreshed." };
    }
    throw error;
  }
}
