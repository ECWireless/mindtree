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
  });

  it("normalizes one bounded plain-Markdown response", async () => {
    await expect(Array.fromAsync(normalizeOpenAIBranchOutlineEvents(fixture([
      created,
      delta("## Direction\n\n"),
      delta("- First child"),
      completed("## Direction\n\n- First child"),
    ])))).resolves.toEqual([
      { type: "started", providerResponseId: "resp_outline" },
      { type: "text-delta", content: "## Direction\n\n" },
      { type: "text-delta", content: "- First child" },
      {
        type: "completed",
        providerResponseId: "resp_outline",
        content: "## Direction\n\n- First child",
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
