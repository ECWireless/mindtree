import { describe, expect, it } from "vitest";

import { parseServerEnvironment } from "@/lib/env/contracts";
import { getPublicEnvironment } from "@/lib/env/public";

const syntheticEnvironment = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://mindtree:synthetic@localhost:5432/mindtree",
  DATABASE_URL_UNPOOLED: "postgresql://mindtree:synthetic@localhost:5432/mindtree",
  BETTER_AUTH_SECRET: "synthetic-auth-secret-with-at-least-32-characters",
  BETTER_AUTH_URL: "http://localhost:3000",
  GOOGLE_CLIENT_ID: "synthetic-google-client-id",
  GOOGLE_CLIENT_SECRET: "synthetic-google-client-secret",
  ALLOWED_EMAIL: "owner@example.test",
  OPENAI_API_KEY: "synthetic-openai-key",
} satisfies NodeJS.ProcessEnv;

describe("parseServerEnvironment", () => {
  it("keeps future integrations optional before their phases", () => {
    expect(parseServerEnvironment({} as NodeJS.ProcessEnv)).toEqual({
      NODE_ENV: "development",
    });
  });

  it("accepts the complete synthetic server contract", () => {
    expect(
      parseServerEnvironment(syntheticEnvironment, ["database", "authentication", "openai"]),
    ).toEqual(syntheticEnvironment);
  });

  it("keeps the direct migration URL optional for the database requirement", () => {
    const environment = parseServerEnvironment(
      {
        NODE_ENV: "test",
        DATABASE_URL: syntheticEnvironment.DATABASE_URL,
      },
      ["database"],
    );

    expect(environment.DATABASE_URL).toBe(syntheticEnvironment.DATABASE_URL);
    expect(environment.DATABASE_URL_UNPOOLED).toBeUndefined();
  });

  it.each([
    ["database", "DATABASE_URL"],
    [
      "authentication",
      "BETTER_AUTH_SECRET, BETTER_AUTH_URL, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ALLOWED_EMAIL",
    ],
    ["openai", "OPENAI_API_KEY"],
  ] as const)("reports missing %s configuration by variable name", (requirement, names) => {
    expect(() => parseServerEnvironment({ NODE_ENV: "production" }, [requirement])).toThrow(
      `Missing required server environment variables: ${names}`,
    );
  });

  it("rejects a short authentication secret without echoing its value", () => {
    const shortSecret = "synthetic-but-short";

    expect(() =>
      parseServerEnvironment(
        { ...syntheticEnvironment, BETTER_AUTH_SECRET: shortSecret },
        ["authentication"],
      ),
    ).toThrow("BETTER_AUTH_SECRET must contain at least 32 characters.");

    try {
      parseServerEnvironment(
        { ...syntheticEnvironment, BETTER_AUTH_SECRET: shortSecret },
        ["authentication"],
      );
    } catch (error) {
      expect(String(error)).not.toContain(shortSecret);
    }
  });

  it.each([
    ["DATABASE_URL", "not-a-url"],
    ["BETTER_AUTH_URL", "not-a-url"],
    ["ALLOWED_EMAIL", "not-an-email"],
  ] as const)("rejects an invalid %s", (name, value) => {
    expect(() =>
      parseServerEnvironment({ ...syntheticEnvironment, [name]: value }),
    ).toThrow();
  });
});

describe("getPublicEnvironment", () => {
  it("returns a frozen empty allowlist", () => {
    const environment = getPublicEnvironment();

    expect(environment).toEqual({});
    expect(Object.isFrozen(environment)).toBe(true);
  });
});
