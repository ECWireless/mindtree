import type { ChatStreamEvent } from "@/lib/chat/contracts";

export const CHAT_STREAM_HEARTBEAT_MS = 10_000;

export function scheduleChatStreamHeartbeats(
  emit: (event: Extract<ChatStreamEvent, { type: "heartbeat" }>) => void,
  intervalMs = CHAT_STREAM_HEARTBEAT_MS,
) {
  const timer = setInterval(() => emit({ type: "heartbeat" }), intervalMs);
  return () => clearInterval(timer);
}
