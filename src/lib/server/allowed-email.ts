import "server-only";

import { allowedEmailSchema } from "@/lib/env/contracts";

export function getAllowedEmail() {
  return allowedEmailSchema.parse(process.env.ALLOWED_EMAIL);
}
