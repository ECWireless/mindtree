import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildChatGenerationFailureLog,
  logChatGenerationFailure,
} from "@/lib/server/chat-observability";

describe("chat generation observability", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("emits only bounded, privacy-safe failure metadata", () => {
    expect(buildChatGenerationFailureLog({
      failureCode: "response-invalid",
      diagnosticReason: "external-citation-invalid-title",
      phase: "conversation",
      webSearchAuthorized: true,
      externalPdfAttached: false,
      providerResponseRecorded: true,
      elapsedMs: 12.6,
    })).toEqual({
      event: "chat_generation_failed",
      failureCode: "response-invalid",
      diagnosticReason: "external-citation-invalid-title",
      phase: "conversation",
      webSearchAuthorized: true,
      externalPdfAttached: false,
      providerResponseRecorded: true,
      elapsedMs: 13,
    });

    expect(buildChatGenerationFailureLog({
      failureCode: "generation-failed",
      diagnosticReason: null,
      phase: "preparation",
      webSearchAuthorized: false,
      externalPdfAttached: false,
      providerResponseRecorded: false,
      elapsedMs: Number.NaN,
    }).elapsedMs).toBe(0);
    expect(buildChatGenerationFailureLog({
      failureCode: "provider-timeout",
      diagnosticReason: null,
      phase: "conversation",
      webSearchAuthorized: true,
      externalPdfAttached: false,
      providerResponseRecorded: true,
      elapsedMs: Number.MAX_SAFE_INTEGER,
    }).elapsedMs).toBe(86_400_000);
  });

  it("suppresses test logging and writes one structured record in production", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const input = {
      failureCode: "response-invalid" as const,
      diagnosticReason: "external-citation-invalid-title" as const,
      phase: "conversation" as const,
      webSearchAuthorized: true,
      externalPdfAttached: false,
      providerResponseRecorded: true,
      elapsedMs: 50,
    };

    vi.stubEnv("NODE_ENV", "test");
    logChatGenerationFailure(input);
    expect(warn).not.toHaveBeenCalled();

    vi.stubEnv("NODE_ENV", "production");
    logChatGenerationFailure(input);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(JSON.stringify({
      event: "chat_generation_failed",
      ...input,
    }));
  });
});
