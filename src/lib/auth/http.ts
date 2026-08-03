const AUTH_BASE_PATH = "/api/auth";

const ALLOWED_AUTH_PATHS = {
  GET: new Set([`${AUTH_BASE_PATH}/callback/google`]),
  POST: new Set([
    `${AUTH_BASE_PATH}/callback/google`,
    `${AUTH_BASE_PATH}/sign-in/social`,
    `${AUTH_BASE_PATH}/sign-out`,
  ]),
} as const;

export type MindTreeAuthHttpMethod = keyof typeof ALLOWED_AUTH_PATHS;

export function isMindTreeAuthRequestAllowed({
  method,
  pathname,
  vercelEnvironment,
}: {
  method: MindTreeAuthHttpMethod;
  pathname: string;
  vercelEnvironment?: string;
}) {
  return vercelEnvironment !== "preview" && ALLOWED_AUTH_PATHS[method].has(pathname);
}
