import "server-only";

import { getServerEnvironment } from "@/lib/env/server";
import { getChatGenerationMode, type ChatGenerationMode } from "@/lib/server/chat-runtime";
import {
  OpenAIBranchOutlineAbortError,
  streamOpenAIBranchOutline,
  type NormalizedOpenAIBranchOutlineEvent,
} from "@/lib/server/openai-branch-outline";

export type BranchOutlineGenerationMode = ChatGenerationMode;

export function getBranchOutlineGenerationMode(
  environment: Record<string, string | undefined> = process.env,
): BranchOutlineGenerationMode {
  return getChatGenerationMode(environment);
}

export function isBranchOutlineGenerationEnabled(
  environment: Record<string, string | undefined> = process.env,
) {
  return getBranchOutlineGenerationMode(environment) !== "unavailable";
}

async function* streamDeterministicBranchOutlineFixture(input: {
  messages: Array<{ role: "user"; content: string }>;
  signal: AbortSignal;
}): AsyncGenerator<NormalizedOpenAIBranchOutlineEvent> {
  const context = input.messages[0]?.content ?? "";
  const serialized = context.slice(context.indexOf("\n") + 1);
  const parsed = JSON.parse(serialized) as {
    directChildren?: Array<{
      approvedSummary?: unknown;
      recursiveRelationshipContext?: unknown;
    }>;
  };
  const children = Array.isArray(parsed.directChildren) ? parsed.directChildren : [];
  const providerResponseId = "fixture-branch-outline-response";
  const chunks = [JSON.stringify({
    items: children.map((child, index) => {
      const hasSummary = typeof child.approvedSummary === "string";
      const hasRelationships = typeof child.recursiveRelationshipContext === "string";
      const description = hasSummary && hasRelationships
        ? "Synthesizes its core idea and how its deeper branch relates."
        : hasSummary
          ? "Condenses the child's core idea into this branch."
          : hasRelationships
            ? "Connects this child to its recursively summarized branch."
            : "Represents this direct child without adding unsupported detail.";
      return { ordinal: index + 1, description };
    }),
  })];
  yield { type: "started", providerResponseId };
  let content = "";
  for (const chunk of chunks) {
    if (input.signal.aborted) throw new OpenAIBranchOutlineAbortError();
    content += chunk;
    yield { type: "text-delta", content: chunk };
  }
  yield { type: "completed", providerResponseId, content };
}

export function streamBranchOutlineResponse(input: {
  messages: Array<{ role: "user"; content: string }>;
  safetyIdentifier: string;
  signal: AbortSignal;
}): AsyncGenerator<NormalizedOpenAIBranchOutlineEvent> {
  const mode = getBranchOutlineGenerationMode();
  if (mode === "deterministic-fixture") {
    return streamDeterministicBranchOutlineFixture(input);
  }
  if (mode === "openai") {
    const environment = getServerEnvironment(["openai"]);
    return streamOpenAIBranchOutline({
      apiKey: environment.OPENAI_API_KEY,
      ...input,
    });
  }
  throw new Error("Branch Outline generation is unavailable");
}
