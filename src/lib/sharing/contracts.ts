import { z } from "zod";

export const BRANCH_SHARE_SECRET_BYTES = 32;
export const BRANCH_SHARE_SECRET_LENGTH = 43;
export const MAX_PUBLIC_TRAIL_NODES = 500;
export const MAX_PUBLIC_TRAIL_SERIALIZED_BYTES = 4 * 1_024 * 1_024;

export const branchShareSecretSchema = z
  .string()
  .length(BRANCH_SHARE_SECRET_LENGTH)
  .regex(/^[A-Za-z0-9_-]+$/);

export const branchShareRootInputSchema = z.object({
  nodeId: z.uuid(),
}).strict();

export const publicTrailSelectionSchema = z.uuid();

export type BranchShareLinkState = {
  id: string;
  rootNodeId: string;
  createdAt: string;
};

export type CreateBranchShareLinkResult =
  | {
      ok: true;
      link: BranchShareLinkState;
      secret: string;
    }
  | { ok: false; message: string };

export type RevokeBranchShareLinkResult =
  | { ok: true; nodeId: string; revoked: boolean }
  | { ok: false; message: string };

export type PublicInternalCitation = {
  kind: "internal";
  ordinal: number;
  startUtf16: number;
  endUtf16: number;
  targetNodeId: string | null;
};

export type PublicExternalCitation = {
  kind: "external";
  ordinal: number;
  startUtf16: number;
  endUtf16: number;
  title: string;
  url: string;
};

export type PublicSynthesisCitation =
  | PublicInternalCitation
  | PublicExternalCitation;

export type PublicThoughtTrailNode = {
  id: string;
  parentId: string | null;
  position: number;
  title: string;
  summary: {
    content: string;
    citations: PublicSynthesisCitation[];
  } | null;
  branchOutline: { content: string } | null;
};

export type PublicThoughtTrail = {
  rootNodeId: string;
  selectedNodeId: string;
  nodes: PublicThoughtTrailNode[];
};
