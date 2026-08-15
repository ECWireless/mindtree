import { randomUUID } from "node:crypto";

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { Pool } from "pg";

import type { BranchOutlineInputSnapshot } from "../../src/lib/branch-outlines/contracts";
import {
  fingerprintBranchOutlineGeneration,
  fingerprintBranchOutlineSourceState,
} from "../../src/lib/server/branch-outline-fingerprint";
import { prepareBranchOutlineContextForUser } from "../../src/lib/server/branch-outline-context";
import {
  claimBranchOutlineGenerationForUser,
  completeBranchOutlineGenerationForUser,
} from "../../src/lib/server/branch-outline-service";
import {
  archiveNodeForUser,
  deleteNodeForUser,
  moveNodeForUser,
  renameNodeForUser,
} from "../../src/lib/server/node-service";
import {
  approveSynthesisProposalForUser,
  SynthesisServiceError,
} from "../../src/lib/server/synthesis-service";

const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL or DATABASE_URL_UNPOOLED is required.");
}

const pool = new Pool({ connectionString });
const userIds = new Set<string>();

type NodeState = {
  id: string;
  title: string;
  parent_id: string | null;
  archived_at: Date | null;
  published_synthesis_version_id: string | null;
  current_branch_outline_version_id: string | null;
  synthesis_stale_at: Date | null;
  branch_outline_stale_at: Date | null;
  branch_outline_stale_reason: string | null;
};

async function insertUser() {
  const userId = `outline-race-user-${randomUUID()}`;
  userIds.add(userId);
  await pool.query(
    `insert into "user" (id, name, email, email_verified)
     values ($1, 'Synthetic Outline Race User', $2, true)`,
    [userId, `${randomUUID()}@example.test`],
  );
  return userId;
}

async function insertNode(
  userId: string,
  title: string,
  parentId: string | null = null,
) {
  const position = await pool.query<{ value: number }>(
    `select coalesce(max(position), -1)::int + 1 as value
     from nodes where user_id = $1 and parent_id is not distinct from $2`,
    [userId, parentId],
  );
  const nodeId = randomUUID();
  await pool.query(
    `insert into nodes (id, user_id, parent_id, position, title)
     values ($1, $2, $3, $4, $5)`,
    [nodeId, userId, parentId, position.rows[0]?.value ?? 0, title],
  );
  return nodeId;
}

async function insertSynthesis(input: {
  userId: string;
  nodeId: string;
  content: string;
  status: "approved" | "pending";
  baseVersionId?: string | null;
}) {
  const sequence = await pool.query<{ value: string }>(
    `select (coalesce(max(sequence), -1) + 1)::text as value
     from chat_messages where user_id = $1 and node_id = $2`,
    [input.userId, input.nodeId],
  );
  const messageId = randomUUID();
  await pool.query(
    `insert into chat_messages
       (id, user_id, node_id, client_message_id, sequence, role, status, content,
        model, context_fingerprint, completed_at)
     values ($1, $2, $3, $4, $5, 'assistant', 'completed', 'Synthetic race response',
       'gpt-5.6-sol', $6, now())`,
    [
      messageId,
      input.userId,
      input.nodeId,
      randomUUID(),
      sequence.rows[0]?.value ?? "0",
      "a".repeat(64),
    ],
  );
  const synthesisId = randomUUID();
  await pool.query(
    `insert into synthesis_versions
       (id, user_id, node_id, base_version_id, status, content, model,
        reasoning_mode, reasoning_effort, input_fingerprint,
        generating_message_id, decided_at)
     values ($1, $2, $3, $4, $5::varchar, $6, 'gpt-5.6-sol', 'pro', 'high',
       $7, $8, case when $5::text = 'approved' then now() else null end)`,
    [
      synthesisId,
      input.userId,
      input.nodeId,
      input.baseVersionId ?? null,
      input.status,
      input.content,
      "b".repeat(64),
      messageId,
    ],
  );
  if (input.status === "approved") {
    await pool.query(
      `update nodes set published_synthesis_version_id = $1 where id = $2`,
      [synthesisId, input.nodeId],
    );
  }
  return synthesisId;
}

function childInput(input: {
  sourceNodeId: string;
  title: string;
  sourceSynthesisVersionId: string | null;
}) {
  const state = {
    sourceNodeId: input.sourceNodeId,
    sourceSynthesisVersionId: input.sourceSynthesisVersionId,
    sourceBranchOutlineVersionId: null,
    summaryState: input.sourceSynthesisVersionId ? "published" as const : "none" as const,
    outlineState: "none" as const,
    position: 0,
    title: input.title,
    archivedAt: null,
  };
  return {
    sourceNodeId: state.sourceNodeId,
    sourceSynthesisVersionId: state.sourceSynthesisVersionId,
    sourceBranchOutlineVersionId: state.sourceBranchOutlineVersionId,
    summaryState: state.summaryState,
    outlineState: state.outlineState,
    sourceStateFingerprint: fingerprintBranchOutlineSourceState(state),
    position: state.position,
  } satisfies BranchOutlineInputSnapshot;
}

async function claimInput(userId: string, input: {
  nodeId: string;
  nodeTitle: string;
  baseSynthesisVersionId: string | null;
  inputs?: BranchOutlineInputSnapshot[];
}) {
  const prepared = await prepareBranchOutlineContextForUser(userId, input.nodeId);
  const inputs = input.inputs ?? [];
  return {
    nodeId: input.nodeId,
    clientRequestId: randomUUID(),
    baseSynthesisVersionId: input.baseSynthesisVersionId,
    inputs,
    inputFingerprint: prepared.claim.inputFingerprint,
    sourceStateFingerprint: fingerprintBranchOutlineGeneration({
      nodeId: input.nodeId,
      nodeTitle: input.nodeTitle,
      nodeArchivedAt: null,
      baseSynthesisVersionId: input.baseSynthesisVersionId,
      inputs,
    }),
  };
}

async function installOutline(input: {
  userId: string;
  nodeId: string;
  nodeTitle: string;
  baseSynthesisVersionId: string | null;
  inputs?: BranchOutlineInputSnapshot[];
  content: string;
}) {
  const claim = await claimBranchOutlineGenerationForUser(
    input.userId,
    await claimInput(input.userId, input),
  );
  const completed = await completeBranchOutlineGenerationForUser(input.userId, {
    nodeId: input.nodeId,
    generationId: claim.generation.id,
    draft: { content: input.content },
  });
  expect(completed).toMatchObject({
    installed: true,
    generation: { status: "completed" },
  });
  return claim.generation.id;
}

async function getNodeState(nodeId: string) {
  const result = await pool.query<NodeState>(
    `select id, title, parent_id, archived_at,
            published_synthesis_version_id, current_branch_outline_version_id,
            synthesis_stale_at, branch_outline_stale_at,
            branch_outline_stale_reason
     from nodes where id = $1`,
    [nodeId],
  );
  return result.rows[0] ?? null;
}

function expectCompletionBeforeStaleness(
  completedAt: string | null,
  staleAt: Date | null | undefined,
) {
  if (completedAt === null || !staleAt) {
    throw new Error("Expected completed outline and later stale timestamp.");
  }
  expect(Date.parse(completedAt)).toBeLessThanOrEqual(staleAt.getTime());
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

describe("Branch Outline cross-service races", () => {
  it("serializes target Summary approval against outline installation", async () => {
    const userId = await insertUser();
    const nodeId = await insertNode(userId, "Target approval race");
    const baseSummaryId = await insertSynthesis({
      userId,
      nodeId,
      content: "Base target Summary",
      status: "approved",
    });
    const proposalId = await insertSynthesis({
      userId,
      nodeId,
      baseVersionId: baseSummaryId,
      content: "Pending target Summary",
      status: "pending",
    });
    const claim = await claimBranchOutlineGenerationForUser(userId, await claimInput(userId, {
      nodeId,
      nodeTitle: "Target approval race",
      baseSynthesisVersionId: baseSummaryId,
    }));

    const [approvalSettlement, outlineSettlement] = await Promise.allSettled([
      approveSynthesisProposalForUser(userId, { nodeId, proposalId }),
      completeBranchOutlineGenerationForUser(userId, {
        nodeId,
        generationId: claim.generation.id,
        draft: { content: "Concurrent target outline" },
      }),
    ]);

    expect(outlineSettlement.status).toBe("fulfilled");
    if (outlineSettlement.status !== "fulfilled") return;
    const node = await getNodeState(nodeId);
    expect(node).not.toBeNull();
    if (approvalSettlement.status === "fulfilled") {
      expect(approvalSettlement.value.status).toBe("approved");
      expect(outlineSettlement.value).toMatchObject({
        installed: false,
        generation: { status: "failed", failureCode: "inputs-changed" },
      });
      expect(node).toMatchObject({
        published_synthesis_version_id: proposalId,
        current_branch_outline_version_id: null,
        synthesis_stale_at: null,
        branch_outline_stale_at: null,
      });
    } else {
      expect(approvalSettlement.reason).toEqual(new SynthesisServiceError("stale-input"));
      expect(outlineSettlement.value).toMatchObject({
        installed: true,
        generation: { id: claim.generation.id, status: "completed" },
      });
      expect(node).toMatchObject({
        published_synthesis_version_id: baseSummaryId,
        current_branch_outline_version_id: claim.generation.id,
        synthesis_stale_at: null,
        branch_outline_stale_at: null,
      });
    }
  });

  it("serializes child Summary approval against parent outline installation", async () => {
    const userId = await insertUser();
    const parentId = await insertNode(userId, "Parent approval race");
    const childId = await insertNode(userId, "Child approval race", parentId);
    const parentSummaryId = await insertSynthesis({
      userId,
      nodeId: parentId,
      content: "Parent Summary",
      status: "approved",
    });
    const childSummaryId = await insertSynthesis({
      userId,
      nodeId: childId,
      content: "Base child Summary",
      status: "approved",
    });
    const childProposalId = await insertSynthesis({
      userId,
      nodeId: childId,
      baseVersionId: childSummaryId,
      content: "Replacement child Summary",
      status: "pending",
    });
    const input = childInput({
      sourceNodeId: childId,
      title: "Child approval race",
      sourceSynthesisVersionId: childSummaryId,
    });
    const claim = await claimBranchOutlineGenerationForUser(userId, await claimInput(userId, {
      nodeId: parentId,
      nodeTitle: "Parent approval race",
      baseSynthesisVersionId: parentSummaryId,
      inputs: [input],
    }));

    const [approvedChild, outlineResult] = await Promise.all([
      approveSynthesisProposalForUser(userId, {
        nodeId: childId,
        proposalId: childProposalId,
      }),
      completeBranchOutlineGenerationForUser(userId, {
        nodeId: parentId,
        generationId: claim.generation.id,
        draft: { content: "Concurrent parent outline" },
      }),
    ]);

    expect(approvedChild.status).toBe("approved");
    const parent = await getNodeState(parentId);
    const child = await getNodeState(childId);
    expect(parent).toMatchObject({
      published_synthesis_version_id: parentSummaryId,
      synthesis_stale_at: expect.any(Date),
    });
    expect(child).toMatchObject({
      published_synthesis_version_id: childProposalId,
      synthesis_stale_at: null,
    });
    if (outlineResult.installed) {
      expect(outlineResult.generation).toMatchObject({
        id: claim.generation.id,
        status: "completed",
      });
      expect(parent).toMatchObject({
        current_branch_outline_version_id: claim.generation.id,
        branch_outline_stale_at: expect.any(Date),
        branch_outline_stale_reason: "branch-content-changed",
      });
      expectCompletionBeforeStaleness(
        outlineResult.generation.completedAt,
        parent?.branch_outline_stale_at,
      );
    } else {
      expect(outlineResult.generation).toMatchObject({
        status: "failed",
        failureCode: "inputs-changed",
      });
      expect(parent).toMatchObject({
        current_branch_outline_version_id: null,
        branch_outline_stale_at: null,
        branch_outline_stale_reason: null,
      });
    }
  });

  const mutationCases = [
    { kind: "rename", staleReason: "node-renamed" },
    { kind: "move", staleReason: "branch-structure-changed" },
    { kind: "archive", staleReason: "branch-availability-changed" },
    { kind: "delete", staleReason: "branch-structure-changed" },
  ] as const;

  it.each(mutationCases)(
    "serializes child $kind against parent outline replacement",
    async ({ kind, staleReason }) => {
      const userId = await insertUser();
      const parentId = await insertNode(userId, `${kind} source parent`);
      const childId = await insertNode(userId, `${kind} child`, parentId);
      const parentSummaryId = await insertSynthesis({
        userId,
        nodeId: parentId,
        content: `${kind} parent Summary`,
        status: "approved",
      });
      const childSummaryId = await insertSynthesis({
        userId,
        nodeId: childId,
        content: `${kind} child Summary`,
        status: "approved",
      });
      const input = childInput({
        sourceNodeId: childId,
        title: `${kind} child`,
        sourceSynthesisVersionId: childSummaryId,
      });
      const baselineOutlineId = await installOutline({
        userId,
        nodeId: parentId,
        nodeTitle: `${kind} source parent`,
        baseSynthesisVersionId: parentSummaryId,
        inputs: [input],
        content: `${kind} baseline outline`,
      });
      const replacementClaim = await claimBranchOutlineGenerationForUser(
        userId,
        await claimInput(userId, {
          nodeId: parentId,
          nodeTitle: `${kind} source parent`,
          baseSynthesisVersionId: parentSummaryId,
          inputs: [input],
        }),
      );

      let destinationId: string | null = null;
      if (kind === "move") {
        destinationId = await insertNode(userId, "move destination parent");
        const destinationSummaryId = await insertSynthesis({
          userId,
          nodeId: destinationId,
          content: "Move destination Summary",
          status: "approved",
        });
        await installOutline({
          userId,
          nodeId: destinationId,
          nodeTitle: "move destination parent",
          baseSynthesisVersionId: destinationSummaryId,
          content: "Move destination outline",
        });
      }

      const runMutation = () => {
        switch (kind) {
          case "rename":
            return renameNodeForUser(userId, {
              id: childId,
              title: "renamed child",
            });
          case "move":
            return moveNodeForUser(userId, {
              id: childId,
              parentId: destinationId,
            });
          case "archive":
            return archiveNodeForUser(userId, { id: childId });
          case "delete":
            return deleteNodeForUser(userId, { id: childId });
        }
      };

      const [outlineResult] = await Promise.all([
        completeBranchOutlineGenerationForUser(userId, {
          nodeId: parentId,
          generationId: replacementClaim.generation.id,
          draft: { content: `${kind} concurrent replacement outline` },
        }),
        runMutation(),
      ]);

      const parent = await getNodeState(parentId);
      expect(parent).toMatchObject({
        published_synthesis_version_id: parentSummaryId,
        synthesis_stale_at: expect.any(Date),
        branch_outline_stale_at: expect.any(Date),
        branch_outline_stale_reason: staleReason,
      });
      if (outlineResult.installed) {
        expect(outlineResult.generation).toMatchObject({
          id: replacementClaim.generation.id,
          status: "completed",
        });
        expect(parent?.current_branch_outline_version_id)
          .toBe(replacementClaim.generation.id);
        expectCompletionBeforeStaleness(
          outlineResult.generation.completedAt,
          parent?.branch_outline_stale_at,
        );
      } else {
        expect(outlineResult.generation).toMatchObject({
          status: "failed",
          failureCode: "inputs-changed",
        });
        expect(parent?.current_branch_outline_version_id).toBe(baselineOutlineId);
      }

      const child = await getNodeState(childId);
      if (kind === "rename") {
        expect(child?.title).toBe("renamed child");
      } else if (kind === "move") {
        expect(child?.parent_id).toBe(destinationId);
        expect(await getNodeState(destinationId!)).toMatchObject({
          synthesis_stale_at: expect.any(Date),
          branch_outline_stale_at: expect.any(Date),
          branch_outline_stale_reason: "branch-structure-changed",
        });
      } else if (kind === "archive") {
        expect(child?.archived_at).toBeInstanceOf(Date);
      } else {
        expect(child).toBeNull();
      }
    },
  );
});
