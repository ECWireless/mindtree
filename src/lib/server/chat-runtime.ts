import "server-only";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function isDeterministicChatFixtureEnabled(environment = process.env) {
  if (
    environment.NODE_ENV === "production" ||
    environment.MINDTREE_TEST_CHAT_FIXTURE !== "1" ||
    !environment.BETTER_AUTH_URL
  ) {
    return false;
  }

  try {
    return LOOPBACK_HOSTS.has(new URL(environment.BETTER_AUTH_URL).hostname);
  } catch {
    return false;
  }
}

export async function* generateDeterministicChatReply(content: string) {
  const topic = content.trim().replace(/\s+/g, " ").slice(0, 80);
  const chunks = [
    "Here’s one way to develop that thought:\n\n",
    `**${topic}** can become clearer by separating the observation from the question it raises. `,
    "What evidence would change your view?",
  ];
  for (const chunk of chunks) {
    await new Promise((resolve) => setTimeout(resolve, 80));
    yield chunk;
  }
}
