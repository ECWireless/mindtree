import "server-only";

import OpenAI, {
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from "openai";
import type {
  EmbeddingCreateParams,
} from "openai/resources/embeddings";

import {
  OPENAI_EMBEDDING_DIMENSIONS,
  OPENAI_EMBEDDING_MODEL,
  OPENAI_EMBEDDING_TIMEOUT_MS,
} from "@/lib/ai/openai-profiles";

export type OpenAIEmbeddingFailureCode =
  | "generation-failed"
  | "provider-timeout"
  | "response-invalid";

export class OpenAIEmbeddingError extends Error {
  constructor(public readonly failureCode: OpenAIEmbeddingFailureCode) {
    super(failureCode);
    this.name = "OpenAIEmbeddingError";
  }
}

function isValidEmbedding(value: unknown): value is number[] {
  return Array.isArray(value) &&
    value.length === OPENAI_EMBEDDING_DIMENSIONS &&
    value.every((component) =>
      typeof component === "number" && Number.isFinite(component)
    ) &&
    value.some((component) => component !== 0);
}

export function createOpenAIEmbeddingRequest(input: {
  content: string;
  safetyIdentifier: string;
}): EmbeddingCreateParams {
  return {
    model: OPENAI_EMBEDDING_MODEL,
    input: input.content,
    dimensions: OPENAI_EMBEDDING_DIMENSIONS,
    encoding_format: "float",
    user: input.safetyIdentifier,
  };
}

export function normalizeOpenAIEmbeddingResponse(
  response: unknown,
): number[] {
  if (
    typeof response !== "object" ||
    response === null ||
    !("object" in response) ||
    response.object !== "list" ||
    !("model" in response) ||
    response.model !== OPENAI_EMBEDDING_MODEL ||
    !("data" in response) ||
    !Array.isArray(response.data) ||
    response.data.length !== 1
  ) {
    throw new OpenAIEmbeddingError("response-invalid");
  }
  const item = response.data[0];
  if (
    typeof item !== "object" ||
    item === null ||
    !("object" in item) ||
    item.object !== "embedding" ||
    !("index" in item) ||
    item.index !== 0 ||
    !("embedding" in item) ||
    !isValidEmbedding(item.embedding)
  ) {
    throw new OpenAIEmbeddingError("response-invalid");
  }
  return item.embedding;
}

export function classifyOpenAIEmbeddingSDKError(
  error: unknown,
  deadlineExceeded: boolean,
): OpenAIEmbeddingError {
  if (error instanceof OpenAIEmbeddingError) return error;
  if (
    deadlineExceeded ||
    error instanceof APIConnectionTimeoutError ||
    (error instanceof APIError && error.status === 408)
  ) {
    return new OpenAIEmbeddingError("provider-timeout");
  }
  return new OpenAIEmbeddingError("generation-failed");
}

export async function createOpenAIEmbedding(input: {
  apiKey: string;
  content: string;
  safetyIdentifier: string;
}): Promise<number[]> {
  const client = new OpenAI({
    apiKey: input.apiKey,
    maxRetries: 0,
    timeout: OPENAI_EMBEDDING_TIMEOUT_MS,
  });
  const deadlineController = new AbortController();
  let deadlineExceeded = false;
  const deadline = setTimeout(() => {
    deadlineExceeded = true;
    deadlineController.abort();
  }, OPENAI_EMBEDDING_TIMEOUT_MS);

  try {
    const response = await client.embeddings.create(
      createOpenAIEmbeddingRequest(input),
      { signal: deadlineController.signal },
    );
    if (deadlineExceeded) {
      throw new OpenAIEmbeddingError("provider-timeout");
    }
    return normalizeOpenAIEmbeddingResponse(response);
  } catch (error) {
    if (error instanceof APIUserAbortError && deadlineExceeded) {
      throw new OpenAIEmbeddingError("provider-timeout");
    }
    throw classifyOpenAIEmbeddingSDKError(error, deadlineExceeded);
  } finally {
    clearTimeout(deadline);
  }
}
