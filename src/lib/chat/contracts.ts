import { z } from "zod";

export const CHAT_PAGE_SIZE = 50;
export const MAX_USER_MESSAGE_LENGTH = 16_000;
export const MAX_ASSISTANT_MESSAGE_LENGTH = 64_000;

export const chatRoleSchema = z.enum(["user", "assistant"]);
export const chatStatusSchema = z.enum([
  "pending",
  "streaming",
  "completed",
  "failed",
  "cancelled",
]);
export const chatFailureCodeSchema = z.enum([
  "assistant-unavailable",
  "generation-failed",
  "provider-refusal",
  "provider-timeout",
  "response-invalid",
  "stream-disconnected",
]);

export const createChatTurnInputSchema = z.object({
  nodeId: z.uuid(),
  clientMessageId: z.uuid(),
  content: z.string().trim().min(1).max(MAX_USER_MESSAGE_LENGTH),
  webSearchAuthorized: z.boolean().default(false),
}).strict();

export const retryChatTurnInputSchema = z.object({
  nodeId: z.uuid(),
  clientMessageId: z.uuid(),
});

export const failChatTurnInputSchema = retryChatTurnInputSchema.extend({
  failureCode: chatFailureCodeSchema,
});

export const loadChatMessagesInputSchema = z.object({
  nodeId: z.uuid(),
  cursor: z.string().min(1).max(128).optional(),
});

export type ChatRole = z.infer<typeof chatRoleSchema>;
export type ChatStatus = z.infer<typeof chatStatusSchema>;
export type ChatFailureCode = z.infer<typeof chatFailureCodeSchema>;
type ParsedCreateChatTurnInput = z.infer<typeof createChatTurnInputSchema>;
export type CreateChatTurnInput = ParsedCreateChatTurnInput & {
  proposalRequested?: boolean;
  refinementProposalId?: string | null;
};
export type RetryChatTurnInput = z.infer<typeof retryChatTurnInputSchema>;
export type FailChatTurnInput = z.infer<typeof failChatTurnInputSchema>;
export type LoadChatMessagesInput = z.infer<typeof loadChatMessagesInputSchema>;

export type ChatStreamEvent =
  | { type: "turn"; userMessage: ChatMessage; assistantMessage: ChatMessage }
  | { type: "delta"; content: string }
  | { type: "completed"; assistantMessage: ChatMessage; proposalCreated: boolean }
  | { type: "failed"; assistantMessage: ChatMessage }
  | { type: "cancelled"; assistantMessage: ChatMessage };

export type ChatMessage = {
  id: string;
  nodeId: string;
  clientMessageId: string;
  role: ChatRole;
  status: ChatStatus;
  content: string;
  model: string | null;
  providerResponseId: string | null;
  failureCode: string | null;
  webSearchAuthorized: boolean;
  proposalRequested: boolean;
  refinementProposalId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type ChatMessagePage = {
  messages: ChatMessage[];
  nextCursor: string | null;
};
