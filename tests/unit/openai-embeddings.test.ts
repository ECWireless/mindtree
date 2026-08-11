import { describe, expect, it, vi } from "vitest";
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
} from "openai";

vi.mock("server-only", () => ({}));

import {
  classifyOpenAIEmbeddingSDKError,
  createOpenAIEmbeddingRequest,
  normalizeOpenAIEmbeddingResponse,
  OpenAIEmbeddingError,
} from "../../src/lib/server/openai-embeddings";

function vector(first = 1) {
  return [first, ...Array.from({ length: 3_071 }, () => 0)];
}

function response(embedding: unknown = vector()) {
  return {
    object: "list",
    model: "text-embedding-3-large",
    data: [{ object: "embedding", index: 0, embedding }],
    usage: { prompt_tokens: 5, total_tokens: 5 },
  };
}

describe("OpenAI approved-synthesis embeddings", () => {
  it("uses the fixed full-dimension embedding profile and stable safety identifier", () => {
    expect(createOpenAIEmbeddingRequest({
      content: "Synthetic approved Summary",
      safetyIdentifier: "mt_synthetic",
    })).toEqual({
      model: "text-embedding-3-large",
      input: "Synthetic approved Summary",
      dimensions: 3_072,
      encoding_format: "float",
      user: "mt_synthetic",
    });
  });

  it("accepts exactly one finite, non-zero vector with the configured shape", () => {
    const embedding = vector(0.25);
    expect(normalizeOpenAIEmbeddingResponse(response(embedding))).toBe(embedding);
  });

  it.each([
    ["missing response", null],
    ["wrong model", { ...response(), model: "text-embedding-3-small" }],
    ["multiple vectors", { ...response(), data: [response().data[0], response().data[0]] }],
    ["wrong dimensions", response([1, 0])],
    ["non-finite component", response(vector(Number.NaN))],
    ["zero vector", response(vector(0))],
  ])("rejects %s", (_label, candidate) => {
    expect(() => normalizeOpenAIEmbeddingResponse(candidate)).toThrow(
      new OpenAIEmbeddingError("response-invalid"),
    );
  });

  it("classifies timeouts separately without exposing provider errors", () => {
    expect(classifyOpenAIEmbeddingSDKError(
      new APIConnectionTimeoutError(),
      false,
    )).toEqual(new OpenAIEmbeddingError("provider-timeout"));
    expect(classifyOpenAIEmbeddingSDKError(
      new APIError(408, undefined, "synthetic timeout", new Headers()),
      false,
    )).toEqual(new OpenAIEmbeddingError("provider-timeout"));
    expect(classifyOpenAIEmbeddingSDKError(
      new APIConnectionError({ message: "synthetic disconnect" }),
      false,
    )).toEqual(new OpenAIEmbeddingError("generation-failed"));
    expect(classifyOpenAIEmbeddingSDKError(
      new Error("synthetic failure"),
      true,
    )).toEqual(new OpenAIEmbeddingError("provider-timeout"));
  });
});
