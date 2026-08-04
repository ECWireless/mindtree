import "server-only";

import { createHmac } from "node:crypto";

import { getServerEnvironment } from "@/lib/env/server";
import {
  OpenAIChatAbortError,
  streamOpenAIChat,
  type NormalizedOpenAIChatEvent,
} from "@/lib/server/openai-chat";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
type ChatEnvironment = Record<string, string | undefined>;

export type ChatGenerationMode = "deterministic-fixture" | "openai" | "unavailable";

export function isDeterministicChatFixtureEnabled(
  environment: ChatEnvironment = process.env,
) {
  if (
    environment.NODE_ENV === "production" ||
    environment.MINDTREE_TEST_CHAT_FIXTURE !== "1" ||
    !environment.BETTER_AUTH_URL
  ) {
    return false;
  }

  try {
    return LOOPBACK_HOSTS.has(new URL(environment.BETTER_AUTH_URL).hostname);
  } catch {
    return false;
  }
}

export function getChatGenerationMode(
  environment: ChatEnvironment = process.env,
): ChatGenerationMode {
  if (isDeterministicChatFixtureEnabled(environment)) {
    return "deterministic-fixture";
  }
  if (environment.OPENAI_API_KEY?.trim()) {
    return "openai";
  }
  return "unavailable";
}

export function isChatGenerationEnabled(environment: ChatEnvironment = process.env) {
  return getChatGenerationMode(environment) !== "unavailable";
}

export function createOpenAISafetyIdentifier(userId: string, authSecret: string) {
  return `mt_${createHmac("sha256", authSecret)
    .update(`mindtree-openai-safety:v1:${userId}`, "utf8")
    .digest("base64url")}`;
}

async function* streamDeterministicChatFixture(input: {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  signal: AbortSignal;
}): AsyncGenerator<NormalizedOpenAIChatEvent> {
  const topic = [...input.messages]
    .reverse()
    .find(({ role }) => role === "user")
    ?.content.trim().replace(/\s+/g, " ").slice(0, 80) ?? "This thought";
  const providerResponseId = "fixture-response";
  const chunks = [
    "Here’s one way to develop that thought:\n\n",
    `**${topic}** can become clearer by separating the observation from the question it raises. `,
    "What evidence would change your view?",
  ];

  yield { type: "started", providerResponseId };
  for (const content of chunks) {
    if (input.signal.aborted) {
      throw new OpenAIChatAbortError();
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
    yield { type: "text-delta", content };
  }
  yield { type: "completed", providerResponseId };
}

export function streamChatResponse(input: {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  safetyIdentifier: string;
  signal: AbortSignal;
}): AsyncGenerator<NormalizedOpenAIChatEvent> {
  const mode = getChatGenerationMode();
  if (mode === "deterministic-fixture") {
    return streamDeterministicChatFixture(input);
  }
  if (mode === "openai") {
    const environment = getServerEnvironment(["openai"]);
    return streamOpenAIChat({
      apiKey: environment.OPENAI_API_KEY,
      messages: input.messages,
      safetyIdentifier: input.safetyIdentifier,
      signal: input.signal,
    });
  }
  throw new Error("chat generation is unavailable");
}
