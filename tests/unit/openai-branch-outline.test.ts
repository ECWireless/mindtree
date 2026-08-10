import { describe, expect, it, vi } from "vitest";
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from "openai";
import type { ResponseStreamEvent } from "openai/resources/responses/responses";

vi.mock("server-only", () => ({}));

import {
  classifyOpenAIBranchOutlineSDKError,
  createOpenAIBranchOutlineRequest,
  normalizeOpenAIBranchOutlineEvents,
  OpenAIBranchOutlineAbortError,
  OpenAIBranchOutlineError,
} from "../../src/lib/server/openai-branch-outline";

async function* fixture(events: unknown[]) {
  for (const event of events) yield event as ResponseStreamEvent;
}

const created = {
  type: "response.created",
  response: { id: "resp_outline", status: "in_progress" },
};

function delta(content: string) {
  return { type: "response.output_text.delta", delta: content };
}

function completed(content: string) {
  return {
    type: "response.completed",
    response: {
      id: "resp_outline",
      status: "completed",
      output: [{
        type: "message",
        status: "completed",
        content: [{ type: "output_text", text: content, annotations: [] }],
      }],
    },
  };
}

describe("OpenAI Branch Outline stream", () => {
  it("uses the fixed non-retained synthesis profile without tools or web search", () => {
    const request = createOpenAIBranchOutlineRequest({
      messages: [{ role: "user", content: "Synthetic context" }],
      safetyIdentifier: "mt_synthetic",
    });
    expect(request).toMatchObject({
      model: "gpt-5.6-sol",
      input: [{ role: "user", content: "Synthetic context" }],
      reasoning: { context: "current_turn", effort: "high", mode: "pro" },
      safety_identifier: "mt_synthetic",
      store: false,
      stream: true,
    });
    expect(request).not.toHaveProperty("tools");
    expect(request).not.toHaveProperty("tool_choice");
    expect(request).not.toHaveProperty("previous_response_id");
    expect(request.instructions).toContain(
      "Produce exactly one description for each supplied direct child",
    );
    expect(request.instructions).toContain(
      "Never include, name, summarize, or describe it as an outline entry",
    );
    expect(request.instructions).toContain(
      "treat its approved Summary as primary evidence",
    );
    expect(request.instructions).toContain(
      "never list a descendant as a separate item",
    );
    expect(request.instructions).toContain("Never mention archive status");
    expect(request.instructions).toContain("server attaches trusted child titles");
    expect(request.instructions).toContain("consecutive one-based ordinals");
    expect(request.instructions).toContain("Return only one strict JSON object");
  });

  it("normalizes one bounded plain-Markdown response", async () => {
    await expect(Array.fromAsync(normalizeOpenAIBranchOutlineEvents(fixture([
      created,
      delta('{"items":[{"ordinal":1,'),
      delta('"description":"First child direction."}]}'),
      completed('{"items":[{"ordinal":1,"description":"First child direction."}]}'),
    ])))).resolves.toEqual([
      { type: "started", providerResponseId: "resp_outline" },
      { type: "text-delta", content: '{"items":[{"ordinal":1,' },
      { type: "text-delta", content: '"description":"First child direction."}]}' },
      {
        type: "completed",
        providerResponseId: "resp_outline",
        content: '{"items":[{"ordinal":1,"description":"First child direction."}]}',
      },
    ]);
  });

  it("rejects refusals, malformed lifecycles, and mismatched completed text", async () => {
    await expect(Array.fromAsync(normalizeOpenAIBranchOutlineEvents(fixture([
      created,
      { type: "response.refusal.delta" },
    ])))).rejects.toEqual(new OpenAIBranchOutlineError("provider-refusal"));
    await expect(Array.fromAsync(normalizeOpenAIBranchOutlineEvents(fixture([
      delta("Missing creation"),
    ])))).rejects.toEqual(new OpenAIBranchOutlineError("response-invalid"));
    await expect(Array.fromAsync(normalizeOpenAIBranchOutlineEvents(fixture([
      created,
      delta("Streamed text"),
      completed("Different text"),
    ])))).rejects.toEqual(new OpenAIBranchOutlineError("response-invalid"));
  });

  it("classifies provider timeout, disconnect, abort, and API failures", () => {
    const activeSignal = new AbortController().signal;
    const abortedController = new AbortController();
    abortedController.abort();
    expect(classifyOpenAIBranchOutlineSDKError(
      new APIConnectionTimeoutError(),
      activeSignal,
    )).toEqual(new OpenAIBranchOutlineError("provider-timeout"));
    expect(classifyOpenAIBranchOutlineSDKError(
      new APIConnectionError({ message: "synthetic disconnect" }),
      activeSignal,
    )).toEqual(new OpenAIBranchOutlineError("stream-disconnected"));
    expect(classifyOpenAIBranchOutlineSDKError(
      new APIError(408, undefined, "synthetic timeout", new Headers()),
      activeSignal,
    )).toEqual(new OpenAIBranchOutlineError("provider-timeout"));
    expect(classifyOpenAIBranchOutlineSDKError(
      new APIError(500, undefined, "synthetic provider failure", new Headers()),
      activeSignal,
    )).toEqual(new OpenAIBranchOutlineError("generation-failed"));
    expect(classifyOpenAIBranchOutlineSDKError(
      new APIUserAbortError(),
      activeSignal,
    )).toEqual(new OpenAIBranchOutlineAbortError());
    expect(classifyOpenAIBranchOutlineSDKError(
      new Error("synthetic abort"),
      abortedController.signal,
    )).toEqual(new OpenAIBranchOutlineAbortError());
  });
});
