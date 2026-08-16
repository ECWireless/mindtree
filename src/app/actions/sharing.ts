"use server";

import { revalidatePath } from "next/cache";

import {
  branchShareRootInputSchema,
  type CreateBranchShareLinkResult,
  type RevokeBranchShareLinkResult,
} from "@/lib/sharing/contracts";
import { requireAuthorizedSession } from "@/lib/server/authorization";
import {
  BranchShareServiceError,
  createBranchShareLinkForUser,
  revokeBranchShareLinkForUser,
} from "@/lib/server/share-service";

function shareFailure(
  error: unknown,
): { ok: false; message: string } {
  if (error instanceof BranchShareServiceError) {
    switch (error.reason) {
      case "archived-root":
        return {
          ok: false,
          message: "Unarchive this thought before sharing its trail.",
        };
      case "link-exists":
        return {
          ok: false,
          message: "This thought already has a share link. Revoke it before creating another.",
        };
      case "node-not-found":
        return { ok: false, message: "That thought is no longer available." };
      case "invalid-link":
      case "not-found":
      case "oversized":
      case "unavailable":
        return {
          ok: false,
          message: "MindTree couldn’t update sharing right now. Please try again.",
        };
    }
  }
  throw error;
}

export async function createBranchShareLink(
  input: unknown,
): Promise<CreateBranchShareLinkResult> {
  const session = await requireAuthorizedSession();
  const parsed = branchShareRootInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: "That thought is invalid." };
  }
  try {
    const created = await createBranchShareLinkForUser(
      session.user.id,
      parsed.data.nodeId,
    );
    revalidatePath("/");
    return { ok: true, ...created };
  } catch (error) {
    return shareFailure(error);
  }
}

export async function revokeBranchShareLink(
  input: unknown,
): Promise<RevokeBranchShareLinkResult> {
  const session = await requireAuthorizedSession();
  const parsed = branchShareRootInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: "That thought is invalid." };
  }
  try {
    const revoked = await revokeBranchShareLinkForUser(
      session.user.id,
      parsed.data.nodeId,
    );
    revalidatePath("/");
    return { ok: true, ...revoked };
  } catch (error) {
    return shareFailure(error);
  }
}
