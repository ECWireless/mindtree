import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { DrizzleError, DrizzleQueryError } from "drizzle-orm/errors";

import { db } from "@/db/client";
import {
  nodeEmbeddings,
  nodes,
  synthesisVersions,
  user,
} from "@/db/schema";
import {
  OPENAI_EMBEDDING_DIMENSIONS,
  OPENAI_EMBEDDING_MODEL,
} from "@/lib/ai/openai-profiles";
import {
  OpenAIEmbeddingError,
  type OpenAIEmbeddingFailureCode,
} from "@/lib/server/openai-embeddings";

type EmbeddingTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type EmbeddingRefreshResult =
  | { status: "refreshed" }
  | { status: "skipped"; reason: "not-current" }
  | {
      status: "failed";
      reason: OpenAIEmbeddingFailureCode | "storage-unavailable";
    };

type PostgreSqlFailure = { code: string };

function getPostgreSqlFailure(error: unknown): PostgreSqlFailure | null {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) return null;
    if ("code" in current && typeof current.code === "string") {
      return { code: current.code };
    }
    current = "cause" in current ? current.cause : null;
  }
  return null;
}

async function getCurrentApprovedContent(
  userId: string,
  nodeId: string,
  synthesisVersionId: string,
) {
  const [current] = await db
    .select({ content: synthesisVersions.content })
    .from(nodes)
    .innerJoin(
      synthesisVersions,
      and(
        eq(synthesisVersions.userId, nodes.userId),
        eq(synthesisVersions.nodeId, nodes.id),
        eq(synthesisVersions.id, nodes.publishedSynthesisVersionId),
      ),
    )
    .where(and(
      eq(nodes.userId, userId),
      eq(nodes.id, nodeId),
      eq(nodes.publishedSynthesisVersionId, synthesisVersionId),
      eq(synthesisVersions.status, "approved"),
    ));
  return current?.content ?? null;
}

async function lockCurrentApprovedVersion(
  tx: EmbeddingTransaction,
  userId: string,
  nodeId: string,
  synthesisVersionId: string,
) {
  await tx.execute(sql`select ${user.id} from ${user} where ${user.id} = ${userId} for update`);
  const [node] = await tx
    .select({ publishedSynthesisVersionId: nodes.publishedSynthesisVersionId })
    .from(nodes)
    .where(and(eq(nodes.userId, userId), eq(nodes.id, nodeId)))
    .for("update");
  if (node?.publishedSynthesisVersionId !== synthesisVersionId) return false;

  const [version] = await tx
    .select({ status: synthesisVersions.status })
    .from(synthesisVersions)
    .where(and(
      eq(synthesisVersions.userId, userId),
      eq(synthesisVersions.nodeId, nodeId),
      eq(synthesisVersions.id, synthesisVersionId),
    ));
  return version?.status === "approved";
}

export async function refreshApprovedSynthesisEmbeddingForUser(
  userId: string,
  input: {
    nodeId: string;
    synthesisVersionId: string;
    embed: (content: string) => Promise<number[]>;
  },
): Promise<EmbeddingRefreshResult> {
  try {
    const content = await getCurrentApprovedContent(
      userId,
      input.nodeId,
      input.synthesisVersionId,
    );
    if (content === null) return { status: "skipped", reason: "not-current" };

    const embedding = await input.embed(content);
    if (
      embedding.length !== OPENAI_EMBEDDING_DIMENSIONS ||
      !embedding.every(Number.isFinite) ||
      !embedding.some((value) => value !== 0)
    ) {
      return { status: "failed", reason: "response-invalid" };
    }

    return await db.transaction(async (tx) => {
      if (!await lockCurrentApprovedVersion(
        tx,
        userId,
        input.nodeId,
        input.synthesisVersionId,
      )) {
        return { status: "skipped", reason: "not-current" } as const;
      }
      const now = new Date();
      await tx
        .insert(nodeEmbeddings)
        .values({
          userId,
          nodeId: input.nodeId,
          sourceSynthesisVersionId: input.synthesisVersionId,
          model: OPENAI_EMBEDDING_MODEL,
          dimensions: OPENAI_EMBEDDING_DIMENSIONS,
          embedding,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [nodeEmbeddings.userId, nodeEmbeddings.nodeId],
          set: {
            sourceSynthesisVersionId: input.synthesisVersionId,
            model: OPENAI_EMBEDDING_MODEL,
            dimensions: OPENAI_EMBEDDING_DIMENSIONS,
            embedding,
            updatedAt: now,
          },
        });
      return { status: "refreshed" } as const;
    });
  } catch (error) {
    if (error instanceof OpenAIEmbeddingError) {
      return { status: "failed", reason: error.failureCode };
    }
    if (
      error instanceof DrizzleError ||
      error instanceof DrizzleQueryError ||
      getPostgreSqlFailure(error)
    ) {
      return { status: "failed", reason: "storage-unavailable" };
    }
    throw error;
  }
}
