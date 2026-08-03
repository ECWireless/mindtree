import "server-only";

import {
  parseServerEnvironment,
  type RequiredServerEnvironment,
  type ServerEnvironmentRequirement,
} from "./contracts";

export function getServerEnvironment<
  const Requirements extends readonly ServerEnvironmentRequirement[] = [],
>(
  requirements: Requirements = [] as unknown as Requirements,
): RequiredServerEnvironment<Requirements> {
  return parseServerEnvironment(process.env, requirements);
}
