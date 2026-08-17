import { z } from "zod";

import { parseShareLinkEncryptionKey } from "@/lib/server/share-encryption-key";

const optionalUrl = z.union([z.literal(""), z.url()]).transform((value) => value || undefined);
const optionalNonEmpty = z
  .union([z.literal(""), z.string().trim().min(1)])
  .transform((value) => value || undefined);
const trustedOrigin = z.url().transform((value, context) => {
  const url = new URL(value);

  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.hostname.includes("*") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    context.addIssue({
      code: "custom",
      message:
        "Trusted origins must be exact HTTP(S) origins without wildcards, credentials, paths, or query data.",
    });
    return z.NEVER;
  }

  return url.origin;
});
const optionalTrustedOrigins = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim()
      ? value.split(",").map((origin) => origin.trim())
      : undefined,
  z.array(trustedOrigin).min(1).optional(),
);

export const allowedEmailSchema = z.string().trim().toLowerCase().pipe(z.email());

const serverEnvironmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: optionalUrl.optional(),
  DATABASE_URL_UNPOOLED: optionalUrl.optional(),
  BETTER_AUTH_SECRET: optionalNonEmpty.optional(),
  BETTER_AUTH_URL: optionalUrl.optional(),
  BETTER_AUTH_TRUSTED_ORIGINS: optionalTrustedOrigins,
  GOOGLE_CLIENT_ID: optionalNonEmpty.optional(),
  GOOGLE_CLIENT_SECRET: optionalNonEmpty.optional(),
  ALLOWED_EMAIL: z
    .union([z.literal(""), allowedEmailSchema])
    .transform((value) => value || undefined)
    .optional(),
  OPENAI_API_KEY: optionalNonEmpty.optional(),
  SHARE_LINK_ENCRYPTION_KEY: optionalNonEmpty.optional(),
});

export type ServerEnvironment = z.infer<typeof serverEnvironmentSchema>;

export type ServerEnvironmentRequirement =
  | "database"
  | "authentication-origin"
  | "authentication"
  | "openai"
  | "sharing-encryption";

export type RequiredServerEnvironment<
  Requirements extends readonly ServerEnvironmentRequirement[],
> = ServerEnvironment &
  ("database" extends Requirements[number]
    ? { DATABASE_URL: string }
    : object) &
  ("authentication-origin" extends Requirements[number]
    ? { BETTER_AUTH_URL: string }
    : object) &
  ("authentication" extends Requirements[number]
    ? {
        BETTER_AUTH_SECRET: string;
        BETTER_AUTH_URL: string;
        GOOGLE_CLIENT_ID: string;
        GOOGLE_CLIENT_SECRET: string;
        ALLOWED_EMAIL: string;
      }
    : object) &
  ("openai" extends Requirements[number] ? { OPENAI_API_KEY: string } : object) &
  ("sharing-encryption" extends Requirements[number]
    ? { SHARE_LINK_ENCRYPTION_KEY: string }
    : object);

const requirementNames: Record<ServerEnvironmentRequirement, readonly (keyof ServerEnvironment)[]> = {
  database: ["DATABASE_URL"],
  "authentication-origin": ["BETTER_AUTH_URL"],
  authentication: [
    "BETTER_AUTH_SECRET",
    "BETTER_AUTH_URL",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "ALLOWED_EMAIL",
  ],
  openai: ["OPENAI_API_KEY"],
  "sharing-encryption": ["SHARE_LINK_ENCRYPTION_KEY"],
};

export function parseServerEnvironment<
  const Requirements extends readonly ServerEnvironmentRequirement[] = [],
>(
  input: NodeJS.ProcessEnv,
  requirements: Requirements = [] as unknown as Requirements,
): RequiredServerEnvironment<Requirements> {
  const parsed = serverEnvironmentSchema.parse(input);
  const missing = requirements.flatMap((requirement) =>
    requirementNames[requirement].filter((name) => !parsed[name]),
  );

  if (missing.length > 0) {
    throw new Error(`Missing required server environment variables: ${missing.join(", ")}`);
  }

  if (requirements.includes("authentication") && (parsed.BETTER_AUTH_SECRET?.length ?? 0) < 32) {
    throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters.");
  }

  if (
    parsed.SHARE_LINK_ENCRYPTION_KEY &&
    !parseShareLinkEncryptionKey(parsed.SHARE_LINK_ENCRYPTION_KEY)
  ) {
    throw new Error(
      "SHARE_LINK_ENCRYPTION_KEY must be a 32-byte base64url value.",
    );
  }

  return parsed as RequiredServerEnvironment<Requirements>;
}
