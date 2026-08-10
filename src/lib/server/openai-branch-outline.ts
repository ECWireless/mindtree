import "server-only";

import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from "openai";
import type {
  ResponseCreateParamsStreaming,
  ResponseInput,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";

import {
  OPENAI_BRANCH_OUTLINE_INSTRUCTIONS,
  OPENAI_CHAT_MAX_OUTPUT_TOKENS,
  OPENAI_CHAT_TIMEOUT_MS,
  OPENAI_SYNTHESIS_MODEL,
  OPENAI_SYNTHESIS_REASONING,
} from "@/lib/ai/openai-profiles";
import type { BranchOutlineFailureCode } from "@/lib/branch-outlines/contracts";
import { MAX_BRANCH_OUTLINE_CONTENT_LENGTH } from "@/lib/branch-outlines/contracts";

type ProviderFailureCode = Exclude<BranchOutlineFailureCode, "inputs-changed">;

export type NormalizedOpenAIBranchOutlineEvent =
  | { type: "started"; providerResponseId: string }
  | { type: "text-delta"; content: string }
  | { type: "completed"; providerResponseId: string; content: string };

export class OpenAIBranchOutlineError extends Error {
  constructor(public readonly failureCode: ProviderFailureCode) {
    super(failureCode);
    this.name = "OpenAIBranchOutlineError";
  }
}

export class OpenAIBranchOutlineAbortError extends Error {
  constructor() {
    super("Branch Outline generation aborted");
    this.name = "OpenAIBranchOutlineAbortError";
  }
}

function requireResponseId(value: unknown) {
  if (typeof value !== "string" || value.length < 1 || value.length > 255) {
    throw new OpenAIBranchOutlineError("response-invalid");
  }
  return value;
}

export async function* normalizeOpenAIBranchOutlineEvents(
  events: AsyncIterable<ResponseStreamEvent>,
): AsyncGenerator<NormalizedOpenAIBranchOutlineEvent> {
  let providerResponseId: string | null = null;
  let completedResponseId: string | null = null;
  let visibleContent = "";

  for await (const event of events) {
    if (completedResponseId !== null) {
      throw new OpenAIBranchOutlineError("response-invalid");
    }
    switch (event.type) {
      case "response.created":
        if (providerResponseId !== null) {
          throw new OpenAIBranchOutlineError("response-invalid");
        }
        providerResponseId = requireResponseId(event.response.id);
        yield { type: "started", providerResponseId };
        break;
      case "response.output_text.delta":
        if (providerResponseId === null || typeof event.delta !== "string") {
          throw new OpenAIBranchOutlineError("response-invalid");
        }
        if (visibleContent.length + event.delta.length > MAX_BRANCH_OUTLINE_CONTENT_LENGTH) {
          throw new OpenAIBranchOutlineError("response-invalid");
        }
        if (event.delta.length > 0) {
          visibleContent += event.delta;
          yield { type: "text-delta", content: event.delta };
        }
        break;
      case "response.refusal.delta":
      case "response.refusal.done":
        throw new OpenAIBranchOutlineError("provider-refusal");
      case "response.incomplete":
        throw new OpenAIBranchOutlineError("response-invalid");
      case "response.failed":
      case "error":
        throw new OpenAIBranchOutlineError("generation-failed");
      case "response.completed": {
        const candidateResponseId = requireResponseId(event.response.id);
        if (
          providerResponseId === null ||
          candidateResponseId !== providerResponseId ||
          event.response.status !== "completed" ||
          !Array.isArray(event.response.output)
        ) {
          throw new OpenAIBranchOutlineError("response-invalid");
        }
        let completedContent = "";
        for (const item of event.response.output) {
          if (item.type === "reasoning") continue;
          if (item.type !== "message" || item.status !== "completed") {
            throw new OpenAIBranchOutlineError("response-invalid");
          }
          for (const content of item.content) {
            if (content.type === "refusal") {
              throw new OpenAIBranchOutlineError("provider-refusal");
            }
            if (content.type !== "output_text") {
              throw new OpenAIBranchOutlineError("response-invalid");
            }
            completedContent += content.text;
          }
        }
        if (completedContent !== visibleContent || completedContent.length === 0) {
          throw new OpenAIBranchOutlineError("response-invalid");
        }
        completedResponseId = candidateResponseId;
        break;
      }
      default:
        break;
    }
  }

  if (completedResponseId === null || providerResponseId === null) {
    throw new OpenAIBranchOutlineError("response-invalid");
  }
  yield {
    type: "completed",
    providerResponseId,
    content: visibleContent,
  };
}

export function createOpenAIBranchOutlineRequest(input: {
  messages: Array<{ role: "user"; content: string }>;
  safetyIdentifier: string;
}): ResponseCreateParamsStreaming {
  return {
    model: OPENAI_SYNTHESIS_MODEL,
    instructions: OPENAI_BRANCH_OUTLINE_INSTRUCTIONS,
    input: input.messages satisfies ResponseInput,
    max_output_tokens: OPENAI_CHAT_MAX_OUTPUT_TOKENS,
    reasoning: OPENAI_SYNTHESIS_REASONING,
    safety_identifier: input.safetyIdentifier,
    store: false,
    stream: true,
  };
}

export function classifyOpenAIBranchOutlineSDKError(
  error: unknown,
  signal: AbortSignal,
): Error {
  if (signal.aborted || error instanceof APIUserAbortError) {
    return new OpenAIBranchOutlineAbortError();
  }
  if (
    error instanceof OpenAIBranchOutlineError ||
    error instanceof OpenAIBranchOutlineAbortError
  ) {
    return error;
  }
  if (error instanceof APIConnectionTimeoutError) {
    return new OpenAIBranchOutlineError("provider-timeout");
  }
  if (error instanceof APIConnectionError) {
    return new OpenAIBranchOutlineError("stream-disconnected");
  }
  if (error instanceof APIError && error.status === 408) {
    return new OpenAIBranchOutlineError("provider-timeout");
  }
  return new OpenAIBranchOutlineError("generation-failed");
}

export async function* streamOpenAIBranchOutline(input: {
  apiKey: string;
  messages: Array<{ role: "user"; content: string }>;
  safetyIdentifier: string;
  signal: AbortSignal;
}): AsyncGenerator<NormalizedOpenAIBranchOutlineEvent> {
  const client = new OpenAI({
    apiKey: input.apiKey,
    maxRetries: 0,
    timeout: OPENAI_CHAT_TIMEOUT_MS,
  });
  const deadlineController = new AbortController();
  let deadlineExceeded = false;
  const deadline = setTimeout(() => {
    deadlineExceeded = true;
    deadlineController.abort();
  }, OPENAI_CHAT_TIMEOUT_MS);
  const providerSignal = AbortSignal.any([input.signal, deadlineController.signal]);

  try {
    const stream = await client.responses.create(
      createOpenAIBranchOutlineRequest(input),
      { signal: providerSignal },
    );
    for await (const event of normalizeOpenAIBranchOutlineEvents(stream)) {
      if (input.signal.aborted) throw new OpenAIBranchOutlineAbortError();
      if (deadlineExceeded) throw new OpenAIBranchOutlineError("provider-timeout");
      if (event.type === "completed") clearTimeout(deadline);
      yield event;
    }
  } catch (error) {
    if (input.signal.aborted) throw new OpenAIBranchOutlineAbortError();
    if (deadlineExceeded) throw new OpenAIBranchOutlineError("provider-timeout");
    throw classifyOpenAIBranchOutlineSDKError(error, input.signal);
  } finally {
    clearTimeout(deadline);
  }
}
