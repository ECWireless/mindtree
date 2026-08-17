"use server";

import { revalidatePath } from "next/cache";

import {
  branchShareRootInputSchema,
  type CreateBranchShareLinkResult,
  type RecoverBranchShareLinkResult,
  type RevokeBranchShareLinkResult,
} from "@/lib/sharing/contracts";
import { getServerEnvironment } from "@/lib/env/server";
import { requireAuthorizedSession } from "@/lib/server/authorization";
import {
  BranchShareServiceError,
  createBranchShareLinkForUser,
  recoverBranchShareLinkForUser,
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
      case "unrecoverable-link":
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
    const environment = getServerEnvironment(["sharing-encryption"]);
    const created = await createBranchShareLinkForUser(
      session.user.id,
      parsed.data.nodeId,
      environment.SHARE_LINK_ENCRYPTION_KEY,
    );
    revalidatePath("/");
    return { ok: true, ...created };
  } catch (error) {
    return shareFailure(error);
  }
}

export async function recoverBranchShareLink(
  input: unknown,
): Promise<RecoverBranchShareLinkResult> {
  const session = await requireAuthorizedSession();
  const parsed = branchShareRootInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: "That thought is invalid." };
  }
  try {
    const environment = getServerEnvironment(["sharing-encryption"]);
    return {
      ok: true,
      ...await recoverBranchShareLinkForUser(
        session.user.id,
        parsed.data.nodeId,
        environment.SHARE_LINK_ENCRYPTION_KEY,
      ),
    };
  } catch (error) {
    if (
      error instanceof BranchShareServiceError &&
      error.reason === "unrecoverable-link"
    ) {
      return {
        ok: false,
        message:
          "This older link cannot be displayed again. Revoke it and create a new persistent link.",
      };
    }
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
