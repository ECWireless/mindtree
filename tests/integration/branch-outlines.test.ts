import { randomUUID } from "node:crypto";

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { Pool } from "pg";

import type { BranchOutlineInputSnapshot } from "../../src/lib/branch-outlines/contracts";
import {
  fingerprintBranchOutlineGeneration,
  fingerprintBranchOutlineSourceState,
} from "../../src/lib/server/branch-outline-fingerprint";
import {
  BranchOutlineServiceError,
  BRANCH_OUTLINE_GENERATION_LEASE_MS,
  claimBranchOutlineGenerationForUser,
  completeBranchOutlineGenerationForUser,
  failBranchOutlineGenerationForUser,
  getBranchOutlineWorkspaceForUser,
  recordBranchOutlineProviderResponseForUser,
} from "../../src/lib/server/branch-outline-service";

const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL or DATABASE_URL_UNPOOLED is required.");
}

const pool = new Pool({ connectionString });
const userIds = new Set<string>();

async function insertUser() {
  const userId = `outline-user-${randomUUID()}`;
  userIds.add(userId);
  await pool.query(
    `insert into "user" (id, name, email, email_verified)
     values ($1, 'Synthetic Outline User', $2, true)`,
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

async function insertApprovedSummary(userId: string, nodeId: string, content: string) {
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
  const summaryId = randomUUID();
  await pool.query(
    `insert into synthesis_versions
       (id, user_id, node_id, status, content, model, reasoning_mode,
        reasoning_effort, input_fingerprint, generating_message_id, decided_at)
     values ($1, $2, $3, 'approved', $4, 'gpt-5.6-sol', 'pro', 'high', $5, $6, now())`,
    [summaryId, userId, nodeId, content, "b".repeat(64), messageId],
  );
  await pool.query(
    `update nodes set published_synthesis_version_id = $1 where id = $2`,
    [summaryId, nodeId],
  );
  return summaryId;
}

async function insertPendingSummaryProposal(
  userId: string,
  nodeId: string,
  content: string,
) {
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
     values ($1, $2, $3, $4, $5, 'assistant', 'completed', 'Synthetic proposal response',
       'gpt-5.6-sol', $6, now())`,
    [
      messageId,
      userId,
      nodeId,
      randomUUID(),
      sequence.rows[0]?.value ?? "0",
      "e".repeat(64),
    ],
  );
  const proposalId = randomUUID();
  await pool.query(
    `insert into synthesis_versions
       (id, user_id, node_id, status, content, model, reasoning_mode,
        reasoning_effort, input_fingerprint, generating_message_id)
     values ($1, $2, $3, 'pending', $4, 'gpt-5.6-sol', 'pro', 'high', $5, $6)`,
    [proposalId, userId, nodeId, content, "f".repeat(64), messageId],
  );
  return proposalId;
}

function claimInput(input: {
  nodeId: string;
  nodeTitle: string;
  nodeArchivedAt?: string | null;
  clientRequestId?: string;
  baseSynthesisVersionId?: string | null;
  inputs?: BranchOutlineInputSnapshot[];
}) {
  const inputs = input.inputs ?? [];
  const baseSynthesisVersionId = input.baseSynthesisVersionId ?? null;
  return {
    nodeId: input.nodeId,
    clientRequestId: input.clientRequestId ?? randomUUID(),
    baseSynthesisVersionId,
    inputs,
    inputFingerprint: fingerprintBranchOutlineGeneration({
      nodeId: input.nodeId,
      nodeTitle: input.nodeTitle,
      nodeArchivedAt: input.nodeArchivedAt ?? null,
      baseSynthesisVersionId,
      inputs,
    }),
  };
}

function childInput(input: {
  sourceNodeId: string;
  title: string;
  position?: number;
  sourceSynthesisVersionId?: string | null;
  sourceBranchOutlineVersionId?: string | null;
  outlineState?: "none" | "current" | "stale";
}) {
  const position = input.position ?? 0;
  const sourceSynthesisVersionId = input.sourceSynthesisVersionId ?? null;
  const sourceBranchOutlineVersionId = input.sourceBranchOutlineVersionId ?? null;
  const summaryState = sourceSynthesisVersionId ? "published" as const : "none" as const;
  const outlineState = input.outlineState ?? "none";
  const state = {
    sourceNodeId: input.sourceNodeId,
    sourceSynthesisVersionId,
    sourceBranchOutlineVersionId,
    summaryState,
    outlineState,
    position,
    title: input.title,
    archivedAt: null,
  };
  return {
    sourceNodeId: state.sourceNodeId,
    sourceSynthesisVersionId: state.sourceSynthesisVersionId,
    sourceBranchOutlineVersionId: state.sourceBranchOutlineVersionId,
    summaryState: state.summaryState,
    outlineState: state.outlineState,
    position: state.position,
    sourceStateFingerprint: fingerprintBranchOutlineSourceState(state),
  } satisfies BranchOutlineInputSnapshot;
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

describe("Branch Outline persistence", () => {
  it("claims a replay-safe generation and rejects conflicting or competing claims", async () => {
    const userId = await insertUser();
    const nodeId = await insertNode(userId, "Replay node");
    const input = claimInput({ nodeId, nodeTitle: "Replay node" });

    const claimed = await claimBranchOutlineGenerationForUser(userId, input);
    expect(claimed).toMatchObject({
      replayed: false,
      generation: { status: "pending", clientRequestId: input.clientRequestId },
      inputs: [],
    });
    await expect(claimBranchOutlineGenerationForUser(userId, input)).resolves.toMatchObject({
      replayed: true,
      generation: { id: claimed.generation.id },
    });
    await expect(claimBranchOutlineGenerationForUser(userId, {
      ...input,
      inputFingerprint: "c".repeat(64),
    })).rejects.toEqual(new BranchOutlineServiceError("request-conflict"));
    await expect(claimBranchOutlineGenerationForUser(userId, claimInput({
      nodeId,
      nodeTitle: "Replay node",
    })))
      .rejects.toEqual(new BranchOutlineServiceError("generation-in-progress"));
  });

  it("installs one immutable completed outline without changing the Summary", async () => {
    const userId = await insertUser();
    const nodeId = await insertNode(userId, "Completion node");
    const summaryId = await insertApprovedSummary(userId, nodeId, "Approved Summary");
    const claim = await claimBranchOutlineGenerationForUser(userId, claimInput({
      nodeId,
      nodeTitle: "Completion node",
      baseSynthesisVersionId: summaryId,
    }));
    await expect(recordBranchOutlineProviderResponseForUser(userId, {
      nodeId,
      generationId: claim.generation.id,
      providerResponseId: "resp_synthetic_outline",
    })).resolves.toMatchObject({ replayed: false });
    await expect(recordBranchOutlineProviderResponseForUser(userId, {
      nodeId,
      generationId: claim.generation.id,
      providerResponseId: "resp_synthetic_outline",
    })).resolves.toMatchObject({ replayed: true });
    await expect(recordBranchOutlineProviderResponseForUser(userId, {
      nodeId,
      generationId: claim.generation.id,
      providerResponseId: "resp_conflicting_outline",
    })).rejects.toEqual(new BranchOutlineServiceError("invalid-generation"));

    const completed = await completeBranchOutlineGenerationForUser(userId, {
      nodeId,
      generationId: claim.generation.id,
      draft: { content: "# Branch\n\n- Current direction" },
    });
    expect(completed).toMatchObject({
      installed: true,
      replayed: false,
      generation: { status: "completed", content: "# Branch\n\n- Current direction" },
    });
    await expect(recordBranchOutlineProviderResponseForUser(userId, {
      nodeId,
      generationId: claim.generation.id,
      providerResponseId: "resp_synthetic_outline",
    })).rejects.toEqual(new BranchOutlineServiceError("generation-not-pending"));
    await expect(completeBranchOutlineGenerationForUser(userId, {
      nodeId,
      generationId: claim.generation.id,
      draft: { content: "Different replay body" },
    })).resolves.toMatchObject({
      installed: true,
      replayed: true,
      generation: { content: "# Branch\n\n- Current direction" },
    });
    expect(await getBranchOutlineWorkspaceForUser(userId, nodeId)).toMatchObject({
      current: { id: claim.generation.id, status: "completed" },
      pending: null,
      latestFailure: null,
      staleAt: null,
      staleReason: null,
    });
    const node = await pool.query<{
      current_branch_outline_version_id: string;
      published_synthesis_version_id: string;
    }>(
      `select current_branch_outline_version_id, published_synthesis_version_id
       from nodes where id = $1`,
      [nodeId],
    );
    expect(node.rows[0]).toEqual({
      current_branch_outline_version_id: claim.generation.id,
      published_synthesis_version_id: summaryId,
    });
    await expect(pool.query(
      `update branch_outline_versions set content = 'Mutated' where id = $1`,
      [claim.generation.id],
    )).rejects.toMatchObject({
      constraint: "branch_outline_versions_immutable_transition_check",
    });
  });

  it("preserves the current outline when a later generation fails", async () => {
    const userId = await insertUser();
    const nodeId = await insertNode(userId, "Failure node");
    const first = await claimBranchOutlineGenerationForUser(userId, claimInput({
      nodeId,
      nodeTitle: "Failure node",
    }));
    await completeBranchOutlineGenerationForUser(userId, {
      nodeId,
      generationId: first.generation.id,
      draft: { content: "Current outline" },
    });
    const second = await claimBranchOutlineGenerationForUser(userId, claimInput({
      nodeId,
      nodeTitle: "Failure node",
    }));
    await failBranchOutlineGenerationForUser(userId, {
      nodeId,
      generationId: second.generation.id,
      failureCode: "provider-timeout",
    });

    expect(await getBranchOutlineWorkspaceForUser(userId, nodeId)).toMatchObject({
      current: { id: first.generation.id, content: "Current outline" },
      pending: null,
      latestFailure: { id: second.generation.id, failureCode: "provider-timeout" },
    });
  });

  it("fails and replaces an expired pending generation without allowing late installation", async () => {
    const userId = await insertUser();
    const nodeId = await insertNode(userId, "Expired generation");
    const abandoned = await claimBranchOutlineGenerationForUser(userId, claimInput({
      nodeId,
      nodeTitle: "Expired generation",
    }));
    await pool.query(
      `update branch_outline_versions set updated_at = $1 where id = $2`,
      [new Date(Date.now() - BRANCH_OUTLINE_GENERATION_LEASE_MS - 1_000), abandoned.generation.id],
    );

    const replacement = await claimBranchOutlineGenerationForUser(userId, claimInput({
      nodeId,
      nodeTitle: "Expired generation",
    }));
    expect(replacement).toMatchObject({
      replayed: false,
      generation: { status: "pending" },
    });
    const expired = await pool.query<{ status: string; failure_code: string }>(
      `select status, failure_code from branch_outline_versions where id = $1`,
      [abandoned.generation.id],
    );
    expect(expired.rows).toEqual([{
      status: "failed",
      failure_code: "stream-disconnected",
    }]);
    await expect(completeBranchOutlineGenerationForUser(userId, {
      nodeId,
      generationId: abandoned.generation.id,
      draft: { content: "Late abandoned output" },
    })).resolves.toMatchObject({
      installed: false,
      replayed: true,
      generation: { status: "failed", failureCode: "stream-disconnected" },
    });
    expect((await getBranchOutlineWorkspaceForUser(userId, nodeId)).pending)
      .toMatchObject({ id: replacement.generation.id });
  });

  it("seals exact outline and Summary-proposal provenance while preserving cascades", async () => {
    const userId = await insertUser();
    const nodeId = await insertNode(userId, "Sealed provenance");
    const childId = await insertNode(userId, "Input child", nodeId);
    const claim = await claimBranchOutlineGenerationForUser(userId, claimInput({
      nodeId,
      nodeTitle: "Sealed provenance",
      inputs: [childInput({ sourceNodeId: childId, title: "Input child" })],
    }));
    await completeBranchOutlineGenerationForUser(userId, {
      nodeId,
      generationId: claim.generation.id,
      draft: { content: "Sealed outline" },
    });

    await expect(pool.query(
      `update branch_outline_inputs set source_state_fingerprint = $1
       where outline_version_id = $2`,
      ["1".repeat(64), claim.generation.id],
    )).rejects.toMatchObject({ constraint: "branch_outline_inputs_immutable_check" });
    await expect(pool.query(
      `delete from branch_outline_inputs where outline_version_id = $1`,
      [claim.generation.id],
    )).rejects.toMatchObject({ constraint: "branch_outline_inputs_immutable_check" });
    await expect(pool.query(
      `insert into branch_outline_inputs
         (outline_version_id, user_id, node_id, source_node_id, summary_state,
          outline_state, source_state_fingerprint, position)
       values ($1, $2, $3, $4, 'none', 'none', $5, 1)`,
      [claim.generation.id, userId, nodeId, randomUUID(), "2".repeat(64)],
    )).rejects.toMatchObject({
      constraint: "branch_outline_inputs_parent_pending_check",
    });

    const proposalId = await insertPendingSummaryProposal(
      userId,
      nodeId,
      "Proposal with exact outline provenance",
    );
    await pool.query(
      `insert into synthesis_inputs
         (synthesis_version_id, user_id, node_id, relation, source_node_id,
          source_branch_outline_version_id, source_state_fingerprint, position)
       values ($1, $2, $3, 'outline', $3, $4, $5, 0)`,
      [proposalId, userId, nodeId, claim.generation.id, "3".repeat(64)],
    );
    await pool.query(
      `update synthesis_versions set status = 'rejected', decided_at = now()
       where id = $1`,
      [proposalId],
    );
    await expect(pool.query(
      `update synthesis_inputs set source_state_fingerprint = $1
       where synthesis_version_id = $2`,
      ["4".repeat(64), proposalId],
    )).rejects.toMatchObject({ constraint: "synthesis_inputs_immutable_check" });
    await expect(pool.query(
      `delete from synthesis_inputs where synthesis_version_id = $1`,
      [proposalId],
    )).rejects.toMatchObject({ constraint: "synthesis_inputs_immutable_check" });
    await expect(pool.query(
      `insert into synthesis_inputs
         (synthesis_version_id, user_id, node_id, relation, source_node_id,
          source_branch_outline_version_id, source_state_fingerprint, position)
       values ($1, $2, $3, 'outline', $3, $4, $5, 0)`,
      [proposalId, userId, nodeId, claim.generation.id, "5".repeat(64)],
    )).rejects.toMatchObject({ constraint: "synthesis_inputs_parent_pending_check" });
  });

  it("serializes late provenance inserts against terminal transitions", async () => {
    const userId = await insertUser();
    const nodeId = await insertNode(userId, "Provenance race");
    const claim = await claimBranchOutlineGenerationForUser(userId, claimInput({
      nodeId,
      nodeTitle: "Provenance race",
    }));
    const outlineTransition = await pool.connect();
    const outlineInput = await pool.connect();
    try {
      await outlineTransition.query("begin");
      await outlineTransition.query(
        `select id from branch_outline_versions where id = $1 for update`,
        [claim.generation.id],
      );
      const lateInsert = expect(outlineInput.query(
        `insert into branch_outline_inputs
           (outline_version_id, user_id, node_id, source_node_id, summary_state,
            outline_state, source_state_fingerprint, position)
         values ($1, $2, $3, $4, 'none', 'none', $5, 0)`,
        [claim.generation.id, userId, nodeId, randomUUID(), "6".repeat(64)],
      )).rejects.toMatchObject({
        constraint: "branch_outline_inputs_parent_pending_check",
      });
      await outlineTransition.query(
        `update branch_outline_versions
         set status = 'completed', content = 'Race winner', completed_at = now()
         where id = $1`,
        [claim.generation.id],
      );
      await outlineTransition.query("commit");
      await lateInsert;
    } finally {
      await outlineTransition.query("rollback").catch(() => undefined);
      outlineTransition.release();
      outlineInput.release();
    }

    const proposalId = await insertPendingSummaryProposal(
      userId,
      nodeId,
      "Proposal race",
    );
    const proposalTransition = await pool.connect();
    const proposalInput = await pool.connect();
    try {
      await proposalTransition.query("begin");
      await proposalTransition.query(
        `select id from synthesis_versions where id = $1 for update`,
        [proposalId],
      );
      const lateInsert = expect(proposalInput.query(
        `insert into synthesis_inputs
           (synthesis_version_id, user_id, node_id, relation, source_node_id,
            source_branch_outline_version_id, source_state_fingerprint, position)
         values ($1, $2, $3, 'outline', $3, $4, $5, 0)`,
        [proposalId, userId, nodeId, claim.generation.id, "7".repeat(64)],
      )).rejects.toMatchObject({ constraint: "synthesis_inputs_parent_pending_check" });
      await proposalTransition.query(
        `update synthesis_versions set status = 'rejected', decided_at = now()
         where id = $1`,
        [proposalId],
      );
      await proposalTransition.query("commit");
      await lateInsert;
    } finally {
      await proposalTransition.query("rollback").catch(() => undefined);
      proposalTransition.release();
      proposalInput.release();
    }
  });

  it("fails installation when the recorded child state changes", async () => {
    const userId = await insertUser();
    const parentId = await insertNode(userId, "Parent");
    const childId = await insertNode(userId, "Child", parentId);
    const input = childInput({ sourceNodeId: childId, title: "Child" });
    const claim = await claimBranchOutlineGenerationForUser(userId, claimInput({
      nodeId: parentId,
      nodeTitle: "Parent",
      inputs: [input],
    }));
    await pool.query(`update nodes set title = 'Renamed child' where id = $1`, [childId]);

    const completed = await completeBranchOutlineGenerationForUser(userId, {
      nodeId: parentId,
      generationId: claim.generation.id,
      draft: { content: "Stale generated outline" },
    });
    expect(completed).toMatchObject({
      installed: false,
      generation: { status: "failed", failureCode: "inputs-changed" },
    });
    expect(await getBranchOutlineWorkspaceForUser(userId, parentId)).toMatchObject({
      current: null,
      pending: null,
      latestFailure: { id: claim.generation.id, failureCode: "inputs-changed" },
    });
  });

  it("fails installation when the target Summary changes", async () => {
    const userId = await insertUser();
    const nodeId = await insertNode(userId, "Summary race node");
    const firstSummaryId = await insertApprovedSummary(userId, nodeId, "First Summary");
    const claim = await claimBranchOutlineGenerationForUser(userId, claimInput({
      nodeId,
      nodeTitle: "Summary race node",
      baseSynthesisVersionId: firstSummaryId,
    }));
    await insertApprovedSummary(userId, nodeId, "Second Summary");

    await expect(completeBranchOutlineGenerationForUser(userId, {
      nodeId,
      generationId: claim.generation.id,
      draft: { content: "Generated from the first Summary" },
    })).resolves.toMatchObject({
      installed: false,
      generation: { status: "failed", failureCode: "inputs-changed" },
    });
  });

  it("fails installation when the target archive state changes", async () => {
    const userId = await insertUser();
    const nodeId = await insertNode(userId, "Archive race node");
    const claim = await claimBranchOutlineGenerationForUser(userId, claimInput({
      nodeId,
      nodeTitle: "Archive race node",
    }));
    await pool.query(`update nodes set archived_at = now() where id = $1`, [nodeId]);

    await expect(completeBranchOutlineGenerationForUser(userId, {
      nodeId,
      generationId: claim.generation.id,
      draft: { content: "Generated before archive" },
    })).resolves.toMatchObject({
      installed: false,
      generation: { status: "failed", failureCode: "inputs-changed" },
    });
  });

  it("serializes competing claims and owner-scopes unavailable nodes", async () => {
    const userId = await insertUser();
    const otherUserId = await insertUser();
    const nodeId = await insertNode(userId, "Race node");
    const results = await Promise.allSettled([
      claimBranchOutlineGenerationForUser(userId, claimInput({
        nodeId,
        nodeTitle: "Race node",
      })),
      claimBranchOutlineGenerationForUser(userId, claimInput({
        nodeId,
        nodeTitle: "Race node",
      })),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(results.find(({ status }) => status === "rejected")).toMatchObject({
      reason: new BranchOutlineServiceError("generation-in-progress"),
    });
    await expect(getBranchOutlineWorkspaceForUser(otherUserId, nodeId))
      .rejects.toEqual(new BranchOutlineServiceError("node-not-found"));
  });
});
