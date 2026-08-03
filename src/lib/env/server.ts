import "server-only";

import {
  parseServerEnvironment,
  type ServerEnvironment,
  type ServerEnvironmentRequirement,
} from "./contracts";

export function getServerEnvironment(
  requirements: readonly ServerEnvironmentRequirement[] = [],
): ServerEnvironment {
  return parseServerEnvironment(process.env, requirements);
}
