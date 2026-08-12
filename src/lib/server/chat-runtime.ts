import "server-only";

import { createHmac } from "node:crypto";

import { getServerEnvironment } from "@/lib/env/server";
import {
  OpenAIChatAbortError,
  OpenAIChatError,
  streamOpenAIChat,
  type NormalizedOpenAIChatEvent,
  type OpenAIChatPhase,
} from "@/lib/server/openai-chat";
import type { ExternalPdfSource } from "@/lib/server/external-pdf-source";

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
  phase: OpenAIChatPhase;
  signal: AbortSignal;
  webSearchAuthorized: boolean;
  externalPdfSource?: ExternalPdfSource | null;
}): AsyncGenerator<NormalizedOpenAIChatEvent> {
  const topic = [...input.messages]
    .reverse()
    .find(({ role }) => role === "user")
    ?.content.trim().replace(/\s+/g, " ").slice(0, 80) ?? "This thought";
  const synthesisTopic = topic.replace(/https?:\/\/\S+/giu, "the supplied source");
  const providerResponseId = "fixture-response";
  const hasPendingProposal = input.messages[0]?.content.includes(
    '"refinementProposal":{"state":"pending"',
  ) ?? false;
  const synthesisRequested = /\b(synthesis|synthesize|synthesise)\b/i.test(topic) ||
    (hasPendingProposal && /\b(shorter|longer|refine|revise|rewrite|emphasi[sz]e|change|update)\b/i.test(topic));
  const chunks = [
    "Here’s one way to develop that thought:\n\n",
    `**${topic}** can become clearer by separating the observation from the question it raises. `,
    "What evidence would change your view?",
  ];
  const chunkDelayMs = topic === "Keep this fixture response open" ||
    topic === "Propose a synthesis while Chat is closed"
    ? 1_000
    : 80;

  yield { type: "started", providerResponseId };
  if (input.phase === "conversation" && input.webSearchAuthorized) {
    const content = input.externalPdfSource
      ? `Reading **${topic}** found a supported synthetic PDF claim.`
      : `Researching **${topic}** found a current synthetic source.`;
    yield { type: "research-status", status: "searching" };
    if (topic === "Research an unverifiable synthetic source") {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (input.signal.aborted) {
        throw new OpenAIChatAbortError();
      }
      throw new OpenAIChatError("response-invalid");
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    if (input.signal.aborted) {
      throw new OpenAIChatAbortError();
    }
    yield { type: "text-delta", content };
    yield {
      type: "completed",
      providerResponseId,
      synthesisRequested,
      proposal: null,
      externalCitations: [{
        kind: "external",
        ordinal: 1,
        startUtf16: content.length,
        endUtf16: content.length,
        title: input.externalPdfSource?.title ?? "Synthetic research source",
        url: input.externalPdfSource?.url ?? "https://example.test/research",
      }],
    };
    return;
  }
  if (input.phase === "conversation" && synthesisRequested) {
    yield {
      type: "completed",
      providerResponseId,
      synthesisRequested: true,
      proposal: null,
    };
    return;
  }
  for (const content of chunks) {
    if (input.signal.aborted) {
      throw new OpenAIChatAbortError();
    }
    await new Promise((resolve) => setTimeout(resolve, chunkDelayMs));
    yield { type: "text-delta", content };
  }
  yield {
    type: "completed",
    providerResponseId,
    synthesisRequested: false,
    proposal: input.phase === "synthesis"
      ? {
          content: `# ${synthesisTopic}\n\nA concise synthetic synthesis proposal.`,
          citations: [],
          externalCitations: input.messages.some(({ content }) =>
            content.includes('"externalResearchEvidence"')
          )
            ? [{
                sourceAlias: "W1",
                citedText: "A concise synthetic synthesis proposal.",
              }]
            : [],
        }
      : null,
  };
}

export function streamChatResponse(input: {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  phase: OpenAIChatPhase;
  safetyIdentifier: string;
  signal: AbortSignal;
  webSearchAuthorized?: boolean;
  externalPdfSource?: ExternalPdfSource | null;
}): AsyncGenerator<NormalizedOpenAIChatEvent> {
  const mode = getChatGenerationMode();
  if (mode === "deterministic-fixture") {
    return streamDeterministicChatFixture({
      ...input,
      webSearchAuthorized: input.webSearchAuthorized === true,
      externalPdfSource: input.externalPdfSource,
    });
  }
  if (mode === "openai") {
    const environment = getServerEnvironment(["openai"]);
    return streamOpenAIChat({
      apiKey: environment.OPENAI_API_KEY,
      messages: input.messages,
      phase: input.phase,
      safetyIdentifier: input.safetyIdentifier,
      signal: input.signal,
      webSearchAuthorized: input.webSearchAuthorized,
      externalPdfSource: input.externalPdfSource,
    });
  }
  throw new Error("chat generation is unavailable");
}
