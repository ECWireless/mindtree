import { z } from "zod";

const optionalUrl = z.union([z.literal(""), z.url()]).transform((value) => value || undefined);
const optionalNonEmpty = z
  .union([z.literal(""), z.string().trim().min(1)])
  .transform((value) => value || undefined);

const serverEnvironmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: optionalUrl.optional(),
  DATABASE_URL_UNPOOLED: optionalUrl.optional(),
  BETTER_AUTH_SECRET: optionalNonEmpty.optional(),
  BETTER_AUTH_URL: optionalUrl.optional(),
  GOOGLE_CLIENT_ID: optionalNonEmpty.optional(),
  GOOGLE_CLIENT_SECRET: optionalNonEmpty.optional(),
  ALLOWED_EMAIL: z.union([z.literal(""), z.email()]).transform((value) => value || undefined).optional(),
  OPENAI_API_KEY: optionalNonEmpty.optional(),
});

export type ServerEnvironment = z.infer<typeof serverEnvironmentSchema>;

export type ServerEnvironmentRequirement =
  | "database"
  | "authentication"
  | "openai";

const requirementNames: Record<ServerEnvironmentRequirement, readonly (keyof ServerEnvironment)[]> = {
  database: ["DATABASE_URL"],
  authentication: [
    "BETTER_AUTH_SECRET",
    "BETTER_AUTH_URL",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "ALLOWED_EMAIL",
  ],
  openai: ["OPENAI_API_KEY"],
};

export function parseServerEnvironment(
  input: NodeJS.ProcessEnv,
  requirements: readonly ServerEnvironmentRequirement[] = [],
): ServerEnvironment {
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

  return parsed;
}
