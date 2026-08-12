export const WEB_RESEARCH_PROGRESS_MESSAGE =
  "Reading external sources… This can take up to 2 minutes.";

export function chatFailureMessage(input: {
  failureCode: string | null;
  webSearchAuthorized: boolean;
}) {
  if (input.webSearchAuthorized) {
    if (input.failureCode === "assistant-unavailable") {
      return "External research is unavailable. Try again.";
    }
    if (input.failureCode === "response-invalid") {
      return "Couldn’t verify that source. Try one webpage or HTTPS PDF.";
    }
    if (input.failureCode === "provider-timeout") {
      return "External research timed out. Try again.";
    }
    if (input.failureCode === "stream-disconnected") {
      return "External research was interrupted. Try again.";
    }
  }
  return "That response didn’t finish.";
}
