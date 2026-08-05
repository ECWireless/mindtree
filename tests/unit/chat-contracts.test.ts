import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createChatTurnInputSchema,
  failChatTurnInputSchema,
  MAX_USER_MESSAGE_LENGTH,
  retryChatTurnInputSchema,
} from "@/lib/chat/contracts";

describe("chat contracts", () => {
  it("normalizes a bounded user turn and defaults web authorization off", () => {
    const input = createChatTurnInputSchema.parse({
      nodeId: randomUUID(),
      clientMessageId: randomUUID(),
      content: "  Develop this thought.  ",
    });

    expect(input).toMatchObject({
      content: "Develop this thought.",
      webSearchAuthorized: false,
      proposalRequested: false,
    });
  });

  it("rejects empty, oversized, and malformed turn input", () => {
    const base = { nodeId: randomUUID(), clientMessageId: randomUUID() };

    expect(createChatTurnInputSchema.safeParse({ ...base, content: "   " }).success).toBe(false);
    expect(
      createChatTurnInputSchema.safeParse({
        ...base,
        content: "x".repeat(MAX_USER_MESSAGE_LENGTH + 1),
      }).success,
    ).toBe(false);
    expect(
      retryChatTurnInputSchema.safeParse({ nodeId: "not-a-node", clientMessageId: randomUUID() })
        .success,
    ).toBe(false);
  });

  it("accepts only bounded stable failure codes", () => {
    const base = {
      nodeId: randomUUID(),
      clientMessageId: randomUUID(),
    };

    expect(failChatTurnInputSchema.safeParse({ ...base, failureCode: "provider-timeout" }).success)
      .toBe(true);
    expect(failChatTurnInputSchema.safeParse({ ...base, failureCode: "Raw provider error!" }).success)
      .toBe(false);
    expect(failChatTurnInputSchema.safeParse({ ...base, failureCode: "provider-request-id" }).success)
      .toBe(false);
  });
});
