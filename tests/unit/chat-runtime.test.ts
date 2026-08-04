import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { isDeterministicChatFixtureEnabled } from "@/lib/server/chat-runtime";

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
});
