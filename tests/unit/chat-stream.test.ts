import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CHAT_STREAM_HEARTBEAT_MS,
  scheduleChatStreamHeartbeats,
} from "../../src/lib/server/chat-stream";

describe("chat stream heartbeats", () => {
  afterEach(() => vi.useRealTimers());

  it("emits bounded protocol heartbeats until stopped", () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const stop = scheduleChatStreamHeartbeats(emit);

    vi.advanceTimersByTime(CHAT_STREAM_HEARTBEAT_MS * 2);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenLastCalledWith({ type: "heartbeat" });

    stop();
    vi.advanceTimersByTime(CHAT_STREAM_HEARTBEAT_MS);
    expect(emit).toHaveBeenCalledTimes(2);
  });
});
