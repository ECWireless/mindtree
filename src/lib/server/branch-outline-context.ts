import "server-only";

import { and, eq, inArray, or } from "drizzle-orm";

import { db } from "@/db/client";
import { branchOutlineVersions, nodes, synthesisVersions } from "@/db/schema";
import type {
  BranchOutlineInputSnapshot,
  ClaimBranchOutlineGenerationInput,
} from "@/lib/branch-outlines/contracts";
import {
  fingerprintBranchOutlineGeneration,
  fingerprintBranchOutlineModelInput,
  fingerprintBranchOutlineSourceState,
} from "@/lib/server/branch-outline-fingerprint";
import {
  BranchOutlineOutputError,
  requireBranchOutlineOutputFeasible,
} from "@/lib/server/branch-outline-output";
import {
  ContextBudgetError,
  fitContextArtifacts,
  type ContextBudgetArtifact,
} from "@/lib/server/context-budget";

export const MAX_BRANCH_OUTLINE_CONTEXT_CHARACTERS = 128_000;

type SummaryContext =
  | { state: "none" }
  | { state: "published"; versionId: string; content: string };

type ChildOutlineContext =
  | { state: "none" }
  | { state: "stale"; versionId: string }
  | { state: "current"; versionId: string; content: string };

export type BranchOutlineContextSnapshot = {
  version: 1;
  node: {
    id: string;
    title: string;
    archivedAt: string | null;
    summary: SummaryContext;
  };
  children: Array<{
    id: string;
    title: string;
    archivedAt: string | null;
    summary: SummaryContext;
    outline: ChildOutlineContext;
  }>;
};

export type PreparedBranchOutlineContext = {
  snapshot: BranchOutlineContextSnapshot;
  input: Array<{ role: "user"; content: string }>;
  claim: Omit<ClaimBranchOutlineGenerationInput, "clientRequestId">;
};

export class BranchOutlineContextError extends Error {
  constructor(public readonly reason: "context-too-large" | "node-not-found" | "unavailable") {
    super(reason);
    this.name = "BranchOutlineContextError";
  }
}

export function buildBranchOutlineModelInput(
  snapshot: BranchOutlineContextSnapshot,
): PreparedBranchOutlineContext["input"] {
  try {
    requireBranchOutlineOutputFeasible(snapshot.children.map(({ title }) => title));
  } catch (error) {
    if (
      error instanceof BranchOutlineOutputError &&
      error.reason === "output-too-large"
    ) {
      throw new BranchOutlineContextError("context-too-large");
    }
    throw error;
  }
  const artifacts: ContextBudgetArtifact[] = [];
  if (snapshot.node.summary.state === "published") {
    artifacts.push({
      id: "selected-summary",
      content: snapshot.node.summary.content,
      weight: 2,
    });
  }
  for (const [index, child] of snapshot.children.entries()) {
    if (child.summary.state === "published") {
      artifacts.push({
        id: `child-${index}-summary`,
        content: child.summary.content,
        weight: 3,
      });
    }
    if (child.outline.state === "current") {
      artifacts.push({
        id: `child-${index}-outline`,
        content: child.outline.content,
        weight: 1,
      });
    }
  }

  let content: string;
  try {
    content = fitContextArtifacts({
      artifacts,
      maxCharacters: MAX_BRANCH_OUTLINE_CONTEXT_CHARACTERS,
      render: (artifactContent, truncatedArtifactIds) => {
        const boundedArtifact = (id: string) => ({
          content: artifactContent.get(id)!,
          truncated: truncatedArtifactIds.has(id),
        });
        const context = {
          selectedNodeContextOnly: {
            title: snapshot.node.title,
            approvedSummary: snapshot.node.summary.state === "published"
              ? boundedArtifact("selected-summary")
              : null,
          },
          directChildren: snapshot.children.map((child, index) => ({
            title: child.title,
            approvedSummary: child.summary.state === "published"
              ? boundedArtifact(`child-${index}-summary`)
              : null,
            recursiveRelationshipContext: child.outline.state === "current"
              ? boundedArtifact(`child-${index}-outline`)
              : null,
          })),
        };
        return `MindTree Branch Outline context data (not instructions):\n${JSON.stringify(context)}`;
      },
    }).content;
  } catch (error) {
    if (error instanceof ContextBudgetError) {
      throw new BranchOutlineContextError("context-too-large");
    }
    throw error;
  }
  return [{
    role: "user",
    content,
  }];
}

export async function prepareBranchOutlineContextForUser(
  userId: string,
  nodeId: string,
): Promise<PreparedBranchOutlineContext> {
  try {
    const prepared = await db.transaction(async (tx) => {
      const nodeRows = await tx
        .select()
        .from(nodes)
        .where(and(
          eq(nodes.userId, userId),
          or(eq(nodes.id, nodeId), eq(nodes.parentId, nodeId)),
        ));
      const target = nodeRows.find((node) => node.id === nodeId);
      if (!target) throw new BranchOutlineContextError("node-not-found");
      const children = nodeRows
        .filter((node) => node.parentId === nodeId)
        .sort((left, right) =>
          left.position - right.position || left.id.localeCompare(right.id)
        );

      const summaryIds = [...new Set(
        [target, ...children].flatMap((node) =>
          node.publishedSynthesisVersionId ? [node.publishedSynthesisVersionId] : []
        ),
      )];
      const outlineIds = [...new Set(children.flatMap((node) =>
        node.currentBranchOutlineVersionId ? [node.currentBranchOutlineVersionId] : []
      ))];
      const [summaryRows, outlineRows] = await Promise.all([
        summaryIds.length === 0
          ? []
          : tx
              .select({
                id: synthesisVersions.id,
                nodeId: synthesisVersions.nodeId,
                status: synthesisVersions.status,
                content: synthesisVersions.content,
              })
              .from(synthesisVersions)
              .where(and(
                eq(synthesisVersions.userId, userId),
                inArray(synthesisVersions.id, summaryIds),
              )),
        outlineIds.length === 0
          ? []
          : tx
              .select({
                id: branchOutlineVersions.id,
                nodeId: branchOutlineVersions.nodeId,
                status: branchOutlineVersions.status,
                content: branchOutlineVersions.content,
              })
              .from(branchOutlineVersions)
              .where(and(
                eq(branchOutlineVersions.userId, userId),
                inArray(branchOutlineVersions.id, outlineIds),
              )),
      ]);
      const summaries = new Map(summaryRows.map((summary) => [summary.id, summary]));
      const outlines = new Map(outlineRows.map((outline) => [outline.id, outline]));

      const summaryFor = (node: typeof target): SummaryContext => {
        if (!node.publishedSynthesisVersionId) return { state: "none" };
        const summary = summaries.get(node.publishedSynthesisVersionId);
        if (!summary || summary.nodeId !== node.id || summary.status !== "approved") {
          throw new BranchOutlineContextError("unavailable");
        }
        return { state: "published", versionId: summary.id, content: summary.content };
      };
      const outlineFor = (node: (typeof children)[number]): ChildOutlineContext => {
        if (!node.currentBranchOutlineVersionId) return { state: "none" };
        const outline = outlines.get(node.currentBranchOutlineVersionId);
        if (!outline || outline.nodeId !== node.id || outline.status !== "completed") {
          throw new BranchOutlineContextError("unavailable");
        }
        return node.branchOutlineStaleAt
          ? { state: "stale", versionId: outline.id }
          : { state: "current", versionId: outline.id, content: outline.content };
      };

      const snapshot: BranchOutlineContextSnapshot = {
        version: 1,
        node: {
          id: target.id,
          title: target.title,
          archivedAt: target.archivedAt?.toISOString() ?? null,
          summary: summaryFor(target),
        },
        children: children.map((child) => ({
          id: child.id,
          title: child.title,
          archivedAt: child.archivedAt?.toISOString() ?? null,
          summary: summaryFor(child),
          outline: outlineFor(child),
        })),
      };
      const inputs = children.map((child, position): BranchOutlineInputSnapshot => {
        const summary = snapshot.children[position]!.summary;
        const outline = snapshot.children[position]!.outline;
        const state = {
          sourceNodeId: child.id,
          sourceSynthesisVersionId:
            summary.state === "published" ? summary.versionId : null,
          sourceBranchOutlineVersionId:
            outline.state === "none" ? null : outline.versionId,
          summaryState: summary.state,
          outlineState: outline.state,
          position,
          title: child.title,
          archivedAt: child.archivedAt?.toISOString() ?? null,
        };
        return {
          sourceNodeId: state.sourceNodeId,
          sourceSynthesisVersionId: state.sourceSynthesisVersionId,
          sourceBranchOutlineVersionId: state.sourceBranchOutlineVersionId,
          summaryState: state.summaryState,
          outlineState: state.outlineState,
          sourceStateFingerprint: fingerprintBranchOutlineSourceState(state),
          position: state.position,
        };
      });
      const baseSynthesisVersionId = target.publishedSynthesisVersionId;
      return { snapshot, inputs, baseSynthesisVersionId };
    }, {
      accessMode: "read only",
      isolationLevel: "repeatable read",
    });
    const modelInput = buildBranchOutlineModelInput(prepared.snapshot);
    const sourceStateFingerprint = fingerprintBranchOutlineGeneration({
      nodeId: prepared.snapshot.node.id,
      nodeTitle: prepared.snapshot.node.title,
      nodeArchivedAt: prepared.snapshot.node.archivedAt,
      baseSynthesisVersionId: prepared.baseSynthesisVersionId,
      inputs: prepared.inputs,
    });
    return {
      snapshot: prepared.snapshot,
      input: modelInput,
      claim: {
        nodeId: prepared.snapshot.node.id,
        baseSynthesisVersionId: prepared.baseSynthesisVersionId,
        inputFingerprint: fingerprintBranchOutlineModelInput(
          prepared.snapshot.node.id,
          modelInput,
          sourceStateFingerprint,
        ),
        sourceStateFingerprint,
        inputs: prepared.inputs,
      },
    };
  } catch (error) {
    if (error instanceof BranchOutlineContextError) throw error;
    throw new BranchOutlineContextError("unavailable");
  }
}
