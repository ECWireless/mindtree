import { describe, expect, it } from "vitest";

import {
  WEB_RESEARCH_PROGRESS_MESSAGE,
  chatFailureMessage,
} from "@/lib/chat/presentation";

describe("chat failure presentation", () => {
  it("keeps external research progress concise while setting a time expectation", () => {
    expect(WEB_RESEARCH_PROGRESS_MESSAGE).toBe(
      "Reading external sources… This can take up to 2 minutes.",
    );
  });

  it.each([
    ["assistant-unavailable", "External research is unavailable. Try again."],
    [
      "response-invalid",
      "Couldn’t verify that source. Try one webpage or HTTPS PDF.",
    ],
    [
      "provider-refusal",
      "External research couldn’t answer that request. Try rephrasing it.",
    ],
    [
      "generation-failed",
      "External research returned no verified result. Try again.",
    ],
    ["provider-timeout", "External research timed out. Try again."],
    ["stream-disconnected", "External research was interrupted. Try again."],
  ] as const)("maps an external %s failure to actionable copy", (failureCode, expected) => {
    expect(chatFailureMessage({ failureCode, webSearchAuthorized: true })).toBe(expected);
  });

  it("does not imply a source problem for ordinary chat or unrelated failures", () => {
    expect(chatFailureMessage({
      failureCode: "response-invalid",
      webSearchAuthorized: false,
    })).toBe("That response didn’t finish.");
    expect(chatFailureMessage({
      failureCode: "stream-disconnected",
      webSearchAuthorized: false,
    })).toBe("That response didn’t finish.");
  });
});
