import "server-only";

import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from "openai";
import { zodResponsesFunction } from "openai/helpers/zod";
import type {
  ResponseInput,
  ResponseCreateParamsStreaming,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";

import {
  OPENAI_CHAT_INSTRUCTIONS,
  OPENAI_CHAT_MAX_OUTPUT_TOKENS,
  OPENAI_CHAT_MODEL,
  OPENAI_CHAT_REASONING,
  OPENAI_CHAT_TIMEOUT_MS,
  OPENAI_SYNTHESIS_INSTRUCTIONS,
  OPENAI_SYNTHESIS_REASONING,
} from "@/lib/ai/openai-profiles";
import {
  MAX_ASSISTANT_MESSAGE_LENGTH,
  type ChatFailureCode,
} from "@/lib/chat/contracts";
import {
  synthesisProposalDraftSchema,
  type SynthesisProposalDraft,
} from "@/lib/synthesis/contracts";

const synthesisProposalTool = zodResponsesFunction({
  name: "propose_synthesis",
  description: "Create an approval-required replacement synthesis for the selected MindTree node.",
  parameters: synthesisProposalDraftSchema,
});

export type NormalizedOpenAIChatEvent =
  | { type: "started"; providerResponseId: string }
  | { type: "text-delta"; content: string }
  | {
      type: "completed";
      providerResponseId: string;
      proposal: SynthesisProposalDraft | null;
    };

export class OpenAIChatError extends Error {
  constructor(public readonly failureCode: ChatFailureCode) {
    super(failureCode);
    this.name = "OpenAIChatError";
  }
}

export class OpenAIChatAbortError extends Error {
  constructor() {
    super("chat generation aborted");
    this.name = "OpenAIChatAbortError";
  }
}

function requireResponseId(value: unknown) {
  if (typeof value !== "string" || value.length < 1 || value.length > 255) {
    throw new OpenAIChatError("response-invalid");
  }
  return value;
}

export async function* normalizeOpenAIChatEvents(
  events: AsyncIterable<ResponseStreamEvent>,
  options: { proposalRequested?: boolean } = {},
): AsyncGenerator<NormalizedOpenAIChatEvent> {
  let providerResponseId: string | null = null;
  let completedResponseId: string | null = null;
  let visibleCharacterCount = 0;
  let proposal: SynthesisProposalDraft | null = null;

  for await (const event of events) {
    if (completedResponseId !== null) {
      throw new OpenAIChatError("response-invalid");
    }
    switch (event.type) {
      case "response.created": {
        if (providerResponseId !== null) {
          throw new OpenAIChatError("response-invalid");
        }
        providerResponseId = requireResponseId(event.response.id);
        yield { type: "started", providerResponseId };
        break;
      }
      case "response.output_text.delta": {
        if (providerResponseId === null || typeof event.delta !== "string") {
          throw new OpenAIChatError("response-invalid");
        }
        if (event.delta.length > 0) {
          if (
            visibleCharacterCount + event.delta.length >
            MAX_ASSISTANT_MESSAGE_LENGTH
          ) {
            throw new OpenAIChatError("response-invalid");
          }
          visibleCharacterCount += event.delta.length;
          yield { type: "text-delta", content: event.delta };
        }
        break;
      }
      case "response.refusal.delta":
      case "response.refusal.done":
        throw new OpenAIChatError("provider-refusal");
      case "response.incomplete":
        throw new OpenAIChatError("response-invalid");
      case "response.failed":
      case "error":
        throw new OpenAIChatError("generation-failed");
      case "response.completed": {
        const candidateResponseId = requireResponseId(event.response.id);
        if (
          providerResponseId === null ||
          candidateResponseId !== providerResponseId ||
          event.response.status !== "completed" ||
          visibleCharacterCount === 0 ||
          !Array.isArray(event.response.output)
        ) {
          throw new OpenAIChatError("response-invalid");
        }
        const functionCalls = [];
        for (const item of event.response.output) {
          if (item.type === "function_call") {
            if (item.status !== "completed") {
              throw new OpenAIChatError("response-invalid");
            }
            functionCalls.push(item);
          } else if (item.type === "message") {
            if (item.status !== "completed") {
              throw new OpenAIChatError("response-invalid");
            }
            if (item.content.some((content) => content.type === "refusal")) {
              throw new OpenAIChatError("provider-refusal");
            }
          } else if (item.type !== "reasoning") {
            throw new OpenAIChatError("response-invalid");
          }
        }
        if (!options.proposalRequested && functionCalls.length > 0) {
          throw new OpenAIChatError("response-invalid");
        }
        if (functionCalls.length > 1) {
          throw new OpenAIChatError("response-invalid");
        }
        const functionCall = functionCalls[0];
        if (functionCall) {
          if (functionCall.name !== "propose_synthesis") {
            throw new OpenAIChatError("response-invalid");
          }
          try {
            proposal = synthesisProposalDraftSchema.parse(
              JSON.parse(functionCall.arguments),
            );
          } catch {
            throw new OpenAIChatError("response-invalid");
          }
        }
        completedResponseId = candidateResponseId;
        break;
      }
      default:
        break;
    }
  }

  if (completedResponseId === null || providerResponseId === null) {
    throw new OpenAIChatError("response-invalid");
  }
  yield { type: "completed", providerResponseId, proposal };
}

export function createOpenAIChatRequest(input: {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  proposalRequested?: boolean;
  safetyIdentifier: string;
}): ResponseCreateParamsStreaming {
  const proposalRequested = input.proposalRequested ?? false;
  return {
    model: OPENAI_CHAT_MODEL,
    instructions: proposalRequested
      ? OPENAI_SYNTHESIS_INSTRUCTIONS
      : OPENAI_CHAT_INSTRUCTIONS,
    input: input.messages satisfies ResponseInput,
    max_output_tokens: OPENAI_CHAT_MAX_OUTPUT_TOKENS,
    reasoning: proposalRequested
      ? OPENAI_SYNTHESIS_REASONING
      : OPENAI_CHAT_REASONING,
    safety_identifier: input.safetyIdentifier,
    store: false,
    stream: true,
    tools: proposalRequested ? [synthesisProposalTool] : [],
    tool_choice: proposalRequested ? "auto" : undefined,
    parallel_tool_calls: false,
  };
}

export function classifyOpenAIChatSDKError(
  error: unknown,
  signal: AbortSignal,
): Error {
  if (signal.aborted) {
    return new OpenAIChatAbortError();
  }
  if (error instanceof OpenAIChatError || error instanceof OpenAIChatAbortError) {
    return error;
  }
  if (error instanceof APIUserAbortError) {
    return new OpenAIChatAbortError();
  }
  if (error instanceof APIConnectionTimeoutError) {
    return new OpenAIChatError("provider-timeout");
  }
  if (error instanceof APIConnectionError) {
    return new OpenAIChatError("stream-disconnected");
  }
  if (
    error instanceof APIError &&
    error.status === 408
  ) {
    return new OpenAIChatError("provider-timeout");
  }
  if (
    error instanceof APIError &&
    (error.status === 401 ||
      error.status === 403 ||
      error.status === 404 ||
      error.status === 429 ||
      (typeof error.status === "number" && error.status >= 500))
  ) {
    return new OpenAIChatError("assistant-unavailable");
  }
  return new OpenAIChatError("generation-failed");
}

export async function* streamOpenAIChat(input: {
  apiKey: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  proposalRequested?: boolean;
  safetyIdentifier: string;
  signal: AbortSignal;
}): AsyncGenerator<NormalizedOpenAIChatEvent> {
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
  const providerSignal = AbortSignal.any([
    input.signal,
    deadlineController.signal,
  ]);

  try {
    const stream = await client.responses.create(
      createOpenAIChatRequest(input),
      { signal: providerSignal },
    );
    for await (const event of normalizeOpenAIChatEvents(stream, {
      proposalRequested: input.proposalRequested,
    })) {
      if (input.signal.aborted) {
        throw new OpenAIChatAbortError();
      }
      if (deadlineExceeded) {
        throw new OpenAIChatError("provider-timeout");
      }
      if (event.type === "completed") {
        clearTimeout(deadline);
      }
      yield event;
    }
  } catch (error) {
    if (input.signal.aborted) {
      throw new OpenAIChatAbortError();
    }
    if (deadlineExceeded && !input.signal.aborted) {
      throw new OpenAIChatError("provider-timeout");
    }
    throw classifyOpenAIChatSDKError(error, input.signal);
  } finally {
    clearTimeout(deadline);
  }
}
