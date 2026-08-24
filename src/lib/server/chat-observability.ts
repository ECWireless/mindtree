import type { ChatFailureCode } from "@/lib/chat/contracts";
import type { OpenAIChatDiagnosticReason } from "@/lib/server/openai-chat";

export type ChatGenerationPhase = "preparation" | "conversation" | "synthesis";
const MAX_CHAT_GENERATION_LOG_ELAPSED_MS = 24 * 60 * 60 * 1_000;

export function buildChatGenerationFailureLog(input: {
  failureCode: ChatFailureCode;
  diagnosticReason: OpenAIChatDiagnosticReason | null;
  phase: ChatGenerationPhase;
  webSearchAuthorized: boolean;
  externalPdfAttached: boolean;
  providerResponseRecorded: boolean;
  elapsedMs: number;
}) {
  return {
    event: "chat_generation_failed" as const,
    failureCode: input.failureCode,
    diagnosticReason: input.diagnosticReason,
    phase: input.phase,
    webSearchAuthorized: input.webSearchAuthorized,
    externalPdfAttached: input.externalPdfAttached,
    providerResponseRecorded: input.providerResponseRecorded,
    elapsedMs: Number.isFinite(input.elapsedMs)
      ? Math.min(
          MAX_CHAT_GENERATION_LOG_ELAPSED_MS,
          Math.max(0, Math.round(input.elapsedMs)),
        )
      : 0,
  };
}

export function logChatGenerationFailure(
  input: Parameters<typeof buildChatGenerationFailureLog>[0],
  environment: NodeJS.ProcessEnv = process.env,
) {
  if (environment.NODE_ENV === "test") return;
  console.warn(JSON.stringify(buildChatGenerationFailureLog(input)));
}
