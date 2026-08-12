import { describe, expect, it } from "vitest";

import {
  WEB_RESEARCH_PROGRESS_MESSAGE,
  chatFailureMessage,
} from "@/lib/chat/presentation";

describe("chat failure presentation", () => {
  it("keeps web research progress concise while setting a time expectation", () => {
    expect(WEB_RESEARCH_PROGRESS_MESSAGE).toBe(
      "Researching web sources… This can take up to 2 minutes.",
    );
  });

  it.each([
    [
      "response-invalid",
      "Couldn’t read or verify that source. Try a webpage or another source.",
    ],
    ["provider-timeout", "Web research timed out. Try again."],
    ["stream-disconnected", "Web research was interrupted. Try again."],
  ] as const)("maps a web %s failure to actionable copy", (failureCode, expected) => {
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
