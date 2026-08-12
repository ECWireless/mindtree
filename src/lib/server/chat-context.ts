import "server-only";

import { createHash } from "node:crypto";

import { and, asc, desc, eq, inArray, lt, or, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  branchOutlineVersions,
  chatMessages,
  citations,
  nodes,
  synthesisVersions,
} from "@/db/schema";
import type { RetryChatTurnInput } from "@/lib/chat/contracts";
import type { ExternalCitationView } from "@/lib/citations/contracts";
import {
  createExternalCitationEvidence,
  ExternalCitationValidationError,
  mergeExternalCitationEvidence,
  type ExternalCitationEvidence,
} from "@/lib/server/external-citations";
import {
  assignInternalEvidenceAliases,
  type InternalCitationEvidence,
} from "@/lib/server/internal-citations";
import { getRelatedNodesForUser } from "@/lib/server/related-node-retrieval";
import { fingerprintSynthesisOutlineInput } from "@/lib/server/synthesis-input-fingerprint";

export const MAX_CHAT_CONTEXT_MESSAGES = 24;
export const MAX_CHAT_CONTEXT_CHARACTERS = 48_000;
export const MAX_CHAT_BREADCRUMB_NODES = 64;
export const MAX_CHAT_BREADCRUMB_CHARACTERS = 8_000;
export const MAX_CHAT_METADATA_CHARACTERS = 31_000;
export const MAX_RELATED_EVIDENCE_CHARACTERS = 10_000;
export const MAX_RELATED_EVIDENCE_ITEM_CHARACTERS = 2_500;

export type ChatContextMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  sequence: string;
};

export type ChatContextSnapshot = {
  version: 7;
  node: {
    id: string;
    title: string;
    breadcrumb: {
      items: Array<{ id: string; title: string }>;
      hasOmittedAncestors: boolean;
    };
    publishedSynthesis:
      | { state: "none" }
      | { state: "published"; versionId: string; content: string };
    refinementProposal:
      | { state: "none" }
      | {
          state: "pending";
          versionId: string;
          baseVersionId: string | null;
          content: string;
        };
    branchOutline:
      | { state: "none" }
      | {
          state: "current" | "stale";
          versionId: string;
          content: string;
        };
  };
  relatedEvidence: InternalCitationEvidence[];
  externalEvidence: ExternalCitationEvidence[];
  messages: ChatContextMessage[];
};

export type PreparedChatContext = {
  snapshot: ChatContextSnapshot;
  fingerprint: string;
  input: Array<{ role: "user" | "assistant"; content: string }>;
  synthesisFingerprint: string;
  synthesisInput: Array<{ role: "user" | "assistant"; content: string }>;
  relatedInputs: InternalCitationEvidence[];
  externalEvidence: ExternalCitationEvidence[];
  outlineInput: {
    versionId: string;
    sourceStateFingerprint: string;
  } | null;
};

export function fingerprintChatContextInput(
  nodeId: string,
  input: PreparedChatContext["input"],
) {
  return createHash("sha256")
    .update(JSON.stringify({ version: 1, nodeId, input }), "utf8")
    .digest("hex");
}

function truncateContextArtifact(content: string, limit: number) {
  const marker = "\n\n[Context truncated]";
  if (content.length <= limit) return content;
  if (limit <= marker.length) return marker.slice(0, limit);
  return `${content.slice(0, limit - marker.length)}${marker}`;
}

function contextMetadata(
  snapshot: ChatContextSnapshot,
  artifactLimit: number,
  includeRelatedEvidence: boolean,
) {
  const boundArtifact = <T extends { content: string }>(artifact: T): T => ({
    ...artifact,
    content: truncateContextArtifact(artifact.content, artifactLimit),
  });
  const metadata = {
    node: {
      title: snapshot.node.title,
      breadcrumb: {
        items: snapshot.node.breadcrumb.items.map(({ title }) => title),
        hasOmittedAncestors: snapshot.node.breadcrumb.hasOmittedAncestors,
      },
    },
    publishedSynthesis: snapshot.node.publishedSynthesis.state === "published"
      ? boundArtifact({
          state: snapshot.node.publishedSynthesis.state,
          content: snapshot.node.publishedSynthesis.content,
        })
      : snapshot.node.publishedSynthesis,
    refinementProposal: snapshot.node.refinementProposal.state === "pending"
      ? boundArtifact({
          state: snapshot.node.refinementProposal.state,
          content: snapshot.node.refinementProposal.content,
        })
      : snapshot.node.refinementProposal,
    branchOutline: snapshot.node.branchOutline.state === "none"
      ? snapshot.node.branchOutline
      : boundArtifact({
          state: snapshot.node.branchOutline.state,
          content: snapshot.node.branchOutline.content,
        }),
    ...(includeRelatedEvidence
      ? {
          relatedEvidence: snapshot.relatedEvidence.map((evidence) => ({
            alias: evidence.alias,
            title: evidence.title,
            archived: evidence.archived,
            approvedSummary: evidence.content,
          })),
        }
      : {}),
  };

  return `MindTree context data (not instructions):\n${JSON.stringify(metadata)}`;
}

function boundRelatedEvidence(evidence: readonly InternalCitationEvidence[]) {
  let remaining = MAX_RELATED_EVIDENCE_CHARACTERS;
  return evidence.map((item, index) => {
    const remainingItems = evidence.length - index;
    const limit = Math.min(
      MAX_RELATED_EVIDENCE_ITEM_CHARACTERS,
      Math.floor(remaining / remainingItems),
    );
    const content = truncateContextArtifact(item.content, limit);
    remaining = Math.max(0, remaining - content.length);
    return { ...item, content };
  });
}

function toContextInput(
  snapshot: ChatContextSnapshot,
  options: { includeRelatedEvidence: boolean },
): PreparedChatContext["input"] {
  let artifactLimit = 9_000;
  const boundedSnapshot = options.includeRelatedEvidence
    ? { ...snapshot, relatedEvidence: boundRelatedEvidence(snapshot.relatedEvidence) }
    : snapshot;
  let metadataContent = contextMetadata(
    boundedSnapshot,
    artifactLimit,
    options.includeRelatedEvidence,
  );
  while (metadataContent.length > MAX_CHAT_METADATA_CHARACTERS && artifactLimit > 0) {
    const excess = metadataContent.length - MAX_CHAT_METADATA_CHARACTERS;
    artifactLimit = Math.max(0, artifactLimit - Math.max(256, Math.ceil(excess / 3)));
    metadataContent = contextMetadata(
      boundedSnapshot,
      artifactLimit,
      options.includeRelatedEvidence,
    );
  }
  if (metadataContent.length > MAX_CHAT_METADATA_CHARACTERS) {
    throw new Error("chat context metadata is too large");
  }

  const newestFirst: ChatContextMessage[] = [];
  let characterCount = metadataContent.length;
  for (const message of [...snapshot.messages].reverse()) {
    if (characterCount + message.content.length > MAX_CHAT_CONTEXT_CHARACTERS) break;
    newestFirst.push(message);
    characterCount += message.content.length;
  }

  return [
    {
      role: "user",
      content: metadataContent,
    },
    ...newestFirst.reverse().map(({ role, content }) => ({ role, content })),
  ];
}

export async function prepareChatContextForUser(
  userId: string,
  input: RetryChatTurnInput,
): Promise<PreparedChatContext> {
  const baseSnapshot = await db.transaction(async (tx) => {
    const [breadcrumbResult, turnRows] = await Promise.all([
      tx.execute<{
        id: string;
        title: string;
        depth: number;
        published_synthesis_version_id: string | null;
        current_branch_outline_version_id: string | null;
        branch_outline_stale_at: Date | null;
      }>(sql`
        with recursive ancestor_path as (
          select
            ${nodes.id} as id,
            ${nodes.parentId} as parent_id,
            ${nodes.title} as title,
            ${nodes.publishedSynthesisVersionId} as published_synthesis_version_id,
            ${nodes.currentBranchOutlineVersionId} as current_branch_outline_version_id,
            ${nodes.branchOutlineStaleAt} as branch_outline_stale_at,
            0 as depth
          from ${nodes}
          where ${nodes.userId} = ${userId} and ${nodes.id} = ${input.nodeId}

          union all

          select
            parent.id,
            parent.parent_id,
            parent.title,
            parent.published_synthesis_version_id,
            parent.current_branch_outline_version_id,
            parent.branch_outline_stale_at,
            ancestor_path.depth + 1
          from ancestor_path
          inner join ${nodes} parent
            on parent.user_id = ${userId}
            and parent.id = ancestor_path.parent_id
          where ancestor_path.depth < ${MAX_CHAT_BREADCRUMB_NODES}
        )
        select
          ancestor_path.id,
          ancestor_path.title,
          ancestor_path.published_synthesis_version_id,
          ancestor_path.current_branch_outline_version_id,
          ancestor_path.branch_outline_stale_at,
          ancestor_path.depth
        from ancestor_path
        order by ancestor_path.depth asc
        limit ${MAX_CHAT_BREADCRUMB_NODES + 1}
      `),
      tx
        .select({
          role: chatMessages.role,
          status: chatMessages.status,
          sequence: chatMessages.sequence,
          proposalRequested: chatMessages.proposalRequested,
          refinementProposalId: chatMessages.refinementProposalId,
        })
        .from(chatMessages)
        .where(
          and(
            eq(chatMessages.userId, userId),
            eq(chatMessages.nodeId, input.nodeId),
            eq(chatMessages.clientMessageId, input.clientMessageId),
          ),
        ),
    ]);
    const userMessage = turnRows.find((message) => message.role === "user");
    const assistant = turnRows.find((message) => message.role === "assistant");
    if (
      turnRows.length !== 2 ||
      !userMessage ||
      !assistant ||
      userMessage.status !== "completed" ||
      assistant.status !== "streaming"
    ) {
      throw new Error("chat context turn is unavailable");
    }
    const target = breadcrumbResult.rows[0];
    if (!target || target.depth !== 0) {
      throw new Error("chat context node is unavailable");
    }
    const seenBreadcrumbIds = new Set<string>();
    for (const breadcrumbNode of breadcrumbResult.rows) {
      if (seenBreadcrumbIds.has(breadcrumbNode.id)) {
        throw new Error("chat context breadcrumb is invalid");
      }
      seenBreadcrumbIds.add(breadcrumbNode.id);
    }

    const boundedBreadcrumbNewestFirst: Array<{ id: string; title: string }> = [];
    let breadcrumbCharacterCount = 0;
    for (const breadcrumbNode of breadcrumbResult.rows.slice(
      0,
      MAX_CHAT_BREADCRUMB_NODES,
    )) {
      if (
        boundedBreadcrumbNewestFirst.length > 0 &&
        breadcrumbCharacterCount + breadcrumbNode.title.length >
          MAX_CHAT_BREADCRUMB_CHARACTERS
      ) {
        break;
      }
      boundedBreadcrumbNewestFirst.push({
        id: breadcrumbNode.id,
        title: breadcrumbNode.title,
      });
      breadcrumbCharacterCount += breadcrumbNode.title.length;
    }
    const boundedBreadcrumb = boundedBreadcrumbNewestFirst.reverse();

    let publishedSynthesis: ChatContextSnapshot["node"]["publishedSynthesis"] = {
      state: "none",
    };
    if (target.published_synthesis_version_id) {
      const [published] = await tx
        .select({
          id: synthesisVersions.id,
          content: synthesisVersions.content,
          status: synthesisVersions.status,
        })
        .from(synthesisVersions)
        .where(
          and(
            eq(synthesisVersions.userId, userId),
            eq(synthesisVersions.nodeId, input.nodeId),
            eq(synthesisVersions.id, target.published_synthesis_version_id),
          ),
        );
      if (!published || published.status !== "approved") {
        throw new Error("chat context published synthesis is invalid");
      }
      publishedSynthesis = {
        state: "published",
        versionId: published.id,
        content: published.content,
      };
    }

    const pending = await tx
      .select({
        id: synthesisVersions.id,
        baseVersionId: synthesisVersions.baseVersionId,
        content: synthesisVersions.content,
      })
      .from(synthesisVersions)
      .where(
        and(
          eq(synthesisVersions.userId, userId),
          eq(synthesisVersions.nodeId, input.nodeId),
          eq(synthesisVersions.status, "pending"),
        ),
      )
      .limit(2);
    if (pending.length > 1) {
      throw new Error("chat context pending synthesis is invalid");
    }
    const refinementTarget = pending[0];
    const refinementProposal: ChatContextSnapshot["node"]["refinementProposal"] =
      refinementTarget
        ? {
            state: "pending",
            versionId: refinementTarget.id,
            baseVersionId: refinementTarget.baseVersionId,
            content: refinementTarget.content,
          }
        : { state: "none" };

    let branchOutline: ChatContextSnapshot["node"]["branchOutline"] = {
      state: "none",
    };
    if (target.current_branch_outline_version_id) {
      const [outline] = await tx
        .select({
          id: branchOutlineVersions.id,
          content: branchOutlineVersions.content,
          status: branchOutlineVersions.status,
        })
        .from(branchOutlineVersions)
        .where(and(
          eq(branchOutlineVersions.userId, userId),
          eq(branchOutlineVersions.nodeId, input.nodeId),
          eq(branchOutlineVersions.id, target.current_branch_outline_version_id),
        ));
      if (!outline || outline.status !== "completed") {
        throw new Error("chat context branch outline is invalid");
      }
      branchOutline = {
        state: target.branch_outline_stale_at === null ? "current" : "stale",
        versionId: outline.id,
        content: outline.content,
      };
    }

    const recentRows = await tx
      .select({
        id: chatMessages.id,
        role: chatMessages.role,
        content: chatMessages.content,
        sequence: chatMessages.sequence,
      })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.userId, userId),
          eq(chatMessages.nodeId, input.nodeId),
          eq(chatMessages.status, "completed"),
          lt(chatMessages.sequence, assistant.sequence),
        ),
      )
      .orderBy(desc(chatMessages.sequence))
      .limit(MAX_CHAT_CONTEXT_MESSAGES);

    const boundedNewestFirst: ChatContextMessage[] = [];
    let characterCount = 0;
    for (const message of recentRows) {
      if (
        characterCount + message.content.length > MAX_CHAT_CONTEXT_CHARACTERS
      ) {
        break;
      }
      boundedNewestFirst.push({
        id: message.id,
        role: message.role,
        content: message.content,
        sequence: message.sequence.toString(),
      });
      characterCount += message.content.length;
    }

    const synthesisEvidenceOwner = refinementProposal.state === "pending"
      ? {
          ownerId: refinementProposal.versionId,
          content: refinementProposal.content,
        }
      : publishedSynthesis.state === "published"
        ? {
            ownerId: publishedSynthesis.versionId,
            content: publishedSynthesis.content,
          }
        : null;
    const assistantEvidenceOwners = boundedNewestFirst
      .filter((message) => message.role === "assistant")
      .map((message) => ({ ownerId: message.id, content: message.content }));
    const ownerConditions = [
      ...(synthesisEvidenceOwner
        ? [eq(citations.synthesisVersionId, synthesisEvidenceOwner.ownerId)]
        : []),
      ...(assistantEvidenceOwners.length > 0
        ? [inArray(
            citations.assistantMessageId,
            assistantEvidenceOwners.map(({ ownerId }) => ownerId),
          )]
        : []),
    ];
    const externalRows = ownerConditions.length > 0
      ? await tx
          .select({
            assistantMessageId: citations.assistantMessageId,
            synthesisVersionId: citations.synthesisVersionId,
            ordinal: citations.ordinal,
            startUtf16: citations.startUtf16,
            endUtf16: citations.endUtf16,
            title: citations.externalTitle,
            url: citations.externalUrl,
          })
          .from(citations)
          .where(and(
            eq(citations.userId, userId),
            eq(citations.ownerNodeId, input.nodeId),
            eq(citations.kind, "external"),
            or(...ownerConditions),
          ))
          .orderBy(asc(citations.createdAt), asc(citations.startUtf16))
      : [];
    const evidenceGroups: ExternalCitationEvidence[][] = [];
    const addEvidenceOwner = (
      owner: "assistant-message" | "synthesis-version",
      ownerId: string,
      content: string,
    ) => {
      const ownerRows = externalRows.filter((row) =>
        owner === "assistant-message"
          ? row.assistantMessageId === ownerId
          : row.synthesisVersionId === ownerId
      );
      if (ownerRows.length === 0) return;
      const citationViews: ExternalCitationView[] = ownerRows.map((row) => {
        if (row.title === null || row.url === null) {
          throw new Error("chat context external citation is invalid");
        }
        return {
          kind: "external",
          ordinal: row.ordinal,
          startUtf16: row.startUtf16,
          endUtf16: row.endUtf16,
          title: row.title,
          url: row.url,
        };
      });
      const group = createExternalCitationEvidence({
        content,
        citations: citationViews,
        owner,
        ownerId,
      });
      try {
        mergeExternalCitationEvidence([...evidenceGroups, group]);
        evidenceGroups.push(group);
      } catch (error) {
        if (
          error instanceof ExternalCitationValidationError &&
          (error.reason === "invalid-count" || error.reason === "too-many-sources")
        ) {
          return;
        }
        throw error;
      }
    };
    if (synthesisEvidenceOwner) {
      addEvidenceOwner(
        "synthesis-version",
        synthesisEvidenceOwner.ownerId,
        synthesisEvidenceOwner.content,
      );
    }
    for (const owner of assistantEvidenceOwners) {
      addEvidenceOwner("assistant-message", owner.ownerId, owner.content);
    }
    const externalEvidence = mergeExternalCitationEvidence(evidenceGroups);

    return {
      version: 7,
      node: {
        id: target.id,
        title: target.title,
        breadcrumb: {
          items: boundedBreadcrumb,
          hasOmittedAncestors:
            breadcrumbResult.rows.length > boundedBreadcrumb.length,
        },
        publishedSynthesis,
        refinementProposal,
        branchOutline,
      },
      relatedEvidence: [],
      messages: boundedNewestFirst.reverse(),
      externalEvidence,
    } satisfies ChatContextSnapshot;
  }, {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });

  const relatedInputs = assignInternalEvidenceAliases(
    await getRelatedNodesForUser(userId, {
      targetNodeId: input.nodeId,
      excludeNodeIds: baseSnapshot.node.breadcrumb.items.map(({ id }) => id),
    }),
  );
  const snapshot: ChatContextSnapshot = { ...baseSnapshot, relatedEvidence: relatedInputs };
  const providerInput = toContextInput(snapshot, { includeRelatedEvidence: false });
  const synthesisInput = toContextInput(snapshot, { includeRelatedEvidence: true });
  return {
    snapshot,
    fingerprint: fingerprintChatContextInput(snapshot.node.id, providerInput),
    input: providerInput,
    synthesisFingerprint: fingerprintChatContextInput(snapshot.node.id, synthesisInput),
    synthesisInput,
    relatedInputs,
    externalEvidence: snapshot.externalEvidence,
    outlineInput: snapshot.node.branchOutline.state === "current"
      ? {
          versionId: snapshot.node.branchOutline.versionId,
          sourceStateFingerprint: fingerprintSynthesisOutlineInput({
            nodeId: snapshot.node.id,
            branchOutlineVersionId: snapshot.node.branchOutline.versionId,
          }),
        }
      : null,
  };
}

export async function isSynthesisOutlineInputCurrentForUser(
  userId: string,
  nodeId: string,
  outlineInput: PreparedChatContext["outlineInput"],
) {
  const [node] = await db
    .select({
      currentBranchOutlineVersionId: nodes.currentBranchOutlineVersionId,
      branchOutlineStaleAt: nodes.branchOutlineStaleAt,
    })
    .from(nodes)
    .where(and(eq(nodes.userId, userId), eq(nodes.id, nodeId)));
  if (!node) return false;
  return outlineInput === null
    ? node.currentBranchOutlineVersionId === null
    : node.currentBranchOutlineVersionId === outlineInput.versionId &&
        node.branchOutlineStaleAt === null;
}
