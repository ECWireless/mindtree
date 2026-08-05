import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  createOpenAISafetyIdentifier,
  getChatGenerationMode,
  isChatGenerationEnabled,
  isDeterministicChatFixtureEnabled,
} from "@/lib/server/chat-runtime";

describe("deterministic chat fixture gate", () => {
  it("requires an explicit non-production loopback configuration", () => {
    expect(isDeterministicChatFixtureEnabled({
      NODE_ENV: "test",
      MINDTREE_TEST_CHAT_FIXTURE: "1",
      BETTER_AUTH_URL: "http://127.0.0.1:3188",
    })).toBe(true);
    expect(isDeterministicChatFixtureEnabled({
      NODE_ENV: "production",
      MINDTREE_TEST_CHAT_FIXTURE: "1",
      BETTER_AUTH_URL: "http://127.0.0.1:3188",
    })).toBe(false);
    expect(isDeterministicChatFixtureEnabled({
      NODE_ENV: "test",
      MINDTREE_TEST_CHAT_FIXTURE: "1",
      BETTER_AUTH_URL: "https://mindtree.example.test",
    })).toBe(false);
    expect(isDeterministicChatFixtureEnabled({
      NODE_ENV: "test",
      BETTER_AUTH_URL: "http://localhost:3188",
    })).toBe(false);
  });

  it("selects the fixture before OpenAI and otherwise requires a non-empty key", () => {
    expect(getChatGenerationMode({
      NODE_ENV: "test",
      MINDTREE_TEST_CHAT_FIXTURE: "1",
      BETTER_AUTH_URL: "http://localhost:3188",
      OPENAI_API_KEY: "synthetic-key",
    })).toBe("deterministic-fixture");
    expect(getChatGenerationMode({ OPENAI_API_KEY: "synthetic-key" })).toBe("openai");
    expect(getChatGenerationMode({ OPENAI_API_KEY: "   " })).toBe("unavailable");
    expect(isChatGenerationEnabled({ OPENAI_API_KEY: "synthetic-key" })).toBe(true);
    expect(isChatGenerationEnabled({})).toBe(false);
  });

  it("derives a stable opaque safety identifier without exposing the owner id", () => {
    const first = createOpenAISafetyIdentifier("owner@example.test", "synthetic-auth-secret");
    const second = createOpenAISafetyIdentifier("owner@example.test", "synthetic-auth-secret");
    const other = createOpenAISafetyIdentifier("other@example.test", "synthetic-auth-secret");

    expect(first).toBe(second);
    expect(first).not.toBe(other);
    expect(first).toMatch(/^mt_[A-Za-z0-9_-]{43}$/);
    expect(first).not.toContain("owner");
  });
});
