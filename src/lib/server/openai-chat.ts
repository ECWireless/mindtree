import "server-only";

import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from "openai";
import { zodResponsesFunction } from "openai/helpers/zod";
import { z } from "zod";
import type {
  ResponseInput,
  ResponseCreateParamsStreaming,
  ResponseOutputText,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";

import {
  OPENAI_CHAT_INSTRUCTIONS,
  OPENAI_CHAT_MAX_OUTPUT_TOKENS,
  OPENAI_CHAT_MODEL,
  OPENAI_CHAT_REASONING,
  OPENAI_CHAT_TIMEOUT_MS,
  OPENAI_PDF_RESEARCH_INSTRUCTIONS,
  OPENAI_RESEARCH_INSTRUCTIONS,
  OPENAI_RESEARCH_REASONING,
  OPENAI_SYNTHESIS_INSTRUCTIONS,
  OPENAI_SYNTHESIS_REASONING,
} from "@/lib/ai/openai-profiles";
import {
  MAX_ASSISTANT_MESSAGE_LENGTH,
  type ChatFailureCode,
} from "@/lib/chat/contracts";
import {
  externalCitationMentionSchema,
  MAX_EXTERNAL_CITATION_OCCURRENCES,
  type ExternalCitationView,
} from "@/lib/citations/contracts";
import {
  ExternalCitationValidationError,
  normalizeExternalCitationAnnotations,
  normalizeExternalCitationMentions,
  type ProviderUrlCitation,
} from "@/lib/server/external-citations";
import type { ExternalPdfSource } from "@/lib/server/external-pdf-source";
import {
  synthesisProposalDraftSchema,
  type SynthesisProposalDraft,
} from "@/lib/synthesis/contracts";

const synthesisRequestSchema = z.object({}).strict();

const synthesisRequestTool = zodResponsesFunction({
  name: "request_synthesis",
  description: "Route the owner's current conversational request to the approval-required synthesis drafting profile.",
  parameters: synthesisRequestSchema,
});

const synthesisProposalTool = zodResponsesFunction({
  name: "propose_synthesis",
  description: "Create an approval-required replacement synthesis for the selected MindTree node.",
  parameters: synthesisProposalDraftSchema,
});

const pdfCitationMentionSchema = z.object({
  sourceAlias: z.literal("W1"),
  citedText: externalCitationMentionSchema.shape.citedText.regex(
    /^[^<>\[\]]+$/u,
    "Do not include square or angle brackets in PDF citations.",
  ),
}).strict();

const pdfResearchCompletionSchema = z.object({
  citations: z.array(pdfCitationMentionSchema)
    .min(1)
    .max(MAX_EXTERNAL_CITATION_OCCURRENCES),
  synthesisRequested: z.boolean(),
}).strict();

const pdfResearchCompletionTool = zodResponsesFunction({
  name: "complete_pdf_research",
  description: "Complete the explicitly authorized PDF answer with exact visible citation spans and synthesis-routing intent.",
  parameters: pdfResearchCompletionSchema,
});

export type NormalizedOpenAIChatEvent =
  | { type: "started"; providerResponseId: string }
  | { type: "research-status"; status: "searching" }
  | { type: "text-delta"; content: string }
  | {
      type: "completed";
      providerResponseId: string;
      synthesisRequested: boolean;
      proposal: SynthesisProposalDraft | null;
      externalCitations?: ExternalCitationView[];
    };

export type OpenAIChatPhase = "conversation" | "synthesis";

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
  options: {
    phase?: OpenAIChatPhase;
    webSearchAuthorized?: boolean;
    externalPdfSource?: ExternalPdfSource | null;
  } = {},
): AsyncGenerator<NormalizedOpenAIChatEvent> {
  const phase = options.phase ?? "conversation";
  const webSearchAuthorized = options.webSearchAuthorized === true;
  const externalPdfSource = options.externalPdfSource ?? null;
  const pdfResearch = webSearchAuthorized && externalPdfSource !== null;
  if (
    (phase === "synthesis" && webSearchAuthorized) ||
    (!webSearchAuthorized && externalPdfSource !== null)
  ) {
    throw new OpenAIChatError("response-invalid");
  }
  let providerResponseId: string | null = null;
  let completedResponseId: string | null = null;
  let visibleCharacterCount = 0;
  let bufferedResearchText = "";
  let researchStatusEmitted = false;
  const completedWebSearchCallIds = new Set<string>();
  let synthesisRequested = false;
  let proposal: SynthesisProposalDraft | null = null;
  let externalCitations: ExternalCitationView[] = [];

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
        if (pdfResearch) {
          researchStatusEmitted = true;
          yield { type: "research-status", status: "searching" };
        }
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
          if (webSearchAuthorized) {
            bufferedResearchText += event.delta;
          } else {
            yield { type: "text-delta", content: event.delta };
          }
        }
        break;
      }
      case "response.web_search_call.in_progress":
      case "response.web_search_call.searching": {
        if (!webSearchAuthorized || pdfResearch || providerResponseId === null) {
          throw new OpenAIChatError("response-invalid");
        }
        if (!researchStatusEmitted) {
          researchStatusEmitted = true;
          yield { type: "research-status", status: "searching" };
        }
        break;
      }
      case "response.web_search_call.completed": {
        if (!webSearchAuthorized || pdfResearch || providerResponseId === null) {
          throw new OpenAIChatError("response-invalid");
        }
        const itemId = requireResponseId(event.item_id);
        if (completedWebSearchCallIds.has(itemId)) {
          throw new OpenAIChatError("response-invalid");
        }
        completedWebSearchCallIds.add(itemId);
        if (!researchStatusEmitted) {
          researchStatusEmitted = true;
          yield { type: "research-status", status: "searching" };
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
        throw new OpenAIChatError(pdfResearch ? "response-invalid" : "generation-failed");
      case "response.completed": {
        const candidateResponseId = requireResponseId(event.response.id);
        if (
          providerResponseId === null ||
          candidateResponseId !== providerResponseId ||
          event.response.status !== "completed" ||
          !Array.isArray(event.response.output)
        ) {
          throw new OpenAIChatError("response-invalid");
        }
        const functionCalls = [];
        const outputTextParts: ResponseOutputText[] = [];
        const responseWebSearchCallIds = new Set<string>();
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
            outputTextParts.push(...item.content.filter((content) =>
              content.type === "output_text"
            ));
          } else if (item.type === "web_search_call") {
            if (!webSearchAuthorized || pdfResearch || item.status !== "completed") {
              throw new OpenAIChatError("response-invalid");
            }
            const itemId = requireResponseId(item.id);
            if (responseWebSearchCallIds.has(itemId)) {
              throw new OpenAIChatError("response-invalid");
            }
            responseWebSearchCallIds.add(itemId);
          } else if (item.type !== "reasoning") {
            throw new OpenAIChatError("response-invalid");
          }
        }
        if (pdfResearch) {
          if (
            responseWebSearchCallIds.size > 0 ||
            outputTextParts.length !== 1
          ) {
            throw new OpenAIChatError("response-invalid");
          }
          const outputText = outputTextParts[0]!;
          if (
            outputText.text !== bufferedResearchText ||
            outputText.annotations.length > 0
          ) {
            throw new OpenAIChatError("response-invalid");
          }
        } else if (webSearchAuthorized) {
          if (
            responseWebSearchCallIds.size < 1 ||
            completedWebSearchCallIds.size !== responseWebSearchCallIds.size ||
            [...completedWebSearchCallIds].some((itemId) =>
              !responseWebSearchCallIds.has(itemId)
            ) ||
            outputTextParts.length !== 1
          ) {
            throw new OpenAIChatError("response-invalid");
          }
          const outputText = outputTextParts[0]!;
          if (outputText.text !== bufferedResearchText) {
            throw new OpenAIChatError("response-invalid");
          }
          if (outputText.annotations.some((annotation) =>
            annotation.type !== "url_citation"
          )) {
            throw new OpenAIChatError("response-invalid");
          }
          try {
            const normalized = normalizeExternalCitationAnnotations({
              content: outputText.text,
              annotations: outputText.annotations as ProviderUrlCitation[],
            });
            if (normalized.content.length > MAX_ASSISTANT_MESSAGE_LENGTH) {
              throw new ExternalCitationValidationError("content-too-long");
            }
            bufferedResearchText = normalized.content;
            externalCitations = normalized.citations;
          } catch (error) {
            if (error instanceof ExternalCitationValidationError) {
              throw new OpenAIChatError("response-invalid");
            }
            throw error;
          }
        } else if (responseWebSearchCallIds.size > 0) {
          throw new OpenAIChatError("response-invalid");
        }
        if (functionCalls.length > 1) {
          throw new OpenAIChatError("response-invalid");
        }
        const functionCall = functionCalls[0];
        if (functionCall) {
          try {
            const argumentsValue: unknown = JSON.parse(functionCall.arguments);
            if (phase === "conversation") {
              if (pdfResearch) {
                if (functionCall.name !== "complete_pdf_research") {
                  throw new Error("unexpected tool");
                }
                const completion = pdfResearchCompletionSchema.parse(argumentsValue);
                externalCitations = normalizeExternalCitationMentions({
                  content: bufferedResearchText,
                  mentions: completion.citations,
                  evidence: [externalPdfSource!],
                });
                synthesisRequested = completion.synthesisRequested;
              } else if (functionCall.name !== "request_synthesis") {
                throw new Error("unexpected tool");
              } else {
                synthesisRequestSchema.parse(argumentsValue);
                synthesisRequested = true;
              }
            } else {
              if (functionCall.name !== "propose_synthesis") {
                throw new Error("unexpected tool");
              }
              proposal = synthesisProposalDraftSchema.parse(argumentsValue);
            }
          } catch {
            throw new OpenAIChatError("response-invalid");
          }
        }
        if (pdfResearch && functionCalls.length !== 1) {
          throw new OpenAIChatError("response-invalid");
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
  if (webSearchAuthorized) {
    visibleCharacterCount = bufferedResearchText.length;
    yield { type: "text-delta", content: bufferedResearchText };
  }
  if (visibleCharacterCount === 0) {
    if (phase === "conversation" && synthesisRequested) {
      // The synthesis profile will provide the visible response after this
      // routing-only completion.
    } else if (phase === "synthesis" && proposal !== null) {
      yield {
        type: "text-delta",
        content: "I drafted a synthesis proposal for your review.",
      };
    } else {
      throw new OpenAIChatError("response-invalid");
    }
  }
  if (
    (phase === "conversation" && proposal !== null) ||
    (phase === "synthesis" && (synthesisRequested || proposal === null))
  ) {
    throw new OpenAIChatError("response-invalid");
  }
  yield {
    type: "completed",
    providerResponseId,
    synthesisRequested,
    proposal,
    ...(webSearchAuthorized ? { externalCitations } : {}),
  };
}

export function createOpenAIChatRequest(input: {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  phase?: OpenAIChatPhase;
  safetyIdentifier: string;
  webSearchAuthorized?: boolean;
  externalPdfSource?: ExternalPdfSource | null;
}): ResponseCreateParamsStreaming {
  const phase = input.phase ?? "conversation";
  const synthesis = phase === "synthesis";
  const research = !synthesis && input.webSearchAuthorized === true;
  if (input.externalPdfSource != null && !research) {
    throw new OpenAIChatError("response-invalid");
  }
  const pdfResearch = research && input.externalPdfSource != null;
  const providerInput: ResponseInput = pdfResearch
    ? input.messages.map((message, index) =>
        index === input.messages.length - 1 && message.role === "user"
          ? {
              role: "user" as const,
              content: [
                { type: "input_text" as const, text: message.content },
                {
                  type: "input_file" as const,
                  file_url: input.externalPdfSource!.url,
                  detail: "low" as const,
                },
              ],
            }
          : message
      ) satisfies ResponseInput
    : input.messages satisfies ResponseInput;
  return {
    model: OPENAI_CHAT_MODEL,
    instructions: synthesis
      ? OPENAI_SYNTHESIS_INSTRUCTIONS
      : pdfResearch
        ? OPENAI_PDF_RESEARCH_INSTRUCTIONS
        : research
        ? OPENAI_RESEARCH_INSTRUCTIONS
        : OPENAI_CHAT_INSTRUCTIONS,
    input: providerInput,
    max_output_tokens: OPENAI_CHAT_MAX_OUTPUT_TOKENS,
    reasoning: synthesis
      ? OPENAI_SYNTHESIS_REASONING
      : research
        ? OPENAI_RESEARCH_REASONING
        : OPENAI_CHAT_REASONING,
    safety_identifier: input.safetyIdentifier,
    store: false,
    stream: true,
    tools: synthesis
      ? [synthesisProposalTool]
      : pdfResearch
        ? [pdfResearchCompletionTool]
        : research
        ? [{ type: "web_search" as const }, synthesisRequestTool]
        : [synthesisRequestTool],
    tool_choice: synthesis || pdfResearch ? "required" : "auto",
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
  phase?: OpenAIChatPhase;
  safetyIdentifier: string;
  signal: AbortSignal;
  webSearchAuthorized?: boolean;
  externalPdfSource?: ExternalPdfSource | null;
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
      phase: input.phase,
      webSearchAuthorized: input.webSearchAuthorized,
      externalPdfSource: input.externalPdfSource,
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
    if (
      input.webSearchAuthorized === true &&
      input.externalPdfSource != null &&
      error instanceof APIError &&
      (error.status === 400 || error.status === 413 || error.status === 422)
    ) {
      throw new OpenAIChatError("response-invalid");
    }
    throw classifyOpenAIChatSDKError(error, input.signal);
  } finally {
    clearTimeout(deadline);
  }
}
