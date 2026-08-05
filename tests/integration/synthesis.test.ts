import { createHash, randomUUID } from "node:crypto";

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { Pool } from "pg";

import {
  approveSynthesisProposalForUser,
  getSynthesisWorkspaceForUser,
  rejectSynthesisProposalForUser,
  SynthesisServiceError,
} from "../../src/lib/server/synthesis-service";
import { moveNodeForUser } from "../../src/lib/server/node-service";

const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL or DATABASE_URL_UNPOOLED is required.");
}

const pool = new Pool({ connectionString });
const userIds = new Set<string>();

async function insertUser() {
  const userId = `synthesis-user-${randomUUID()}`;
  userIds.add(userId);
  await pool.query(
    `insert into "user" (id, name, email, email_verified)
     values ($1, 'Synthetic Synthesis User', $2, true)`,
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

async function insertProposal(input: {
  userId: string;
  nodeId: string;
  baseVersionId?: string | null;
  content: string;
  status?: "pending" | "approved" | "rejected" | "superseded";
  decidedAt?: Date;
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
     values ($1, $2, $3, $4, $5, 'assistant', 'completed', 'Synthetic response',
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
  const proposalId = randomUUID();
  const status = input.status ?? "pending";
  await pool.query(
    `insert into synthesis_versions
       (id, user_id, node_id, base_version_id, status, content, model,
        reasoning_mode, reasoning_effort, input_fingerprint,
        generating_message_id, decided_at)
     values ($1, $2, $3, $4, $5::varchar, $6, 'gpt-5.6-sol', 'pro', 'high', $7, $8,
       case when $5::text = 'pending' then null else coalesce($9::timestamptz, now()) end)`,
    [
      proposalId,
      input.userId,
      input.nodeId,
      input.baseVersionId ?? null,
      status,
      input.content,
      "b".repeat(64),
      messageId,
      input.decidedAt ?? null,
    ],
  );
  return proposalId;
}

function outlineInputFingerprint(nodeId: string, outlineId: string) {
  return createHash("sha256")
    .update(JSON.stringify({
      version: 1,
      nodeId,
      branchOutlineVersionId: outlineId,
    }), "utf8")
    .digest("hex");
}

async function installBranchOutline(userId: string, nodeId: string, content: string) {
  const outlineId = randomUUID();
  await pool.query(
    `insert into branch_outline_versions
       (id, user_id, node_id, client_request_id, status, content, model,
        reasoning_mode, reasoning_effort, input_fingerprint, completed_at)
     values ($1, $2, $3, $4, 'completed', $5, 'gpt-5.6-sol',
       'pro', 'high', $6, now())`,
    [outlineId, userId, nodeId, randomUUID(), content, "c".repeat(64)],
  );
  await pool.query(
    `update nodes
     set current_branch_outline_version_id = $1,
         branch_outline_stale_at = null,
         branch_outline_stale_reason = null
     where user_id = $2 and id = $3`,
    [outlineId, userId, nodeId],
  );
  return outlineId;
}

async function recordProposalOutline(
  userId: string,
  nodeId: string,
  proposalId: string,
  outlineId: string,
) {
  await pool.query(
    `insert into synthesis_inputs
       (synthesis_version_id, user_id, node_id, relation, source_node_id,
        source_synthesis_version_id, source_branch_outline_version_id,
        source_state_fingerprint, position)
     values ($1, $2, $3, 'outline', $3, null, $4, $5, 0)`,
    [proposalId, userId, nodeId, outlineId, outlineInputFingerprint(nodeId, outlineId)],
  );
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

describe("transactional synthesis decisions", () => {
  it("approves the exact current base, publishes it, clears the target, and stales ancestors", async () => {
    const userId = await insertUser();
    const rootId = await insertNode(userId, "Root");
    const childId = await insertNode(userId, "Child", rootId);
    const rootOutlineId = await installBranchOutline(userId, rootId, "Root outline");
    const childOutlineId = await installBranchOutline(userId, childId, "Child outline");
    const rootVersionId = await insertProposal({
      userId,
      nodeId: rootId,
      content: "Published root",
      status: "approved",
    });
    await pool.query(
      `update nodes set published_synthesis_version_id = $1 where id = $2`,
      [rootVersionId, rootId],
    );
    const proposalId = await insertProposal({
      userId,
      nodeId: childId,
      content: "Pending child synthesis",
    });
    await recordProposalOutline(userId, childId, proposalId, childOutlineId);
    await pool.query(
      `update nodes set synthesis_stale_at = now() - interval '1 day' where id = $1`,
      [childId],
    );

    const approved = await approveSynthesisProposalForUser(userId, {
      nodeId: childId,
      proposalId,
    });
    expect(approved).toMatchObject({ id: proposalId, status: "approved" });
    expect(approved.decidedAt).not.toBeNull();

    const nodes = await pool.query<{
      id: string;
      published_synthesis_version_id: string | null;
      synthesis_stale_at: Date | null;
      branch_outline_stale_at: Date | null;
      branch_outline_stale_reason: string | null;
    }>(
      `select id, published_synthesis_version_id, synthesis_stale_at,
              branch_outline_stale_at, branch_outline_stale_reason
       from nodes where id = any($1::uuid[]) order by id`,
      [[rootId, childId]],
    );
    const root = nodes.rows.find(({ id }) => id === rootId);
    const child = nodes.rows.find(({ id }) => id === childId);
    expect(root?.synthesis_stale_at).toBeInstanceOf(Date);
    expect(root).toMatchObject({
      branch_outline_stale_at: expect.any(Date),
      branch_outline_stale_reason: "branch-content-changed",
    });
    expect(child).toMatchObject({
      published_synthesis_version_id: proposalId,
      synthesis_stale_at: null,
      branch_outline_stale_at: expect.any(Date),
      branch_outline_stale_reason: "summary-changed",
    });
    expect(rootOutlineId).not.toBe(childOutlineId);
    expect(await getSynthesisWorkspaceForUser(userId, childId)).toMatchObject({
      published: { id: proposalId, status: "approved" },
      pending: null,
    });
  });

  it("rejects approval when exact Branch Outline provenance is stale, replaced, or newly introduced", async () => {
    const userId = await insertUser();
    const staleNodeId = await insertNode(userId, "Stale outline node");
    const outlineId = await installBranchOutline(userId, staleNodeId, "Exact outline");
    const proposalId = await insertProposal({
      userId,
      nodeId: staleNodeId,
      content: "Proposal from exact outline",
    });
    await recordProposalOutline(userId, staleNodeId, proposalId, outlineId);
    await pool.query(
      `update nodes
       set branch_outline_stale_at = now(), branch_outline_stale_reason = 'node-renamed'
       where id = $1`,
      [staleNodeId],
    );
    await expect(approveSynthesisProposalForUser(userId, {
      nodeId: staleNodeId,
      proposalId,
    })).rejects.toEqual(new SynthesisServiceError("stale-input"));

    await installBranchOutline(userId, staleNodeId, "Replacement outline");
    await expect(approveSynthesisProposalForUser(userId, {
      nodeId: staleNodeId,
      proposalId,
    })).rejects.toEqual(new SynthesisServiceError("stale-input"));

    const absentNodeId = await insertNode(userId, "Initially absent outline");
    const absentProposalId = await insertProposal({
      userId,
      nodeId: absentNodeId,
      content: "Proposal without outline",
    });
    await installBranchOutline(userId, absentNodeId, "Newly introduced outline");
    await expect(approveSynthesisProposalForUser(userId, {
      nodeId: absentNodeId,
      proposalId: absentProposalId,
    })).rejects.toEqual(new SynthesisServiceError("stale-input"));
  });

  it("rejects a proposal without changing publication or staleness", async () => {
    const userId = await insertUser();
    const nodeId = await insertNode(userId, "Reject node");
    const publishedId = await insertProposal({
      userId,
      nodeId,
      content: "Published content",
      status: "approved",
    });
    await pool.query(
      `update nodes set published_synthesis_version_id = $1,
         synthesis_stale_at = now() - interval '1 day' where id = $2`,
      [publishedId, nodeId],
    );
    const proposalId = await insertProposal({
      userId,
      nodeId,
      baseVersionId: publishedId,
      content: "Rejected content",
    });
    const before = await pool.query<{ synthesis_stale_at: Date }>(
      `select synthesis_stale_at from nodes where id = $1`,
      [nodeId],
    );

    const rejected = await rejectSynthesisProposalForUser(userId, { nodeId, proposalId });
    expect(rejected).toMatchObject({ id: proposalId, status: "rejected" });
    const after = await pool.query<{
      published_synthesis_version_id: string;
      synthesis_stale_at: Date;
    }>(
      `select published_synthesis_version_id, synthesis_stale_at
       from nodes where id = $1`,
      [nodeId],
    );
    expect(after.rows[0]?.published_synthesis_version_id).toBe(publishedId);
    expect(after.rows[0]?.synthesis_stale_at.getTime())
      .toBe(before.rows[0]?.synthesis_stale_at.getTime());
  });

  it("fails safely when the published base changed", async () => {
    const userId = await insertUser();
    const nodeId = await insertNode(userId, "Stale base node");
    const oldBaseId = await insertProposal({
      userId,
      nodeId,
      content: "Old base",
      status: "approved",
    });
    const newBaseId = await insertProposal({
      userId,
      nodeId,
      content: "New base",
      status: "approved",
    });
    await pool.query(
      `update nodes set published_synthesis_version_id = $1 where id = $2`,
      [newBaseId, nodeId],
    );
    const proposalId = await insertProposal({
      userId,
      nodeId,
      baseVersionId: oldBaseId,
      content: "Stale pending proposal",
    });

    await expect(approveSynthesisProposalForUser(userId, { nodeId, proposalId }))
      .rejects.toEqual(new SynthesisServiceError("stale-base"));
    expect(await getSynthesisWorkspaceForUser(userId, nodeId)).toMatchObject({
      published: { id: newBaseId },
      pending: { id: proposalId, status: "pending" },
    });
  });

  it("serializes concurrent decisions so only one terminal transition wins", async () => {
    const userId = await insertUser();
    const nodeId = await insertNode(userId, "Decision race node");
    const proposalId = await insertProposal({
      userId,
      nodeId,
      content: "Race proposal",
    });

    const results = await Promise.allSettled([
      approveSynthesisProposalForUser(userId, { nodeId, proposalId }),
      rejectSynthesisProposalForUser(userId, { nodeId, proposalId }),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const decided = await pool.query<{ status: string }>(
      `select status from synthesis_versions where id = $1`,
      [proposalId],
    );
    expect(["approved", "rejected"]).toContain(decided.rows[0]?.status);
    const pointer = await pool.query<{ published_synthesis_version_id: string | null }>(
      `select published_synthesis_version_id from nodes where id = $1`,
      [nodeId],
    );
    expect(pointer.rows[0]?.published_synthesis_version_id)
      .toBe(decided.rows[0]?.status === "approved" ? proposalId : null);
  });

  it("replays the same approved or rejected decision without a second transition", async () => {
    const userId = await insertUser();
    const approvedNodeId = await insertNode(userId, "Approval replay node");
    const approvedProposalId = await insertProposal({
      userId,
      nodeId: approvedNodeId,
      content: "Approval replay proposal",
    });
    const approvals = await Promise.all([
      approveSynthesisProposalForUser(userId, {
        nodeId: approvedNodeId,
        proposalId: approvedProposalId,
      }),
      approveSynthesisProposalForUser(userId, {
        nodeId: approvedNodeId,
        proposalId: approvedProposalId,
      }),
    ]);
    expect(approvals).toEqual([
      expect.objectContaining({ id: approvedProposalId, status: "approved" }),
      expect.objectContaining({ id: approvedProposalId, status: "approved" }),
    ]);

    const rejectedNodeId = await insertNode(userId, "Rejection replay node");
    const rejectedProposalId = await insertProposal({
      userId,
      nodeId: rejectedNodeId,
      content: "Rejection replay proposal",
    });
    await rejectSynthesisProposalForUser(userId, {
      nodeId: rejectedNodeId,
      proposalId: rejectedProposalId,
    });
    const rejectedReplay = await rejectSynthesisProposalForUser(userId, {
      nodeId: rejectedNodeId,
      proposalId: rejectedProposalId,
    });
    expect(rejectedReplay).toMatchObject({
      id: rejectedProposalId,
      status: "rejected",
    });
  });

  it("returns only the five most recent decided-version summaries", async () => {
    const userId = await insertUser();
    const nodeId = await insertNode(userId, "Decision history node");
    const proposalIds: string[] = [];
    const decisionAgesInMinutes = [0, 1, 2, 3, 4, 6, 5];
    for (let index = 0; index < 7; index += 1) {
      const proposalId = await insertProposal({
        userId,
        nodeId,
        content: `Rejected proposal ${index}`,
        status: "rejected",
        decidedAt: new Date(Date.now() - decisionAgesInMinutes[index]! * 60_000),
      });
      proposalIds.push(proposalId);
    }

    const workspace = await getSynthesisWorkspaceForUser(userId, nodeId);
    expect(workspace.history).toHaveLength(5);
    expect(workspace.history.map(({ id }) => id)).toEqual(proposalIds.slice(0, 5));
    expect(workspace.history.every(({ status, decidedAt }) =>
      status === "rejected" && Number.isFinite(Date.parse(decidedAt))))
      .toBe(true);

    const olderTurns = await pool.query<{ generating_message_id: string }>(
      `select generating_message_id from synthesis_versions where id = any($1::uuid[])`,
      [proposalIds.slice(5)],
    );
    const workspaceWithLoadedTurn = await getSynthesisWorkspaceForUser(userId, nodeId, {
      generatingMessageIds: olderTurns.rows.map(({ generating_message_id }) => generating_message_id),
    });
    expect(workspaceWithLoadedTurn.history).toHaveLength(7);
    expect(workspaceWithLoadedTurn.history.map(({ id }) => id)).toEqual([
      ...proposalIds.slice(0, 5),
      proposalIds[6],
      proposalIds[5],
    ]);
    expect(workspaceWithLoadedTurn.history).toContainEqual(expect.objectContaining({
      id: proposalIds[6],
      content: "Rejected proposal 6",
    }));
  });

  it("shares the tree lock order with node movement while staling both affected branches", async () => {
    const userId = await insertUser();
    const firstRootId = await insertNode(userId, "First root");
    const secondRootId = await insertNode(userId, "Second root");
    const childId = await insertNode(userId, "Moving child", firstRootId);
    const firstRootSummaryId = await insertProposal({
      userId,
      nodeId: firstRootId,
      content: "First root summary",
      status: "approved",
    });
    const secondRootSummaryId = await insertProposal({
      userId,
      nodeId: secondRootId,
      content: "Second root summary",
      status: "approved",
    });
    await pool.query(
      `update nodes
       set published_synthesis_version_id = case id when $1 then $2::uuid else $3::uuid end
       where id = any($4::uuid[])`,
      [firstRootId, firstRootSummaryId, secondRootSummaryId, [firstRootId, secondRootId]],
    );
    const proposalId = await insertProposal({
      userId,
      nodeId: childId,
      content: "Moving child proposal",
    });

    const [approval, movement] = await Promise.all([
      approveSynthesisProposalForUser(userId, { nodeId: childId, proposalId }),
      moveNodeForUser(userId, { id: childId, parentId: secondRootId }),
    ]);
    expect(approval.status).toBe("approved");
    expect(movement.parentId).toBe(secondRootId);

    const rows = await pool.query<{
      id: string;
      parent_id: string | null;
      synthesis_stale_at: Date | null;
    }>(
      `select id, parent_id, synthesis_stale_at
       from nodes where id = any($1::uuid[])`,
      [[firstRootId, secondRootId, childId]],
    );
    expect(rows.rows.find(({ id }) => id === childId)?.parent_id).toBe(secondRootId);
    const staleRoots = rows.rows.filter(
      ({ id, synthesis_stale_at: staleAt }) =>
        id !== childId && staleAt !== null,
    );
    expect(staleRoots.map(({ id }) => id).sort()).toEqual(
      [firstRootId, secondRootId].sort(),
    );
  });

  it("does not disclose foreign proposals through owner-scoped decisions", async () => {
    const ownerId = await insertUser();
    const otherOwnerId = await insertUser();
    const nodeId = await insertNode(ownerId, "Owned node");
    const foreignNodeId = await insertNode(otherOwnerId, "Foreign node");
    const foreignProposalId = await insertProposal({
      userId: otherOwnerId,
      nodeId: foreignNodeId,
      content: "Foreign proposal",
    });

    await expect(approveSynthesisProposalForUser(ownerId, {
      nodeId,
      proposalId: foreignProposalId,
    })).rejects.toEqual(new SynthesisServiceError("proposal-not-found"));
    await expect(rejectSynthesisProposalForUser(ownerId, {
      nodeId,
      proposalId: randomUUID(),
    })).rejects.toEqual(new SynthesisServiceError("proposal-not-found"));
  });
});
