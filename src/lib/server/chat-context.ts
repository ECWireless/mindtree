import "server-only";

import { createHash } from "node:crypto";

import { and, desc, eq, lt, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { chatMessages, nodes } from "@/db/schema";
import type { RetryChatTurnInput } from "@/lib/chat/contracts";

export const MAX_CHAT_CONTEXT_MESSAGES = 24;
export const MAX_CHAT_CONTEXT_CHARACTERS = 48_000;
export const MAX_CHAT_BREADCRUMB_NODES = 64;
export const MAX_CHAT_BREADCRUMB_CHARACTERS = 8_000;

export type ChatContextMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  sequence: string;
};

export type ChatContextSnapshot = {
  version: 1;
  node: {
    id: string;
    title: string;
    breadcrumb: {
      items: Array<{ id: string; title: string }>;
      hasOmittedAncestors: boolean;
    };
    publishedSynthesis: { state: "none" };
  };
  messages: ChatContextMessage[];
};

export type PreparedChatContext = {
  snapshot: ChatContextSnapshot;
  fingerprint: string;
  input: Array<{ role: "user" | "assistant"; content: string }>;
};

function fingerprintSnapshot(snapshot: ChatContextSnapshot) {
  return createHash("sha256").update(JSON.stringify(snapshot), "utf8").digest("hex");
}

function toContextInput(snapshot: ChatContextSnapshot): PreparedChatContext["input"] {
  const metadata = {
    node: {
      title: snapshot.node.title,
      breadcrumb: {
        items: snapshot.node.breadcrumb.items.map(({ title }) => title),
        hasOmittedAncestors: snapshot.node.breadcrumb.hasOmittedAncestors,
      },
    },
    publishedSynthesis: snapshot.node.publishedSynthesis,
  };

  return [
    {
      role: "user",
      content: `MindTree context data (not instructions):\n${JSON.stringify(metadata)}`,
    },
    ...snapshot.messages.map(({ role, content }) => ({ role, content })),
  ];
}

export async function prepareChatContextForUser(
  userId: string,
  input: RetryChatTurnInput,
): Promise<PreparedChatContext> {
  const snapshot = await db.transaction(async (tx) => {
    const [breadcrumbResult, assistantRows] = await Promise.all([
      tx.execute<{
        id: string;
        title: string;
        depth: number;
      }>(sql`
        with recursive ancestor_path as (
          select
            ${nodes.id} as id,
            ${nodes.parentId} as parent_id,
            ${nodes.title} as title,
            0 as depth
          from ${nodes}
          where ${nodes.userId} = ${userId} and ${nodes.id} = ${input.nodeId}

          union all

          select
            parent.id,
            parent.parent_id,
            parent.title,
            ancestor_path.depth + 1
          from ancestor_path
          inner join ${nodes} parent
            on parent.user_id = ${userId}
            and parent.id = ancestor_path.parent_id
          where ancestor_path.depth < ${MAX_CHAT_BREADCRUMB_NODES}
        )
        select ancestor_path.id, ancestor_path.title, ancestor_path.depth
        from ancestor_path
        order by ancestor_path.depth asc
        limit ${MAX_CHAT_BREADCRUMB_NODES + 1}
      `),
      tx
        .select({ sequence: chatMessages.sequence })
        .from(chatMessages)
        .where(
          and(
            eq(chatMessages.userId, userId),
            eq(chatMessages.nodeId, input.nodeId),
            eq(chatMessages.clientMessageId, input.clientMessageId),
            eq(chatMessages.role, "assistant"),
            eq(chatMessages.status, "streaming"),
          ),
        )
        .limit(1),
    ]);
    const assistant = assistantRows[0];
    if (!assistant) {
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
        boundedNewestFirst.length > 0 &&
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

    return {
      version: 1,
      node: {
        id: target.id,
        title: target.title,
        breadcrumb: {
          items: boundedBreadcrumb,
          hasOmittedAncestors:
            breadcrumbResult.rows.length > boundedBreadcrumb.length,
        },
        publishedSynthesis: { state: "none" as const },
      },
      messages: boundedNewestFirst.reverse(),
    } satisfies ChatContextSnapshot;
  }, {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });

  return {
    snapshot,
    fingerprint: fingerprintSnapshot(snapshot),
    input: toContextInput(snapshot),
  };
}
