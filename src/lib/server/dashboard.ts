import "server-only";

import { requireAuthorizedSession } from "@/lib/server/authorization";
import { getNodeTreeForUser } from "@/lib/server/node-service";

export async function getDashboardData() {
  const session = await requireAuthorizedSession();
  const tree = await getNodeTreeForUser(session.user.id);

  return {
    user: {
      name: session.user.name,
      email: session.user.email,
    },
    ...tree,
  };
}
