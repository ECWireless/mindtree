export type AuthenticationAvailability =
  | { available: true }
  | { available: false; canonicalOrigin: string };

export function resolveAuthenticationAvailability({
  canonicalUrl,
  vercelEnvironment,
}: {
  canonicalUrl: string;
  vercelEnvironment?: string;
}): AuthenticationAvailability {
  if (vercelEnvironment !== "preview") {
    return { available: true };
  }

  return {
    available: false,
    canonicalOrigin: new URL(canonicalUrl).origin,
  };
}
