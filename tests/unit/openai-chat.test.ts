import { describe, expect, it, vi } from "vitest";
import type { ResponseStreamEvent } from "openai/resources/responses/responses";

vi.mock("server-only", () => ({}));

import {
  createOpenAIChatRequest,
  normalizeOpenAIChatEvents,
  type NormalizedOpenAIChatEvent,
  OpenAIChatError,
} from "@/lib/server/openai-chat";

async function* fixture(events: unknown[]) {
  for (const event of events) {
    yield event as ResponseStreamEvent;
  }
}

const createdEvent = {
  type: "response.created",
  sequence_number: 0,
  response: { id: "resp_synthetic", status: "in_progress" },
};

function deltaEvent(delta: string, sequenceNumber = 1) {
  return {
    type: "response.output_text.delta",
    sequence_number: sequenceNumber,
    item_id: "msg_synthetic",
    output_index: 0,
    content_index: 0,
    delta,
    logprobs: [],
  };
}

const completedEvent = {
  type: "response.completed",
  sequence_number: 3,
  response: { id: "resp_synthetic", status: "completed" },
};

describe("OpenAI Responses chat stream", () => {
  it("builds the exact non-retained standard chat profile without tools", () => {
    const request = createOpenAIChatRequest({
      messages: [{ role: "user", content: "Synthetic request" }],
      safetyIdentifier: "mt_synthetic",
    });

    expect(request).toMatchObject({
      model: "gpt-5.6-sol",
      input: [{ role: "user", content: "Synthetic request" }],
      max_output_tokens: 16_384,
      reasoning: { context: "current_turn", effort: "high" },
      safety_identifier: "mt_synthetic",
      store: false,
      stream: true,
      tools: [],
      parallel_tool_calls: false,
    });
    expect(request.reasoning).not.toHaveProperty("mode");
    expect(request).not.toHaveProperty("previous_response_id");
    expect(request).not.toHaveProperty("conversation");
  });

  it("normalizes the consumed successful text lifecycle", async () => {
    const response = { id: "resp_synthetic", status: "completed" };
    const normalized = await Array.fromAsync(normalizeOpenAIChatEvents(fixture([
      {
        type: "response.created",
        sequence_number: 0,
        response: { ...response, status: "in_progress" },
      },
      {
        type: "response.in_progress",
        sequence_number: 1,
        response: { ...response, status: "in_progress" },
      },
      {
        type: "response.output_text.delta",
        sequence_number: 2,
        item_id: "msg_synthetic",
        output_index: 0,
        content_index: 0,
        delta: "A useful response.",
        logprobs: [],
      },
      {
        type: "response.completed",
        sequence_number: 3,
        response,
      },
    ])));

    expect(normalized).toEqual([
      { type: "started", providerResponseId: "resp_synthetic" },
      { type: "text-delta", content: "A useful response." },
      { type: "completed", providerResponseId: "resp_synthetic" },
    ]);
  });

  it("rejects single and cumulative deltas beyond the local assistant bound", async () => {
    await expect(Array.fromAsync(normalizeOpenAIChatEvents(fixture([
      createdEvent,
      deltaEvent("x".repeat(64_001)),
      completedEvent,
    ])))).rejects.toEqual(new OpenAIChatError("response-invalid"));

    await expect(Array.fromAsync(normalizeOpenAIChatEvents(fixture([
      createdEvent,
      deltaEvent("x".repeat(64_000)),
      deltaEvent("y", 2),
      completedEvent,
    ])))).rejects.toEqual(new OpenAIChatError("response-invalid"));
  });

  it("does not yield completion when the provider emits a trailing event", async () => {
    const normalized = normalizeOpenAIChatEvents(fixture([
      createdEvent,
      deltaEvent("Bounded response."),
      completedEvent,
      { type: "response.in_progress", sequence_number: 4 },
    ]));
    const consumed: NormalizedOpenAIChatEvent[] = [];

    await expect((async () => {
      for await (const event of normalized) consumed.push(event);
    })()).rejects.toEqual(new OpenAIChatError("response-invalid"));
    expect(consumed).toEqual([
      { type: "started", providerResponseId: "resp_synthetic" },
      { type: "text-delta", content: "Bounded response." },
    ]);
  });

  it("does not yield completion when the source fails after its terminal event", async () => {
    async function* failingFixture() {
      yield createdEvent as ResponseStreamEvent;
      yield deltaEvent("Bounded response.") as ResponseStreamEvent;
      yield completedEvent as ResponseStreamEvent;
      throw new Error("synthetic trailing transport failure");
    }
    const consumed: NormalizedOpenAIChatEvent[] = [];

    await expect((async () => {
      for await (const event of normalizeOpenAIChatEvents(failingFixture())) {
        consumed.push(event);
      }
    })()).rejects.toThrow("synthetic trailing transport failure");
    expect(consumed).toEqual([
      { type: "started", providerResponseId: "resp_synthetic" },
      { type: "text-delta", content: "Bounded response." },
    ]);
  });
});
