function normalizeAllowedDevOrigin(value: string) {
  const candidate = value.includes("://") ? value : `http://${value}`;
  let url: URL;

  try {
    url = new URL(candidate);
  } catch {
    throw new Error("NEXT_ALLOWED_DEV_ORIGINS must contain valid HTTP(S) origins or hostnames.");
  }

  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("NEXT_ALLOWED_DEV_ORIGINS must contain valid HTTP(S) origins or hostnames.");
  }

  return url.hostname;
}

export function parseAllowedDevOrigins(value?: string) {
  const origins = value
    ?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map(normalizeAllowedDevOrigin);

  return origins?.length ? [...new Set(origins)] : undefined;
}
