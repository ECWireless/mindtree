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
  const childCount = (context.match(/\"title\":/g)?.length ?? 1) - 1;
  const providerResponseId = "fixture-branch-outline-response";
  const chunks = [
    "## Branch direction\n\n",
    childCount > 0
      ? `- Connect the ${childCount} direct child ${childCount === 1 ? "thread" : "threads"}.\n`
      : "- Develop the current thought before adding child threads.\n",
    "- Preserve open questions and missing evidence.",
  ];
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
