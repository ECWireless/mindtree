"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import type {
  CreateNodeInput,
  MoveNodeInput,
  NodeActionResult,
  NodeLifecycleInput,
  RenameNodeInput,
} from "@/lib/nodes/contracts";
import { requireAuthorizedSession } from "@/lib/server/authorization";
import {
  archiveNodeForUser,
  createNodeForUser,
  deleteNodeForUser,
  moveNodeForUser,
  NodeMutationError,
  renameNodeForUser,
  unarchiveNodeForUser,
} from "@/lib/server/node-service";

const titleSchema = z
  .string()
  .trim()
  .min(1, "Enter a title.")
  .max(200, "Use 200 characters or fewer.");

const createNodeSchema = z.object({
  title: titleSchema,
  parentId: z.uuid().nullable().optional(),
});

const renameNodeSchema = z.object({
  id: z.uuid(),
  title: titleSchema,
});

const moveNodeSchema = z.object({
  id: z.uuid(),
  parentId: z.uuid().nullable(),
  position: z.int().min(0).optional(),
});

const nodeLifecycleSchema = z.object({
  id: z.uuid(),
});

function validationFailure(error: z.ZodError): NodeActionResult {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const field = issue.path[0]?.toString() ?? "form";
    fieldErrors[field] = [...(fieldErrors[field] ?? []), issue.message];
  }
  return { ok: false, message: "Check the highlighted fields.", fieldErrors };
}

function mutationFailure(error: unknown): NodeActionResult {
  if (error instanceof NodeMutationError) {
    switch (error.reason) {
      case "archived-parent":
        return {
          ok: false,
          message: "Unarchive that destination before placing an active thought there.",
        };
      case "cycle":
        return { ok: false, message: "A node cannot be moved inside its own subtree." };
      case "invalid-position":
        return { ok: false, message: "That destination changed. Choose a position again." };
      case "node-not-found":
        return { ok: false, message: "That node is no longer available." };
      case "parent-not-found":
        return { ok: false, message: "That parent node is no longer available." };
      case "position-conflict":
        return { ok: false, message: "The node order changed. Please try again." };
      case "unavailable":
        return { ok: false, message: "MindTree couldn’t save that change. Please try again." };
    }
  }
  throw error;
}

export async function createNode(input: CreateNodeInput): Promise<NodeActionResult> {
  const session = await requireAuthorizedSession();
  const parsed = createNodeSchema.safeParse(input);
  if (!parsed.success) {
    return validationFailure(parsed.error);
  }

  try {
    const created = await createNodeForUser(session.user.id, parsed.data);
    revalidatePath("/");
    return { ok: true, nodeId: created.id };
  } catch (error) {
    return mutationFailure(error);
  }
}

export async function renameNode(input: RenameNodeInput): Promise<NodeActionResult> {
  const session = await requireAuthorizedSession();
  const parsed = renameNodeSchema.safeParse(input);
  if (!parsed.success) {
    return validationFailure(parsed.error);
  }

  try {
    const renamed = await renameNodeForUser(session.user.id, parsed.data);
    revalidatePath("/");
    return { ok: true, nodeId: renamed.id };
  } catch (error) {
    return mutationFailure(error);
  }
}

export async function moveNode(input: MoveNodeInput): Promise<NodeActionResult> {
  const session = await requireAuthorizedSession();
  const parsed = moveNodeSchema.safeParse(input);
  if (!parsed.success) {
    return validationFailure(parsed.error);
  }

  try {
    const moved = await moveNodeForUser(session.user.id, parsed.data);
    revalidatePath("/");
    return { ok: true, nodeId: moved.id };
  } catch (error) {
    return mutationFailure(error);
  }
}

export async function archiveNode(input: NodeLifecycleInput): Promise<NodeActionResult> {
  const session = await requireAuthorizedSession();
  const parsed = nodeLifecycleSchema.safeParse(input);
  if (!parsed.success) {
    return validationFailure(parsed.error);
  }

  try {
    const archived = await archiveNodeForUser(session.user.id, parsed.data);
    revalidatePath("/");
    return { ok: true, nodeId: archived.id };
  } catch (error) {
    return mutationFailure(error);
  }
}

export async function unarchiveNode(input: NodeLifecycleInput): Promise<NodeActionResult> {
  const session = await requireAuthorizedSession();
  const parsed = nodeLifecycleSchema.safeParse(input);
  if (!parsed.success) {
    return validationFailure(parsed.error);
  }

  try {
    const unarchived = await unarchiveNodeForUser(session.user.id, parsed.data);
    revalidatePath("/");
    return { ok: true, nodeId: unarchived.id };
  } catch (error) {
    return mutationFailure(error);
  }
}

export async function deleteNode(input: NodeLifecycleInput): Promise<NodeActionResult> {
  const session = await requireAuthorizedSession();
  const parsed = nodeLifecycleSchema.safeParse(input);
  if (!parsed.success) {
    return validationFailure(parsed.error);
  }

  try {
    const deleted = await deleteNodeForUser(session.user.id, parsed.data);
    revalidatePath("/");
    return {
      ok: true,
      nodeId: deleted.nodeId,
      recoveryNodeId: deleted.recoveryNodeId,
    };
  } catch (error) {
    return mutationFailure(error);
  }
}
