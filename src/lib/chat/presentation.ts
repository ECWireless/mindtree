export const WEB_RESEARCH_PROGRESS_MESSAGE =
  "Researching web sources… This can take up to 2 minutes.";

export function chatFailureMessage(input: {
  failureCode: string | null;
  webSearchAuthorized: boolean;
}) {
  if (input.webSearchAuthorized) {
    if (input.failureCode === "response-invalid") {
      return "Couldn’t read or verify that source. Try a webpage or another source.";
    }
    if (input.failureCode === "provider-timeout") {
      return "Web research timed out. Try again.";
    }
    if (input.failureCode === "stream-disconnected") {
      return "Web research was interrupted. Try again.";
    }
  }
  return "That response didn’t finish.";
}
