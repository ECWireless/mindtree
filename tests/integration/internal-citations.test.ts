import { randomUUID } from "node:crypto";

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { db } from "../../src/db/client";
import {
  archiveNodeForUser,
  deleteNodeForUser,
  moveNodeForUser,
  renameNodeForUser,
} from "../../src/lib/server/node-service";
import {
  approveSynthesisProposalForUser,
  getSynthesisWorkspaceForUser,
  insertPendingSynthesisProposal,
  SynthesisServiceError,
} from "../../src/lib/server/synthesis-service";
import { fingerprintSynthesisRelatedInput } from "../../src/lib/server/synthesis-input-fingerprint";

const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!connectionString) throw new Error("A PostgreSQL test database is required.");

const pool = new Pool({ connectionString });
const userIds = new Set<string>();

async function insertUser() {
  const userId = `citation-user-${randomUUID()}`;
  userIds.add(userId);
  await pool.query(
    `insert into "user" (id, name, email, email_verified)
     values ($1, 'Synthetic Citation User', $2, true)`,
    [userId, `${randomUUID()}@example.test`],
  );
  return userId;
}

async function insertNode(input: {
  userId: string;
  title: string;
  parentId?: string | null;
}) {
  const parentId = input.parentId ?? null;
  const position = await pool.query<{ value: number }>(
    `select count(*)::int as value from nodes
     where user_id = $1 and parent_id is not distinct from $2::uuid`,
    [input.userId, parentId],
  );
  const nodeId = randomUUID();
  await pool.query(
    `insert into nodes (id, user_id, parent_id, position, title)
     values ($1, $2, $3, $4, $5)`,
    [nodeId, input.userId, parentId, position.rows[0]?.value ?? 0, input.title],
  );
  return nodeId;
}

async function insertGeneratingMessage(userId: string, nodeId: string) {
  const sequence = await pool.query<{ value: string }>(
    `select (coalesce(max(sequence), -1) + 1)::text as value
     from chat_messages where user_id = $1 and node_id = $2`,
    [userId, nodeId],
  );
  const messageId = randomUUID();
  await pool.query(
    `insert into chat_messages
       (id, user_id, node_id, client_message_id, sequence, role, status, content,
        model, context_fingerprint, completed_at)
     values ($1, $2, $3, $4, $5, 'assistant', 'completed', 'Synthetic response',
       'gpt-5.6-sol', $6, now())`,
    [
      messageId,
      userId,
      nodeId,
      randomUUID(),
      sequence.rows[0]?.value ?? "0",
      "a".repeat(64),
    ],
  );
  return messageId;
}

async function insertApprovedSynthesis(userId: string, nodeId: string, content: string) {
  const messageId = await insertGeneratingMessage(userId, nodeId);
  const synthesisVersionId = randomUUID();
  await pool.query(
    `insert into synthesis_versions
       (id, user_id, node_id, status, content, model, reasoning_mode,
        reasoning_effort, input_fingerprint, generating_message_id, decided_at)
     values ($1, $2, $3, 'approved', $4, 'gpt-5.6-sol', 'pro', 'high', $5, $6, now())`,
    [synthesisVersionId, userId, nodeId, content, "b".repeat(64), messageId],
  );
  await pool.query(
    `update nodes set published_synthesis_version_id = $1 where user_id = $2 and id = $3`,
    [synthesisVersionId, userId, nodeId],
  );
  return synthesisVersionId;
}

async function insertProposal(input: {
  userId: string;
  nodeId: string;
  content: string;
  baseVersionId?: string | null;
  related?: {
    alias?: string;
    nodeId: string;
    parentId: string | null;
    title: string;
    archived?: boolean;
    synthesisVersionId: string;
  };
  citedText?: string;
}) {
  const generatingMessageId = await insertGeneratingMessage(input.userId, input.nodeId);
  const relatedInputs = input.related
    ? [{
        alias: input.related.alias ?? "E1",
        nodeId: input.related.nodeId,
        parentId: input.related.parentId,
        title: input.related.title,
        archived: input.related.archived ?? false,
        synthesisVersionId: input.related.synthesisVersionId,
        content: "Synthetic supplied evidence",
        sourceStateFingerprint: fingerprintSynthesisRelatedInput({
          nodeId: input.related.nodeId,
          synthesisVersionId: input.related.synthesisVersionId,
        }),
      }]
    : [];
  return db.transaction((tx) => insertPendingSynthesisProposal(tx, {
    userId: input.userId,
    nodeId: input.nodeId,
    generatingMessageId,
    baseVersionId: input.baseVersionId ?? null,
    draft: {
      content: input.content,
      citations: input.citedText
        ? [{ evidenceAlias: input.related?.alias ?? "E1", citedText: input.citedText }]
        : [],
    },
    model: "gpt-5.6-sol",
    reasoningMode: "pro",
    reasoningEffort: "high",
    inputFingerprint: "c".repeat(64),
    outlineInput: null,
    relatedInputs,
  }));
}

afterEach(async () => {
  if (userIds.size > 0) {
    await pool.query(`delete from "user" where id = any($1::text[])`, [[...userIds]]);
    userIds.clear();
  }
});

afterAll(async () => {
  await pool.end();
});

describe("validated internal synthesis citations", () => {
  it("accepts a supplied approved direct child without Branch Outline provenance", async () => {
    const userId = await insertUser();
    const targetNodeId = await insertNode({ userId, title: "Parent thought" });
    const childNodeId = await insertNode({
      userId,
      parentId: targetNodeId,
      title: "Perceptron",
    });
    const childVersionId = await insertApprovedSynthesis(
      userId,
      childNodeId,
      "Perceptrons are linear binary classifiers.",
    );
    const content = "Perceptrons are a foundational linear model.";

    const proposal = await insertProposal({
      userId,
      nodeId: targetNodeId,
      content,
      related: {
        nodeId: childNodeId,
        parentId: targetNodeId,
        title: "Perceptron",
        synthesisVersionId: childVersionId,
      },
      citedText: "Perceptrons are a foundational linear model",
    });

    expect(proposal.citations).toEqual([
      expect.objectContaining({
        snapshot: {
          nodeId: childNodeId,
          title: "Perceptron",
          synthesisVersionId: childVersionId,
        },
      }),
    ]);
    await expect(approveSynthesisProposalForUser(userId, {
      nodeId: targetNodeId,
      proposalId: proposal.id,
    })).resolves.toMatchObject({ id: proposal.id, status: "approved" });
  });

  it("persists exact evidence snapshots and presents renamed, moved, archived, and changed states", async () => {
    const userId = await insertUser();
    const firstParentId = await insertNode({ userId, title: "First branch" });
    const secondParentId = await insertNode({ userId, title: "Second branch" });
    const sourceNodeId = await insertNode({
      userId,
      parentId: firstParentId,
      title: "Source thought",
    });
    const targetNodeId = await insertNode({ userId, title: "Target thought" });
    const sourceVersionId = await insertApprovedSynthesis(
      userId,
      sourceNodeId,
      "Approved source evidence",
    );
    const content = "# Result\n\nEvidence supports this claim.";
    const proposal = await insertProposal({
      userId,
      nodeId: targetNodeId,
      content,
      related: {
        nodeId: sourceNodeId,
        parentId: firstParentId,
        title: "Source thought",
        synthesisVersionId: sourceVersionId,
      },
      citedText: "Evidence supports this claim",
    });

    expect(proposal.citations).toEqual([
      expect.objectContaining({
        ordinal: 1,
        startUtf16: content.indexOf("Evidence supports this claim"),
        endUtf16: content.indexOf("Evidence supports this claim") +
          "Evidence supports this claim".length,
        snapshot: {
          nodeId: sourceNodeId,
          title: "Source thought",
          synthesisVersionId: sourceVersionId,
        },
      }),
    ]);
    expect((await pool.query(
      `select relation, source_node_id, source_synthesis_version_id, position
       from synthesis_inputs where synthesis_version_id = $1 order by position`,
      [proposal.id],
    )).rows).toEqual([{
      relation: "related",
      source_node_id: sourceNodeId,
      source_synthesis_version_id: sourceVersionId,
      position: 0,
    }]);

    await expect(pool.query(
      `update citations
       set live_target_node_id = null,
           live_target_synthesis_version_id = null,
           target_deleted_at = now()
       where synthesis_version_id = $1`,
      [proposal.id],
    )).rejects.toMatchObject({
      code: "23514",
      constraint: "citations_immutable_check",
    });
    await expect(pool.query(
      `update citations set target_title_snapshot = 'Tampered title'
       where synthesis_version_id = $1`,
      [proposal.id],
    )).rejects.toMatchObject({
      code: "23514",
      constraint: "citations_immutable_check",
    });
    await expect(pool.query(
      `delete from citations where synthesis_version_id = $1`,
      [proposal.id],
    )).rejects.toMatchObject({
      code: "23514",
      constraint: "citations_immutable_check",
    });

    await approveSynthesisProposalForUser(userId, {
      nodeId: targetNodeId,
      proposalId: proposal.id,
    });
    await expect(pool.query(
      `insert into citations
         (user_id, owner_node_id, synthesis_version_id, kind, ordinal,
          start_utf16, end_utf16, live_target_node_id,
          live_target_synthesis_version_id, target_node_id_snapshot,
          target_title_snapshot, target_parent_id_snapshot,
          target_synthesis_version_id_snapshot)
       values ($1, $2, $3, 'internal', 2, 0, 1, $4, $5, $4, $6, $7, $5)`,
      [
        userId,
        targetNodeId,
        proposal.id,
        sourceNodeId,
        sourceVersionId,
        "Source thought",
        firstParentId,
      ],
    )).rejects.toMatchObject({
      code: "23514",
      constraint: "citations_parent_pending_check",
    });
    const replacement = await insertProposal({
      userId,
      nodeId: sourceNodeId,
      baseVersionId: sourceVersionId,
      content: "Replacement approved source evidence",
    });
    await approveSynthesisProposalForUser(userId, {
      nodeId: sourceNodeId,
      proposalId: replacement.id,
    });
    await renameNodeForUser(userId, { id: sourceNodeId, title: "Renamed source" });
    await moveNodeForUser(userId, {
      id: sourceNodeId,
      parentId: secondParentId,
      position: 0,
    });
    await archiveNodeForUser(userId, { id: sourceNodeId });

    const workspace = await getSynthesisWorkspaceForUser(userId, targetNodeId);
    expect(workspace.staleAt).not.toBeNull();
    expect(workspace.published?.citations).toEqual([
      expect.objectContaining({
        snapshot: expect.objectContaining({ title: "Source thought" }),
        target: expect.objectContaining({
          state: "available",
          nodeId: sourceNodeId,
          title: "Renamed source",
          renamed: true,
          moved: true,
          archived: true,
          changedRevision: true,
        }),
      }),
    ]);
  });

  it("clears live targets on deletion while preserving immutable snapshots", async () => {
    const userId = await insertUser();
    const sourceNodeId = await insertNode({ userId, title: "Disposable source" });
    const targetNodeId = await insertNode({ userId, title: "Durable target" });
    const sourceVersionId = await insertApprovedSynthesis(
      userId,
      sourceNodeId,
      "Disposable approved evidence",
    );
    const proposal = await insertProposal({
      userId,
      nodeId: targetNodeId,
      content: "Disposable evidence supports this result.",
      related: {
        nodeId: sourceNodeId,
        parentId: null,
        title: "Disposable source",
        synthesisVersionId: sourceVersionId,
      },
      citedText: "Disposable evidence supports this result",
    });
    await approveSynthesisProposalForUser(userId, {
      nodeId: targetNodeId,
      proposalId: proposal.id,
    });

    await deleteNodeForUser(userId, { id: sourceNodeId });

    const stored = await pool.query<{
      live_target_node_id: string | null;
      live_target_synthesis_version_id: string | null;
      target_node_id_snapshot: string;
      target_title_snapshot: string;
      target_synthesis_version_id_snapshot: string;
      target_deleted_at: Date | null;
    }>(
      `select live_target_node_id, live_target_synthesis_version_id,
              target_node_id_snapshot, target_title_snapshot,
              target_synthesis_version_id_snapshot, target_deleted_at
       from citations where synthesis_version_id = $1`,
      [proposal.id],
    );
    expect(stored.rows).toEqual([expect.objectContaining({
      live_target_node_id: null,
      live_target_synthesis_version_id: null,
      target_node_id_snapshot: sourceNodeId,
      target_title_snapshot: "Disposable source",
      target_synthesis_version_id_snapshot: sourceVersionId,
      target_deleted_at: expect.any(Date),
    })]);
    const workspace = await getSynthesisWorkspaceForUser(userId, targetNodeId);
    expect(workspace.staleAt).not.toBeNull();
    expect(workspace.published?.citations[0]).toMatchObject({
      snapshot: { title: "Disposable source" },
      target: { state: "unavailable" },
    });
  });

  it("rejects unknown, foreign, and mismatched evidence without persisting a proposal", async () => {
    const ownerId = await insertUser();
    const foreignOwnerId = await insertUser();
    const targetNodeId = await insertNode({ userId: ownerId, title: "Owner target" });
    const sourceNodeId = await insertNode({ userId: ownerId, title: "Owner source" });
    const sourceVersionId = await insertApprovedSynthesis(
      ownerId,
      sourceNodeId,
      "Owner evidence",
    );
    const foreignNodeId = await insertNode({
      userId: foreignOwnerId,
      title: "Foreign source",
    });
    const foreignVersionId = await insertApprovedSynthesis(
      foreignOwnerId,
      foreignNodeId,
      "Foreign evidence",
    );

    await expect(insertProposal({
      userId: ownerId,
      nodeId: targetNodeId,
      content: "Unknown evidence claim",
      related: {
        alias: "E2",
        nodeId: sourceNodeId,
        parentId: null,
        title: "Owner source",
        synthesisVersionId: sourceVersionId,
      },
      citedText: "Unknown evidence claim",
    })).rejects.toMatchObject({ reason: "invalid-proposal" });

    await expect(insertProposal({
      userId: ownerId,
      nodeId: targetNodeId,
      content: "Foreign evidence claim",
      related: {
        nodeId: foreignNodeId,
        parentId: null,
        title: "Foreign source",
        synthesisVersionId: foreignVersionId,
      },
      citedText: "Foreign evidence claim",
    })).rejects.toMatchObject({ reason: "stale-input" });

    const mismatchVersionId = randomUUID();
    await expect(insertProposal({
      userId: ownerId,
      nodeId: targetNodeId,
      content: "Mismatched evidence claim",
      related: {
        nodeId: sourceNodeId,
        parentId: null,
        title: "Owner source",
        synthesisVersionId: mismatchVersionId,
      },
      citedText: "Mismatched evidence claim",
    })).rejects.toMatchObject({ reason: "stale-input" });
  });

  it("rejects approval after an exact related source revision changes", async () => {
    const userId = await insertUser();
    const sourceNodeId = await insertNode({ userId, title: "Changing source" });
    const targetNodeId = await insertNode({ userId, title: "Waiting target" });
    const sourceVersionId = await insertApprovedSynthesis(
      userId,
      sourceNodeId,
      "First source revision",
    );
    const targetProposal = await insertProposal({
      userId,
      nodeId: targetNodeId,
      content: "First source supports target.",
      related: {
        nodeId: sourceNodeId,
        parentId: null,
        title: "Changing source",
        synthesisVersionId: sourceVersionId,
      },
      citedText: "First source supports target",
    });
    const sourceReplacement = await insertProposal({
      userId,
      nodeId: sourceNodeId,
      baseVersionId: sourceVersionId,
      content: "Second source revision",
    });
    await approveSynthesisProposalForUser(userId, {
      nodeId: sourceNodeId,
      proposalId: sourceReplacement.id,
    });

    await expect(approveSynthesisProposalForUser(userId, {
      nodeId: targetNodeId,
      proposalId: targetProposal.id,
    })).rejects.toEqual(new SynthesisServiceError("stale-input"));
    expect((await getSynthesisWorkspaceForUser(userId, targetNodeId)).published).toBeNull();
  });
});
