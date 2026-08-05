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
  OPENAI_CHAT_TIMEOUT_MS,
} from "@/lib/ai/openai-profiles";
import {
  classifyOpenAIChatSDKError,
  createOpenAIChatRequest,
  normalizeOpenAIChatEvents,
  type NormalizedOpenAIChatEvent,
  OpenAIChatAbortError,
  OpenAIChatError,
  streamOpenAIChat,
} from "@/lib/server/openai-chat";

async function* fixture(events: unknown[]) {
  for (const event of events) {
    yield event as ResponseStreamEvent;
  }
}

function sseEvent(event: unknown) {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
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

async function expectInvalid(events: unknown[]) {
  await expect(
    Array.fromAsync(normalizeOpenAIChatEvents(fixture(events))),
  ).rejects.toEqual(new OpenAIChatError("response-invalid"));
}

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
    await expectInvalid([
      createdEvent,
      deltaEvent("x".repeat(64_001)),
      completedEvent,
    ]);

    await expectInvalid([
      createdEvent,
      deltaEvent("x".repeat(64_000)),
      deltaEvent("y", 2),
      completedEvent,
    ]);
  });

  it.each([
    ["response.refusal.delta", "provider-refusal"],
    ["response.refusal.done", "provider-refusal"],
    ["response.incomplete", "response-invalid"],
    ["response.failed", "generation-failed"],
    ["error", "generation-failed"],
  ] as const)("maps %s to %s", async (type, failureCode) => {
    await expect(Array.fromAsync(normalizeOpenAIChatEvents(fixture([
      createdEvent,
      { type, sequence_number: 1 },
    ])))).rejects.toEqual(new OpenAIChatError(failureCode));
  });

  it("rejects malformed provider lifecycles and identifiers", async () => {
    await expectInvalid([deltaEvent("text before creation")]);
    await expectInvalid([]);
    await expectInvalid([createdEvent, createdEvent]);
    await expectInvalid([
      { ...createdEvent, response: { id: "", status: "in_progress" } },
    ]);
    await expectInvalid([
      {
        ...createdEvent,
        response: { id: "x".repeat(256), status: "in_progress" },
      },
    ]);
    await expectInvalid([createdEvent, deltaEvent("No completion")]);
    await expectInvalid([createdEvent, completedEvent]);
    await expectInvalid([
      createdEvent,
      deltaEvent("Wrong status"),
      { ...completedEvent, response: { id: "resp_synthetic", status: "failed" } },
    ]);
    await expectInvalid([
      createdEvent,
      deltaEvent("Wrong response"),
      { ...completedEvent, response: { id: "resp_other", status: "completed" } },
    ]);
  });

  it("ignores empty text deltas and unconsumed informational events", async () => {
    const normalized = await Array.fromAsync(normalizeOpenAIChatEvents(fixture([
      createdEvent,
      { type: "response.in_progress", sequence_number: 1 },
      deltaEvent(""),
      deltaEvent("Visible text", 2),
      completedEvent,
    ])));

    expect(normalized).toEqual([
      { type: "started", providerResponseId: "resp_synthetic" },
      { type: "text-delta", content: "Visible text" },
      { type: "completed", providerResponseId: "resp_synthetic" },
    ]);
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

  it("classifies SDK transport, timeout, API, abort, and unknown failures", () => {
    const activeSignal = new AbortController().signal;
    const abortedController = new AbortController();
    abortedController.abort();

    expect(classifyOpenAIChatSDKError(
      new APIConnectionTimeoutError(),
      activeSignal,
    )).toEqual(new OpenAIChatError("provider-timeout"));
    expect(classifyOpenAIChatSDKError(
      new APIConnectionError({ message: "synthetic disconnect" }),
      activeSignal,
    )).toEqual(new OpenAIChatError("stream-disconnected"));
    expect(classifyOpenAIChatSDKError(
      new APIError(408, undefined, "synthetic request timeout", new Headers()),
      activeSignal,
    )).toEqual(new OpenAIChatError("provider-timeout"));
    for (const status of [401, 403, 404, 429, 500, 503]) {
      expect(classifyOpenAIChatSDKError(
        new APIError(status, undefined, "synthetic provider error", new Headers()),
        activeSignal,
      )).toEqual(new OpenAIChatError("assistant-unavailable"));
    }
    expect(classifyOpenAIChatSDKError(
      new APIError(400, undefined, "synthetic bad request", new Headers()),
      activeSignal,
    )).toEqual(new OpenAIChatError("generation-failed"));
    expect(classifyOpenAIChatSDKError(
      new APIUserAbortError(),
      activeSignal,
    )).toEqual(new OpenAIChatAbortError());
    expect(classifyOpenAIChatSDKError(
      new Error("synthetic unknown failure"),
      abortedController.signal,
    )).toEqual(new OpenAIChatAbortError());
    expect(classifyOpenAIChatSDKError(
      new Error("synthetic unknown failure"),
      activeSignal,
    )).toEqual(new OpenAIChatError("generation-failed"));
  });

  it("preserves already-normalized adapter errors", () => {
    const signal = new AbortController().signal;
    const failure = new OpenAIChatError("provider-refusal");
    const aborted = new OpenAIChatAbortError();

    expect(classifyOpenAIChatSDKError(failure, signal)).toBe(failure);
    expect(classifyOpenAIChatSDKError(aborted, signal)).toBe(aborted);

    const abortedController = new AbortController();
    abortedController.abort();
    expect(classifyOpenAIChatSDKError(failure, abortedController.signal))
      .toEqual(new OpenAIChatAbortError());
  });

  it("enforces the deadline across a response body that stalls after headers", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_request: RequestInfo | URL, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const failForAbort = () => controller.error(
            new DOMException("The operation was aborted.", "AbortError"),
          );
          if (init?.signal?.aborted) {
            failForAbort();
          } else {
            init?.signal?.addEventListener("abort", failForAbort, { once: true });
          }
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const pending = streamOpenAIChat({
        apiKey: "sk-synthetic",
        messages: [{ role: "user", content: "Wait forever" }],
        safetyIdentifier: "mt_synthetic",
        signal: new AbortController().signal,
      }).next();
      const timedOut = expect(pending).rejects.toEqual(
        new OpenAIChatError("provider-timeout"),
      );

      await vi.advanceTimersByTimeAsync(OPENAI_CHAT_TIMEOUT_MS);
      await timedOut;
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("does not yield provider events that arrive after the deadline", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(sseEvent(createdEvent));
          controller.enqueue(sseEvent(deltaEvent("Before the deadline.")));
          setTimeout(() => {
            controller.enqueue(sseEvent(completedEvent));
            controller.close();
          }, OPENAI_CHAT_TIMEOUT_MS + 1);
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const consumed: NormalizedOpenAIChatEvent[] = [];

    try {
      const consumption = (async () => {
        for await (const event of streamOpenAIChat({
          apiKey: "sk-synthetic",
          messages: [{ role: "user", content: "Finish too late" }],
          safetyIdentifier: "mt_synthetic",
          signal: new AbortController().signal,
        })) {
          consumed.push(event);
        }
      })();
      const timedOut = expect(consumption).rejects.toEqual(
        new OpenAIChatError("provider-timeout"),
      );

      await vi.advanceTimersByTimeAsync(OPENAI_CHAT_TIMEOUT_MS + 1);
      await timedOut;
      expect(consumed).toEqual([
        { type: "started", providerResponseId: "resp_synthetic" },
        { type: "text-delta", content: "Before the deadline." },
      ]);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("preserves caller cancellation when an aborted body ends cleanly", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_request: RequestInfo | URL, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.close(), {
            once: true,
          });
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const requestController = new AbortController();

    try {
      const pending = streamOpenAIChat({
        apiKey: "sk-synthetic",
        messages: [{ role: "user", content: "Cancel this request" }],
        safetyIdentifier: "mt_synthetic",
        signal: requestController.signal,
      }).next();
      const cancelled = expect(pending).rejects.toEqual(new OpenAIChatAbortError());
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledOnce();

      requestController.abort();
      await cancelled;
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
