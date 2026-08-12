import { randomUUID } from "node:crypto";

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { Pool } from "pg";

import {
  persistChatTurnContentPrefixForUser,
  cancelChatTurnForUser,
  ChatServiceError,
  completeChatTurnForUser,
  createChatTurnForUser,
  failChatTurnForUser,
  getChatMessagesForUser,
  getChatTurnForUser,
  recordChatTurnContextForUser,
  recordChatTurnProviderResponseForUser,
  retryChatTurnForUser,
  startChatTurnForUser,
} from "../../src/lib/server/chat-service";
import type { FailChatTurnInput } from "../../src/lib/chat/contracts";
import {
  MAX_CHAT_CONTEXT_CHARACTERS,
  prepareChatContextForUser,
} from "../../src/lib/server/chat-context";
import { deleteNodeForUser } from "../../src/lib/server/node-service";
import { createExternalCitationEvidence } from "../../src/lib/server/external-citations";
import {
  approveSynthesisProposalForUser,
  getSynthesisWorkspaceForUser,
  SynthesisServiceError,
} from "../../src/lib/server/synthesis-service";

const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL or DATABASE_URL_UNPOOLED is required for integration tests.");
}

const pool = new Pool({ connectionString });
const userIds = new Set<string>();

async function insertUser() {
  const userId = `chat-user-${randomUUID()}`;
  userIds.add(userId);
  await pool.query(
    `insert into "user" (id, name, email, email_verified)
     values ($1, 'Synthetic Chat User', $2, true)`,
    [userId, `${randomUUID()}@example.test`],
  );
  return userId;
}

async function insertNode(userId: string, title = "Chat node", parentId: string | null = null) {
  const positionResult = await pool.query<{ position: number }>(
    `select coalesce(max(position), -1)::int + 1 as position
     from nodes
     where user_id = $1 and parent_id is not distinct from $2`,
    [userId, parentId],
  );
  const nodeId = randomUUID();
  await pool.query(
    `insert into nodes (id, user_id, parent_id, position, title)
     values ($1, $2, $3, $4, $5)`,
    [nodeId, userId, parentId, positionResult.rows[0]?.position ?? 0, title],
  );
  return nodeId;
}

async function installBranchOutline(
  userId: string,
  nodeId: string,
  content: string,
  stale = false,
) {
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
         branch_outline_stale_at = case when $2 then now() else null end,
         branch_outline_stale_reason = case when $2 then 'branch-content-changed' else null end
     where user_id = $3 and id = $4`,
    [outlineId, stale, userId, nodeId],
  );
  return outlineId;
}

async function prepareProposalTurn(input: {
  userId: string;
  nodeId: string;
  content: string;
  refinementProposalId?: string | null;
}) {
  const clientMessageId = randomUUID();
  const turn = await createChatTurnForUser(input.userId, {
    nodeId: input.nodeId,
    clientMessageId,
    content: input.content,
    webSearchAuthorized: false,
    proposalRequested: true,
    refinementProposalId: input.refinementProposalId ?? null,
  }, { claimAssistant: true });
  const context = await prepareChatContextForUser(input.userId, {
    nodeId: input.nodeId,
    clientMessageId,
  });
  await recordChatTurnContextForUser(input.userId, {
    nodeId: input.nodeId,
    clientMessageId,
    model: "gpt-5.6-sol",
    contextFingerprint: context.fingerprint,
  });
  await persistChatTurnContentPrefixForUser(input.userId, {
    nodeId: input.nodeId,
    clientMessageId,
    contentPrefix: "Synthetic proposal response.",
  });
  return { clientMessageId, context, turn };
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

describe("persistent chat ledger", () => {
  it("atomically claims generation and recovers abandoned active turns after the lease", async () => {
    const userId = await insertUser();
    const nodeId = await insertNode(userId);
    const clientMessageId = randomUUID();
    const claimed = await createChatTurnForUser(userId, {
      nodeId,
      clientMessageId,
      content: "Claim this once",
      webSearchAuthorized: false,
    }, { claimAssistant: true });
    expect(claimed).toMatchObject({
      generationClaimed: true,
      assistantMessage: { status: "streaming" },
    });
    const replayed = await createChatTurnForUser(userId, {
      nodeId,
      clientMessageId,
      content: "Claim this once",
      webSearchAuthorized: false,
    }, { claimAssistant: true });
    expect(replayed).toMatchObject({
      replayed: true,
      generationClaimed: false,
      assistantMessage: { status: "streaming" },
    });

    await pool.query(
      `update chat_messages set updated_at = now() - interval '6 minutes'
       where user_id = $1 and node_id = $2 and client_message_id = $3 and role = 'assistant'`,
      [userId, nodeId, clientMessageId],
    );
    const recovered = await getChatMessagesForUser(userId, { nodeId });
    expect(recovered.messages.find((message) => message.role === "assistant")).toMatchObject({
      status: "failed",
      failureCode: "stream-disconnected",
    });
  });

  it("builds and records a bounded deterministic context snapshot for the claimed turn", async () => {
    const userId = await insertUser();
    const rootId = await insertNode(userId, "Context root");
    const nodeId = await insertNode(userId, "Context leaf", rootId);
    const outlineId = await installBranchOutline(
      userId,
      nodeId,
      "# Branch Outline\n\nRecursive context",
    );
    const priorClientMessageId = randomUUID();
    await createChatTurnForUser(userId, {
      nodeId,
      clientMessageId: priorClientMessageId,
      content: "Earlier owner message",
      webSearchAuthorized: false,
    }, { claimAssistant: true });
    await persistChatTurnContentPrefixForUser(userId, {
      nodeId,
      clientMessageId: priorClientMessageId,
      contentPrefix: "Earlier assistant response",
    });
    await completeChatTurnForUser(userId, { nodeId, clientMessageId: priorClientMessageId });

    const clientMessageId = randomUUID();
    await createChatTurnForUser(userId, {
      nodeId,
      clientMessageId,
      content: "Current owner request",
      webSearchAuthorized: false,
    }, { claimAssistant: true });

    const prepared = await prepareChatContextForUser(userId, { nodeId, clientMessageId });
    const repeated = await prepareChatContextForUser(userId, { nodeId, clientMessageId });
    expect(prepared.snapshot).toMatchObject({
      version: 7,
      node: {
        id: nodeId,
        title: "Context leaf",
        breadcrumb: {
          items: [
            { id: rootId, title: "Context root" },
            { id: nodeId, title: "Context leaf" },
          ],
          hasOmittedAncestors: false,
        },
        publishedSynthesis: { state: "none" },
        refinementProposal: { state: "none" },
        branchOutline: {
          state: "current",
          versionId: outlineId,
          content: "# Branch Outline\n\nRecursive context",
        },
      },
      messages: [
        { role: "user", content: "Earlier owner message" },
        { role: "assistant", content: "Earlier assistant response" },
        { role: "user", content: "Current owner request" },
      ],
      relatedEvidence: [],
    });
    expect(prepared.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(repeated.fingerprint).toBe(prepared.fingerprint);
    expect(prepared.outlineInput).toMatchObject({ versionId: outlineId });
    expect(prepared.input[0]?.content).toContain("Recursive context");
    expect(prepared.input[0]?.content).not.toContain(rootId);
    expect(prepared.input[0]?.content).not.toContain(nodeId);
    expect(prepared.input[0]?.content).not.toContain(outlineId);
    expect(prepared.input.at(-1)).toEqual({
      role: "user",
      content: "Current owner request",
    });

    await recordChatTurnContextForUser(userId, {
      nodeId,
      clientMessageId,
      model: "gpt-5.6-sol",
      contextFingerprint: prepared.fingerprint,
    });
    await recordChatTurnProviderResponseForUser(userId, {
      nodeId,
      clientMessageId,
      providerResponseId: "resp_synthetic",
    });
    const stored = await pool.query<{
      context_fingerprint: string;
      model: string;
      provider_response_id: string;
    }>(
      `select context_fingerprint, model, provider_response_id
       from chat_messages
       where user_id = $1 and node_id = $2 and client_message_id = $3 and role = 'assistant'`,
      [userId, nodeId, clientMessageId],
    );
    expect(stored.rows).toEqual([{
      context_fingerprint: prepared.fingerprint,
      model: "gpt-5.6-sol",
      provider_response_id: "resp_synthetic",
    }]);
  });

  it("atomically completes a requested turn with an immutable pending synthesis proposal", async () => {
    const userId = await insertUser();
    const nodeId = await insertNode(userId, "Proposal node");
    const clientMessageId = randomUUID();
    const turn = await createChatTurnForUser(userId, {
      nodeId,
      clientMessageId,
      content: "Propose a synthesis",
      webSearchAuthorized: false,
      proposalRequested: true,
    }, { claimAssistant: true });
    expect(turn.userMessage.proposalRequested).toBe(true);

    const prepared = await prepareChatContextForUser(userId, { nodeId, clientMessageId });
    await recordChatTurnContextForUser(userId, {
      nodeId,
      clientMessageId,
      model: "gpt-5.6-sol",
      contextFingerprint: prepared.fingerprint,
    });
    await persistChatTurnContentPrefixForUser(userId, {
      nodeId,
      clientMessageId,
      contentPrefix: "Here is a proposal for review.",
    });
    const completed = await completeChatTurnForUser(userId, {
      nodeId,
      clientMessageId,
    }, {
      proposal: {
        baseVersionId: null,
        draft: { content: "# Proposal\n\nA concise synthetic synthesis.", citations: [] },
        model: "gpt-5.6-sol",
        reasoningMode: "pro",
        reasoningEffort: "high",
        inputFingerprint: prepared.fingerprint,
      },
    });

    expect(completed).toMatchObject({ status: "completed", proposalRequested: false });
    const workspace = await getSynthesisWorkspaceForUser(userId, nodeId);
    expect(workspace).toMatchObject({
      published: null,
      pending: {
        nodeId,
        baseVersionId: null,
        status: "pending",
        content: "# Proposal\n\nA concise synthetic synthesis.",
        model: "gpt-5.6-sol",
        reasoningMode: "pro",
        reasoningEffort: "high",
        inputFingerprint: prepared.fingerprint,
        generatingMessageId: completed.id,
        decidedAt: null,
      },
    });
    const node = await pool.query<{ published_synthesis_version_id: string | null }>(
      `select published_synthesis_version_id from nodes where id = $1`,
      [nodeId],
    );
    expect(node.rows[0]?.published_synthesis_version_id).toBeNull();
  });

  it("atomically carries validated chat research into a cited synthesis proposal", async () => {
    const userId = await insertUser();
    const nodeId = await insertNode(userId, "External proposal node");
    const clientMessageId = randomUUID();
    const created = await createChatTurnForUser(userId, {
      nodeId,
      clientMessageId,
      content: "Research and propose a synthesis",
      webSearchAuthorized: true,
      proposalRequested: true,
    }, { claimAssistant: true });
    const fingerprint = "d".repeat(64);
    await recordChatTurnContextForUser(userId, {
      nodeId,
      clientMessageId,
      model: "gpt-5.6-sol",
      contextFingerprint: fingerprint,
    });
    const researchContent = "A validated research claim.";
    await persistChatTurnContentPrefixForUser(userId, {
      nodeId,
      clientMessageId,
      contentPrefix: researchContent,
    });
    const completed = await completeChatTurnForUser(userId, {
      nodeId,
      clientMessageId,
    }, {
      externalCitations: [{
        kind: "external",
        ordinal: 1,
        startUtf16: researchContent.length,
        endUtf16: researchContent.length,
        title: "Validated research source",
        url: "https://example.test/research",
      }],
      proposal: {
        baseVersionId: null,
        draft: {
          content: "# Proposal\n\nA supported synthesis claim.",
          citations: [],
          externalCitations: [{
            sourceAlias: "W1",
            citedText: "supported synthesis claim",
          }],
        },
        model: "gpt-5.6-sol",
        reasoningMode: "pro",
        reasoningEffort: "high",
        inputFingerprint: fingerprint,
        externalEvidence: createExternalCitationEvidence({
          content: researchContent,
          citations: [{
            kind: "external",
            ordinal: 1,
            startUtf16: researchContent.length,
            endUtf16: researchContent.length,
            title: "Validated research source",
            url: "https://example.test/research",
          }],
          owner: "assistant-message",
          ownerId: created.assistantMessage.id,
        }),
      },
    });

    expect(completed.citations).toHaveLength(1);
    const pending = (await getSynthesisWorkspaceForUser(userId, nodeId)).pending;
    expect(pending?.citations).toEqual([{
      kind: "external",
      ordinal: 1,
      startUtf16: "# Proposal\n\nA supported synthesis claim".length,
      endUtf16: "# Proposal\n\nA supported synthesis claim".length,
      title: "Validated research source",
      url: "https://example.test/research",
    }]);

    await approveSynthesisProposalForUser(userId, {
      nodeId,
      proposalId: pending!.id,
    });
    const published = (await getSynthesisWorkspaceForUser(userId, nodeId)).published;
    expect(published?.citations).toEqual(pending?.citations);

    const laterClientMessageId = randomUUID();
    await createChatTurnForUser(userId, {
      nodeId,
      clientMessageId: laterClientMessageId,
      content: "Refine the cited synthesis without new web research",
      webSearchAuthorized: false,
      proposalRequested: true,
    }, { claimAssistant: true });
    const laterContext = await prepareChatContextForUser(userId, {
      nodeId,
      clientMessageId: laterClientMessageId,
    });
    expect(laterContext.externalEvidence).toHaveLength(1);
    expect(laterContext.externalEvidence[0]).toMatchObject({
      alias: "W1",
      title: "Validated research source",
      url: "https://example.test/research",
    });
    expect(laterContext.externalEvidence[0]?.provenance).toContainEqual(
      expect.objectContaining({ owner: "synthesis-version", ownerId: published!.id }),
    );
    const laterFingerprint = "f".repeat(64);
    await recordChatTurnContextForUser(userId, {
      nodeId,
      clientMessageId: laterClientMessageId,
      model: "gpt-5.6-sol",
      contextFingerprint: laterFingerprint,
    });
    await persistChatTurnContentPrefixForUser(userId, {
      nodeId,
      clientMessageId: laterClientMessageId,
      contentPrefix: "I drafted a cited refinement.",
    });
    await completeChatTurnForUser(userId, {
      nodeId,
      clientMessageId: laterClientMessageId,
    }, {
      proposal: {
        baseVersionId: published!.id,
        draft: {
          content: "A refined supported synthesis claim.",
          citations: [],
          externalCitations: [{
            sourceAlias: "W1",
            citedText: "supported synthesis claim",
          }],
        },
        model: "gpt-5.6-sol",
        reasoningMode: "pro",
        reasoningEffort: "high",
        inputFingerprint: laterFingerprint,
        externalEvidence: laterContext.externalEvidence,
      },
    });
    const refined = (await getSynthesisWorkspaceForUser(userId, nodeId)).pending;
    expect(refined?.citations).toMatchObject([{
      kind: "external",
      ordinal: 1,
      title: "Validated research source",
      url: "https://example.test/research",
    }]);
  });

  it("rejects synthesis source aliases that do not match the generating chat citations", async () => {
    const userId = await insertUser();
    const nodeId = await insertNode(userId, "Mismatched external proposal node");
    const clientMessageId = randomUUID();
    const created = await createChatTurnForUser(userId, {
      nodeId,
      clientMessageId,
      content: "Research and propose",
      webSearchAuthorized: true,
      proposalRequested: true,
    }, { claimAssistant: true });
    const fingerprint = "e".repeat(64);
    await recordChatTurnContextForUser(userId, {
      nodeId,
      clientMessageId,
      model: "gpt-5.6-sol",
      contextFingerprint: fingerprint,
    });
    const researchContent = "Research response.";
    await persistChatTurnContentPrefixForUser(userId, {
      nodeId,
      clientMessageId,
      contentPrefix: researchContent,
    });
    await expect(completeChatTurnForUser(userId, { nodeId, clientMessageId }, {
      externalCitations: [{
        kind: "external",
        ordinal: 1,
        startUtf16: researchContent.length,
        endUtf16: researchContent.length,
        title: "Recorded source",
        url: "https://example.test/recorded",
      }],
      proposal: {
        baseVersionId: null,
        draft: {
          content: "A proposed claim.",
          citations: [],
          externalCitations: [{ sourceAlias: "W1", citedText: "proposed claim" }],
        },
        model: "gpt-5.6-sol",
        reasoningMode: "pro",
        reasoningEffort: "high",
        inputFingerprint: fingerprint,
        externalEvidence: createExternalCitationEvidence({
          content: researchContent,
          citations: [{
            kind: "external",
            ordinal: 1,
            startUtf16: researchContent.length,
            endUtf16: researchContent.length,
            title: "Invented source",
            url: "https://example.test/invented",
          }],
          owner: "assistant-message",
          ownerId: created.assistantMessage.id,
        }),
      },
    })).rejects.toEqual(new SynthesisServiceError("invalid-proposal"));

    const stored = await pool.query<{ count: number }>(
      `select count(*)::int as count from citations where user_id = $1 and owner_node_id = $2`,
      [userId, nodeId],
    );
    expect(stored.rows[0]?.count).toBe(0);
  });

  it("rejects proposal persistence attributed to any model outside the fixed profile", async () => {
    const userId = await insertUser();
    const nodeId = await insertNode(userId, "Wrong-model proposal node");
    const clientMessageId = randomUUID();
    await createChatTurnForUser(userId, {
      nodeId,
      clientMessageId,
      content: "Propose with the fixed profile",
      webSearchAuthorized: false,
      proposalRequested: true,
    }, { claimAssistant: true });
    const context = await prepareChatContextForUser(userId, { nodeId, clientMessageId });
    await recordChatTurnContextForUser(userId, {
      nodeId,
      clientMessageId,
      model: "gpt-5.6-sol",
      contextFingerprint: context.fingerprint,
    });
    await persistChatTurnContentPrefixForUser(userId, {
      nodeId,
      clientMessageId,
      contentPrefix: "Synthetic response.",
    });

    await expect(completeChatTurnForUser(userId, { nodeId, clientMessageId }, {
      proposal: {
        baseVersionId: null,
        draft: { content: "Wrong-model proposal", citations: [] },
        model: "gpt-4.1" as "gpt-5.6-sol",
        reasoningMode: "pro",
        reasoningEffort: "high",
        inputFingerprint: context.fingerprint,
      },
    })).rejects.toEqual(new ChatServiceError("retry-unavailable"));
    expect(await getSynthesisWorkspaceForUser(userId, nodeId)).toEqual({
      published: null,
      staleAt: null,
      pending: null,
      history: [],
    });
  });

  it("records the exact published base in later proposal context without publishing generation", async () => {
    const userId = await insertUser();
    const nodeId = await insertNode(userId, "Versioned proposal node");

    const firstClientMessageId = randomUUID();
    await createChatTurnForUser(userId, {
      nodeId,
      clientMessageId: firstClientMessageId,
      content: "Create the first proposal",
      webSearchAuthorized: false,
      proposalRequested: true,
    }, { claimAssistant: true });
    const firstContext = await prepareChatContextForUser(userId, {
      nodeId,
      clientMessageId: firstClientMessageId,
    });
    await recordChatTurnContextForUser(userId, {
      nodeId,
      clientMessageId: firstClientMessageId,
      model: "gpt-5.6-sol",
      contextFingerprint: firstContext.fingerprint,
    });
    await persistChatTurnContentPrefixForUser(userId, {
      nodeId,
      clientMessageId: firstClientMessageId,
      contentPrefix: "First proposal response.",
    });
    await completeChatTurnForUser(userId, {
      nodeId,
      clientMessageId: firstClientMessageId,
    }, {
      proposal: {
        baseVersionId: null,
        draft: { content: "First approved synthesis", citations: [] },
        model: "gpt-5.6-sol",
        reasoningMode: "pro",
        reasoningEffort: "high",
        inputFingerprint: firstContext.fingerprint,
      },
    });
    const firstWorkspace = await getSynthesisWorkspaceForUser(userId, nodeId);
    const firstProposalId = firstWorkspace.pending!.id;
    await pool.query(
      `update synthesis_versions
       set status = 'approved', decided_at = now(), updated_at = now()
       where id = $1`,
      [firstProposalId],
    );
    await pool.query(
      `update nodes set published_synthesis_version_id = $1 where id = $2`,
      [firstProposalId, nodeId],
    );

    const secondClientMessageId = randomUUID();
    await createChatTurnForUser(userId, {
      nodeId,
      clientMessageId: secondClientMessageId,
      content: "Create a revision",
      webSearchAuthorized: false,
      proposalRequested: true,
    }, { claimAssistant: true });
    const secondContext = await prepareChatContextForUser(userId, {
      nodeId,
      clientMessageId: secondClientMessageId,
    });
    expect(secondContext.snapshot.node.publishedSynthesis).toEqual({
      state: "published",
      versionId: firstProposalId,
      content: "First approved synthesis",
    });
    await recordChatTurnContextForUser(userId, {
      nodeId,
      clientMessageId: secondClientMessageId,
      model: "gpt-5.6-sol",
      contextFingerprint: secondContext.fingerprint,
    });
    await persistChatTurnContentPrefixForUser(userId, {
      nodeId,
      clientMessageId: secondClientMessageId,
      contentPrefix: "Revised proposal response.",
    });
    await completeChatTurnForUser(userId, {
      nodeId,
      clientMessageId: secondClientMessageId,
    }, {
      proposal: {
        baseVersionId: firstProposalId,
        draft: { content: "Second pending synthesis", citations: [] },
        model: "gpt-5.6-sol",
        reasoningMode: "pro",
        reasoningEffort: "high",
        inputFingerprint: secondContext.fingerprint,
      },
    });

    const workspace = await getSynthesisWorkspaceForUser(userId, nodeId);
    expect(workspace.published?.id).toBe(firstProposalId);
    expect(workspace.pending).toMatchObject({
      status: "pending",
      baseVersionId: firstProposalId,
      content: "Second pending synthesis",
    });
  });

  it("requires explicit refinement and atomically supersedes the exact pending proposal", async () => {
    const userId = await insertUser();
    const nodeId = await insertNode(userId, "Refinement node");
    const firstTurn = await prepareProposalTurn({
      userId,
      nodeId,
      content: "Create the pending synthesis",
    });
    await completeChatTurnForUser(userId, {
      nodeId,
      clientMessageId: firstTurn.clientMessageId,
    }, {
      proposal: {
        baseVersionId: null,
        draft: { content: "Original pending synthesis", citations: [] },
        model: "gpt-5.6-sol",
        reasoningMode: "pro",
        reasoningEffort: "high",
        inputFingerprint: firstTurn.context.fingerprint,
      },
    });
    const originalId = (await getSynthesisWorkspaceForUser(userId, nodeId)).pending!.id;

    await expect(createChatTurnForUser(userId, {
      nodeId,
      clientMessageId: randomUUID(),
      content: "Implicitly replace the pending proposal",
      webSearchAuthorized: false,
      proposalRequested: true,
    }, { claimAssistant: true })).rejects.toEqual(new ChatServiceError("proposal-conflict"));

    const failedRefinement = await prepareProposalTurn({
      userId,
      nodeId,
      content: "Try a refinement that fails",
      refinementProposalId: originalId,
    });
    expect(failedRefinement.context.snapshot.node.refinementProposal).toEqual({
      state: "pending",
      versionId: originalId,
      baseVersionId: null,
      content: "Original pending synthesis",
    });
    await failChatTurnForUser(userId, {
      nodeId,
      clientMessageId: failedRefinement.clientMessageId,
      failureCode: "generation-failed",
    });
    expect((await getSynthesisWorkspaceForUser(userId, nodeId)).pending?.id).toBe(originalId);

    const refinement = await prepareProposalTurn({
      userId,
      nodeId,
      content: "Refine the pending synthesis",
      refinementProposalId: originalId,
    });
    await completeChatTurnForUser(userId, {
      nodeId,
      clientMessageId: refinement.clientMessageId,
    }, {
      proposal: {
        baseVersionId: null,
        draft: { content: "Replacement pending synthesis", citations: [] },
        model: "gpt-5.6-sol",
        reasoningMode: "pro",
        reasoningEffort: "high",
        inputFingerprint: refinement.context.fingerprint,
        refinementProposalId: originalId,
      },
    });

    const versions = await pool.query<{
      id: string;
      status: string;
      content: string;
      decided_at: Date | null;
    }>(
      `select id, status, content, decided_at
       from synthesis_versions where user_id = $1 and node_id = $2 order by created_at`,
      [userId, nodeId],
    );
    expect(versions.rows).toHaveLength(2);
    expect(versions.rows.find(({ id }) => id === originalId)).toMatchObject({
      status: "superseded",
      content: "Original pending synthesis",
      decided_at: expect.any(Date),
    });
    expect(versions.rows.find(({ status }) => status === "pending")).toMatchObject({
      content: "Replacement pending synthesis",
      decided_at: null,
    });
    expect((await getSynthesisWorkspaceForUser(userId, nodeId)).published).toBeNull();
  });

  it("serializes competing refinements so exactly one replacement becomes pending", async () => {
    const userId = await insertUser();
    const nodeId = await insertNode(userId, "Refinement race node");
    const originalTurn = await prepareProposalTurn({
      userId,
      nodeId,
      content: "Create the original proposal",
    });
    await completeChatTurnForUser(userId, {
      nodeId,
      clientMessageId: originalTurn.clientMessageId,
    }, {
      proposal: {
        baseVersionId: null,
        draft: { content: "Original race proposal", citations: [] },
        model: "gpt-5.6-sol",
        reasoningMode: "pro",
        reasoningEffort: "high",
        inputFingerprint: originalTurn.context.fingerprint,
      },
    });
    const originalId = (await getSynthesisWorkspaceForUser(userId, nodeId)).pending!.id;
    const refinements = await Promise.all(["First", "Second"].map((label) =>
      prepareProposalTurn({
        userId,
        nodeId,
        content: `${label} explicit refinement`,
        refinementProposalId: originalId,
      })));

    const results = await Promise.allSettled(refinements.map((refinement, index) =>
      completeChatTurnForUser(userId, {
        nodeId,
        clientMessageId: refinement.clientMessageId,
      }, {
        proposal: {
          baseVersionId: null,
          draft: { content: `${index === 0 ? "First" : "Second"} replacement`, citations: [] },
          model: "gpt-5.6-sol",
          reasoningMode: "pro",
          reasoningEffort: "high",
          inputFingerprint: refinement.context.fingerprint,
          refinementProposalId: originalId,
        },
      })));
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const workspace = await getSynthesisWorkspaceForUser(userId, nodeId);
    expect(["First replacement", "Second replacement"]).toContain(workspace.pending?.content);
    const original = await pool.query<{ status: string }>(
      `select status from synthesis_versions where id = $1`,
      [originalId],
    );
    expect(original.rows[0]?.status).toBe("superseded");
  });

  it("serializes approval against refinement completion without publishing replacement text", async () => {
    const userId = await insertUser();
    const nodeId = await insertNode(userId, "Approval refinement race node");
    const originalTurn = await prepareProposalTurn({
      userId,
      nodeId,
      content: "Create an approvable proposal",
    });
    await completeChatTurnForUser(userId, {
      nodeId,
      clientMessageId: originalTurn.clientMessageId,
    }, {
      proposal: {
        baseVersionId: null,
        draft: { content: "Original decision proposal", citations: [] },
        model: "gpt-5.6-sol",
        reasoningMode: "pro",
        reasoningEffort: "high",
        inputFingerprint: originalTurn.context.fingerprint,
      },
    });
    const originalId = (await getSynthesisWorkspaceForUser(userId, nodeId)).pending!.id;
    const refinement = await prepareProposalTurn({
      userId,
      nodeId,
      content: "Refine while approval races",
      refinementProposalId: originalId,
    });

    const results = await Promise.allSettled([
      approveSynthesisProposalForUser(userId, { nodeId, proposalId: originalId }),
      completeChatTurnForUser(userId, {
        nodeId,
        clientMessageId: refinement.clientMessageId,
      }, {
        proposal: {
          baseVersionId: null,
          draft: { content: "Unpublished racing replacement", citations: [] },
          model: "gpt-5.6-sol",
          reasoningMode: "pro",
          reasoningEffort: "high",
          inputFingerprint: refinement.context.fingerprint,
          refinementProposalId: originalId,
        },
      }),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const workspace = await getSynthesisWorkspaceForUser(userId, nodeId);
    if (workspace.published) {
      expect(workspace.published.id).toBe(originalId);
      expect(workspace.pending).toBeNull();
    } else {
      expect(workspace.pending?.content).toBe("Unpublished racing replacement");
    }
  });

  it("rejects proposal persistence for ordinary chat turns", async () => {
    const userId = await insertUser();
    const nodeId = await insertNode(userId, "Proposal conflict node");
    const ordinaryClientMessageId = randomUUID();
    await createChatTurnForUser(userId, {
      nodeId,
      clientMessageId: ordinaryClientMessageId,
      content: "Ordinary chat",
      webSearchAuthorized: false,
    }, { claimAssistant: true });
    const ordinaryContext = await prepareChatContextForUser(userId, {
      nodeId,
      clientMessageId: ordinaryClientMessageId,
    });
    await recordChatTurnContextForUser(userId, {
      nodeId,
      clientMessageId: ordinaryClientMessageId,
      model: "gpt-5.6-sol",
      contextFingerprint: ordinaryContext.fingerprint,
    });
    await persistChatTurnContentPrefixForUser(userId, {
      nodeId,
      clientMessageId: ordinaryClientMessageId,
      contentPrefix: "Ordinary response.",
    });
    await expect(completeChatTurnForUser(userId, {
      nodeId,
      clientMessageId: ordinaryClientMessageId,
    }, {
      proposal: {
        baseVersionId: null,
        draft: { content: "Unauthorized proposal", citations: [] },
        model: "gpt-5.6-sol",
        reasoningMode: "pro",
        reasoningEffort: "high",
        inputFingerprint: ordinaryContext.fingerprint,
      },
    })).rejects.toEqual(new ChatServiceError("retry-unavailable"));
    expect(await getSynthesisWorkspaceForUser(userId, nodeId)).toEqual({
      published: null,
      staleAt: null,
      pending: null,
      history: [],
    });
  });

  it("allows only one pending proposal when requested turns complete concurrently", async () => {
    const userId = await insertUser();
    const nodeId = await insertNode(userId, "Concurrent proposal node");
    const turns = await Promise.all(["First", "Second"].map(async (label) => {
      const clientMessageId = randomUUID();
      await createChatTurnForUser(userId, {
        nodeId,
        clientMessageId,
        content: `${label} proposal request`,
        webSearchAuthorized: false,
        proposalRequested: true,
      }, { claimAssistant: true });
      const context = await prepareChatContextForUser(userId, { nodeId, clientMessageId });
      await recordChatTurnContextForUser(userId, {
        nodeId,
        clientMessageId,
        model: "gpt-5.6-sol",
        contextFingerprint: context.fingerprint,
      });
      await persistChatTurnContentPrefixForUser(userId, {
        nodeId,
        clientMessageId,
        contentPrefix: `${label} proposal response.`,
      });
      return { clientMessageId, context, label };
    }));

    const results = await Promise.allSettled(turns.map(({ clientMessageId, context, label }) =>
      completeChatTurnForUser(userId, { nodeId, clientMessageId }, {
        proposal: {
          baseVersionId: null,
          draft: { content: `${label} pending synthesis`, citations: [] },
          model: "gpt-5.6-sol",
          reasoningMode: "pro",
          reasoningEffort: "high",
          inputFingerprint: context.fingerprint,
        },
      })));

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const workspace = await getSynthesisWorkspaceForUser(userId, nodeId);
    expect(workspace.pending?.content).toMatch(/^(First|Second) pending synthesis$/);
    expect(workspace.published).toBeNull();

    const statuses = await pool.query<{ status: string }>(
      `select status
       from chat_messages
       where user_id = $1 and node_id = $2 and role = 'assistant'
       order by status`,
      [userId, nodeId],
    );
    expect(statuses.rows).toEqual([{ status: "completed" }, { status: "streaming" }]);
  });

  it("omits an oversized newest message from the bounded context snapshot", async () => {
    const userId = await insertUser();
    const nodeId = await insertNode(userId);
    const oversizedClientMessageId = randomUUID();
    const targetClientMessageId = randomUUID();
    await pool.query(
      `insert into chat_messages
        (user_id, node_id, client_message_id, sequence, role, status, content, completed_at)
       values
        ($1, $2, $3, 0, 'assistant', 'completed', $5, now()),
        ($1, $2, $4, 1, 'user', 'completed', 'Target request', now()),
        ($1, $2, $4, 2, 'assistant', 'streaming', '', null)`,
      [
        userId,
        nodeId,
        oversizedClientMessageId,
        targetClientMessageId,
        "x".repeat(MAX_CHAT_CONTEXT_CHARACTERS + 1),
      ],
    );

    const prepared = await prepareChatContextForUser(userId, {
      nodeId,
      clientMessageId: targetClientMessageId,
    });

    expect(prepared.snapshot.messages).toEqual([
      expect.objectContaining({ role: "user", content: "Target request" }),
    ]);
    expect(prepared.input).toHaveLength(2);
  });

  it("delimits stale outline discussion context while preserving the total provider budget", async () => {
    const userId = await insertUser();
    const nodeId = await insertNode(userId, "Bounded outline node");
    const outlineContent = "o".repeat(32_000);
    const outlineId = await installBranchOutline(
      userId,
      nodeId,
      outlineContent,
      true,
    );
    const clientMessageId = randomUUID();
    await createChatTurnForUser(userId, {
      nodeId,
      clientMessageId,
      content: "u".repeat(16_000),
      webSearchAuthorized: false,
    }, { claimAssistant: true });

    const prepared = await prepareChatContextForUser(userId, { nodeId, clientMessageId });

    expect(prepared.snapshot.node.branchOutline).toEqual({
      state: "stale",
      versionId: outlineId,
      content: outlineContent,
    });
    expect(prepared.outlineInput).toBeNull();
    expect(prepared.input[0]?.content).toContain('"branchOutline":{"state":"stale"');
    expect(prepared.input[0]?.content).toContain("[Context truncated]");
    expect(prepared.input.reduce((total, message) => total + message.content.length, 0))
      .toBeLessThanOrEqual(MAX_CHAT_CONTEXT_CHARACTERS);
    expect(prepared.input.at(-1)?.content).toHaveLength(16_000);
  });

  it("bounds a deep breadcrumb while accounting for omitted ancestors", async () => {
    const userId = await insertUser();
    const nodeIds: string[] = [];
    let parentId: string | null = null;
    for (let depth = 0; depth < 70; depth += 1) {
      parentId = await insertNode(userId, `Context depth ${depth}`, parentId);
      nodeIds.push(parentId);
    }
    const nodeId = nodeIds.at(-1)!;
    const clientMessageId = randomUUID();
    await createChatTurnForUser(userId, {
      nodeId,
      clientMessageId,
      content: "Use bounded ancestors",
      webSearchAuthorized: false,
    }, { claimAssistant: true });

    const prepared = await prepareChatContextForUser(userId, { nodeId, clientMessageId });

    expect(prepared.snapshot.node.breadcrumb.items).toHaveLength(64);
    expect(prepared.snapshot.node.breadcrumb.items[0]).toEqual({
      id: nodeIds[6],
      title: "Context depth 6",
    });
    expect(prepared.snapshot.node.breadcrumb.items.at(-1)).toEqual({
      id: nodeId,
      title: "Context depth 69",
    });
    expect(prepared.snapshot.node.breadcrumb.hasOmittedAncestors).toBe(true);
  });

  it("persists bounded streaming, completion, cancellation, and retry transitions", async () => {
    const userId = await insertUser();
    const nodeId = await insertNode(userId);
    const completedClientMessageId = randomUUID();
    await createChatTurnForUser(userId, {
      nodeId,
      clientMessageId: completedClientMessageId,
      content: "Complete this",
      webSearchAuthorized: false,
    });
    await startChatTurnForUser(userId, { nodeId, clientMessageId: completedClientMessageId });
    await expect(
      startChatTurnForUser(userId, { nodeId, clientMessageId: completedClientMessageId }),
    ).rejects.toEqual(new ChatServiceError("retry-unavailable"));
    await persistChatTurnContentPrefixForUser(userId, {
      nodeId,
      clientMessageId: completedClientMessageId,
      contentPrefix: "A partial ",
    });
    await persistChatTurnContentPrefixForUser(userId, {
      nodeId,
      clientMessageId: completedClientMessageId,
      contentPrefix: "A partial ",
    });
    await persistChatTurnContentPrefixForUser(userId, {
      nodeId,
      clientMessageId: completedClientMessageId,
      contentPrefix: "A partial answer.",
    });
    await expect(persistChatTurnContentPrefixForUser(userId, {
      nodeId,
      clientMessageId: completedClientMessageId,
      contentPrefix: "A divergent response.",
    })).rejects.toEqual(new ChatServiceError("retry-unavailable"));
    const afterDivergentPrefix = await getChatTurnForUser(userId, {
      nodeId,
      clientMessageId: completedClientMessageId,
    });
    expect(
      afterDivergentPrefix.find((message) => message.role === "assistant")?.content,
    ).toBe("A partial answer.");
    await persistChatTurnContentPrefixForUser(userId, {
      nodeId,
      clientMessageId: completedClientMessageId,
      contentPrefix: "A partial ",
    });
    const completed = await completeChatTurnForUser(userId, {
      nodeId,
      clientMessageId: completedClientMessageId,
    });
    expect(completed).toMatchObject({ status: "completed", content: "A partial answer." });
    expect(completed.completedAt).not.toBeNull();

    const cancelledClientMessageId = randomUUID();
    await createChatTurnForUser(userId, {
      nodeId,
      clientMessageId: cancelledClientMessageId,
      content: "Stop this",
      webSearchAuthorized: false,
    });
    await startChatTurnForUser(userId, { nodeId, clientMessageId: cancelledClientMessageId });
    const cancelled = await cancelChatTurnForUser(userId, {
      nodeId,
      clientMessageId: cancelledClientMessageId,
    });
    expect(cancelled).toMatchObject({ status: "cancelled", content: "" });
    const retriedCancelled = await retryChatTurnForUser(userId, {
      nodeId,
      clientMessageId: cancelledClientMessageId,
    });
    expect(retriedCancelled.assistantMessage).toMatchObject({ status: "pending" });

    const failedClientMessageId = randomUUID();
    await createChatTurnForUser(userId, {
      nodeId,
      clientMessageId: failedClientMessageId,
      content: "Retry this",
      webSearchAuthorized: false,
    });
    await startChatTurnForUser(userId, { nodeId, clientMessageId: failedClientMessageId });
    await failChatTurnForUser(userId, {
      nodeId,
      clientMessageId: failedClientMessageId,
      failureCode: "generation-failed",
    });
    const retried = await retryChatTurnForUser(userId, {
      nodeId,
      clientMessageId: failedClientMessageId,
    });
    expect(retried.assistantMessage).toMatchObject({ status: "pending", content: "", failureCode: null });
  });

  it("creates one replay-safe user and assistant row per client message", async () => {
    const userId = await insertUser();
    const nodeId = await insertNode(userId);
    const clientMessageId = randomUUID();
    const input = {
      nodeId,
      clientMessageId,
      content: "Develop the core idea.",
      webSearchAuthorized: true,
    };

    const created = await createChatTurnForUser(userId, input);
    const replayed = await createChatTurnForUser(userId, input);

    expect(created).toMatchObject({
      replayed: false,
      userMessage: {
        role: "user",
        status: "completed",
        content: input.content,
        webSearchAuthorized: true,
      },
      assistantMessage: {
        role: "assistant",
        status: "pending",
        content: "",
        webSearchAuthorized: false,
      },
    });
    expect(replayed).toMatchObject({
      replayed: true,
      userMessage: { id: created.userMessage.id },
      assistantMessage: { id: created.assistantMessage.id },
    });
    const stored = await pool.query<{ count: number }>(
      `select count(*)::int as count
       from chat_messages
       where user_id = $1 and node_id = $2 and client_message_id = $3`,
      [userId, nodeId, clientMessageId],
    );
    expect(stored.rows[0]?.count).toBe(2);

    await expect(
      createChatTurnForUser(userId, { ...input, content: "Different replay content" }),
    ).rejects.toEqual(new ChatServiceError("turn-conflict"));
  });

  it("persists and reloads validated external citation occurrences only for web turns", async () => {
    const userId = await insertUser();
    const nodeId = await insertNode(userId);
    const clientMessageId = randomUUID();
    await createChatTurnForUser(userId, {
      nodeId,
      clientMessageId,
      content: "Research a synthetic topic.",
      webSearchAuthorized: true,
    }, { claimAssistant: true });
    await recordChatTurnContextForUser(userId, {
      nodeId,
      clientMessageId,
      model: "gpt-5.6-sol",
      contextFingerprint: "a".repeat(64),
    });
    const content = "First claim. Second claim.";
    await persistChatTurnContentPrefixForUser(userId, {
      nodeId,
      clientMessageId,
      contentPrefix: content,
    });
    const completed = await completeChatTurnForUser(userId, {
      nodeId,
      clientMessageId,
    }, {
      externalCitations: [
        {
          kind: "external",
          ordinal: 1,
          startUtf16: "First claim.".length,
          endUtf16: "First claim.".length,
          title: "Synthetic source",
          url: "https://example.test/source",
        },
        {
          kind: "external",
          ordinal: 1,
          startUtf16: content.length,
          endUtf16: content.length,
          title: "Synthetic source",
          url: "https://example.test/source",
        },
      ],
    });

    expect(completed.citations).toHaveLength(2);
    const turn = await getChatTurnForUser(userId, { nodeId, clientMessageId });
    expect(turn.find(({ role }) => role === "assistant")?.citations).toEqual(
      completed.citations,
    );
    const page = await getChatMessagesForUser(userId, { nodeId });
    expect(page.messages.find(({ role }) => role === "assistant")?.citations).toEqual(
      completed.citations,
    );

    await expect(pool.query(
      `update citations set external_title = 'Tampered source'
       where assistant_message_id = $1`,
      [completed.id],
    )).rejects.toMatchObject({
      code: "23514",
      constraint: "citations_immutable_check",
    });
    await expect(pool.query(
      `delete from citations where assistant_message_id = $1`,
      [completed.id],
    )).rejects.toMatchObject({
      code: "23514",
      constraint: "citations_immutable_check",
    });

    const foreignUserId = await insertUser();
    await expect(pool.query(
      `insert into citations
         (user_id, owner_node_id, assistant_message_id, kind, ordinal,
          start_utf16, end_utf16, external_url, external_title)
       values ($1, $2, $3, 'external', 2, $4, $4,
               'https://example.test/foreign', 'Foreign source')`,
      [foreignUserId, nodeId, completed.id, content.length],
    )).rejects.toMatchObject({
      code: "23514",
      constraint: "citations_message_state_check",
    });
  });

  it("rejects completed web turns without citations and citations on no-web turns", async () => {
    for (const webSearchAuthorized of [true, false]) {
      const userId = await insertUser();
      const nodeId = await insertNode(userId);
      const clientMessageId = randomUUID();
      await createChatTurnForUser(userId, {
        nodeId,
        clientMessageId,
        content: "Synthetic request.",
        webSearchAuthorized,
      }, { claimAssistant: true });
      await recordChatTurnContextForUser(userId, {
        nodeId,
        clientMessageId,
        model: "gpt-5.6-sol",
        contextFingerprint: "b".repeat(64),
      });
      await persistChatTurnContentPrefixForUser(userId, {
        nodeId,
        clientMessageId,
        contentPrefix: "Synthetic response.",
      });

      await expect(completeChatTurnForUser(userId, { nodeId, clientMessageId }, {
        externalCitations: webSearchAuthorized
          ? []
          : [{
              kind: "external",
              ordinal: 1,
              startUtf16: 19,
              endUtf16: 19,
              title: "Synthetic source",
              url: "https://example.test/source",
            }],
      })).rejects.toEqual(new ChatServiceError("retry-unavailable"));
    }
  });

  it.each([
    [
      "one ordinal mapped to different sources",
      [
        { ordinal: 1, title: "Source one", url: "https://one.example.test/" },
        { ordinal: 1, title: "Source two", url: "https://two.example.test/" },
      ],
    ],
    [
      "one source split across ordinals",
      [
        { ordinal: 1, title: "Source", url: "https://example.test/source" },
        { ordinal: 2, title: "Source", url: "https://example.test/source" },
      ],
    ],
    [
      "a non-contiguous first ordinal",
      [{ ordinal: 2, title: "Source", url: "https://example.test/source" }],
    ],
  ])("rejects %s without partially completing the web turn", async (_label, sources) => {
    const userId = await insertUser();
    const nodeId = await insertNode(userId);
    const clientMessageId = randomUUID();
    await createChatTurnForUser(userId, {
      nodeId,
      clientMessageId,
      content: "Research malformed citation provenance.",
      webSearchAuthorized: true,
    }, { claimAssistant: true });
    await recordChatTurnContextForUser(userId, {
      nodeId,
      clientMessageId,
      model: "gpt-5.6-sol",
      contextFingerprint: "9".repeat(64),
    });
    const content = "First claim. Second claim.";
    await persistChatTurnContentPrefixForUser(userId, {
      nodeId,
      clientMessageId,
      contentPrefix: content,
    });
    const externalCitations = sources.map((source, index) => ({
      kind: "external" as const,
      ordinal: source.ordinal,
      startUtf16: index === 0 ? "First claim.".length : content.length,
      endUtf16: index === 0 ? "First claim.".length : content.length,
      title: source.title,
      url: source.url,
    }));

    await expect(completeChatTurnForUser(userId, { nodeId, clientMessageId }, {
      externalCitations,
    })).rejects.toEqual(new ChatServiceError("retry-unavailable"));
    const stored = await pool.query<{
      citation_count: number;
      status: string;
    }>(
      `select m.status, count(c.id)::int as citation_count
       from chat_messages m
       left join citations c on c.assistant_message_id = m.id
       where m.user_id = $1 and m.node_id = $2 and m.client_message_id = $3
         and m.role = 'assistant'
       group by m.id`,
      [userId, nodeId, clientMessageId],
    );
    expect(stored.rows).toEqual([{ status: "streaming", citation_count: 0 }]);
  });

  it("does not distinguish foreign nodes from missing nodes", async () => {
    const userId = await insertUser();
    const otherUserId = await insertUser();
    const foreignNodeId = await insertNode(otherUserId, "Foreign chat node");
    const missingNodeId = randomUUID();
    const clientMessageId = randomUUID();

    await expect(
      createChatTurnForUser(userId, {
        nodeId: foreignNodeId,
        clientMessageId,
        content: "Private?",
        webSearchAuthorized: false,
      }),
    ).rejects.toEqual(new ChatServiceError("node-not-found"));
    await expect(
      createChatTurnForUser(userId, {
        nodeId: missingNodeId,
        clientMessageId,
        content: "Missing?",
        webSearchAuthorized: false,
      }),
    ).rejects.toEqual(new ChatServiceError("node-not-found"));
    await expect(getChatMessagesForUser(userId, { nodeId: foreignNodeId })).rejects.toEqual(
      new ChatServiceError("node-not-found"),
    );
    await expect(getChatMessagesForUser(userId, { nodeId: missingNodeId })).rejects.toEqual(
      new ChatServiceError("node-not-found"),
    );
    await expect(
      getChatTurnForUser(userId, { nodeId: foreignNodeId, clientMessageId }),
    ).rejects.toEqual(new ChatServiceError("node-not-found"));
    await expect(
      getChatTurnForUser(userId, { nodeId: missingNodeId, clientMessageId }),
    ).rejects.toEqual(new ChatServiceError("node-not-found"));
  });

  it("paginates one node in stable order without mixing another conversation", async () => {
    const userId = await insertUser();
    const nodeId = await insertNode(userId, "Paginated chat");
    const otherNodeId = await insertNode(userId, "Other chat");
    for (const content of ["First", "Second", "Third"]) {
      await createChatTurnForUser(userId, {
        nodeId,
        clientMessageId: randomUUID(),
        content,
        webSearchAuthorized: false,
      });
    }
    await pool.query(
      `update chat_messages set created_at = '2026-08-04T00:00:00.000Z'
       where user_id = $1 and node_id = $2`,
      [userId, nodeId],
    );
    await createChatTurnForUser(userId, {
      nodeId: otherNodeId,
      clientMessageId: randomUUID(),
      content: "Other node message",
      webSearchAuthorized: false,
    });

    const firstPage = await getChatMessagesForUser(userId, { nodeId, limit: 2 });
    const secondPage = await getChatMessagesForUser(userId, {
      nodeId,
      limit: 2,
      cursor: firstPage.nextCursor ?? undefined,
    });
    const thirdPage = await getChatMessagesForUser(userId, {
      nodeId,
      limit: 2,
      cursor: secondPage.nextCursor ?? undefined,
    });
    const messages = [
      ...thirdPage.messages,
      ...secondPage.messages,
      ...firstPage.messages,
    ];

    expect(firstPage.nextCursor).not.toBeNull();
    expect(secondPage.nextCursor).not.toBeNull();
    expect(thirdPage.nextCursor).toBeNull();
    expect(new Set(messages.map(({ id }) => id)).size).toBe(6);
    expect(messages.filter(({ role }) => role === "user").map(({ content }) => content)).toEqual([
      "First",
      "Second",
      "Third",
    ]);
    expect(messages.every((message) => message.nodeId === nodeId)).toBe(true);
    await expect(
      getChatMessagesForUser(userId, { nodeId, cursor: "not-a-cursor" }),
    ).rejects.toEqual(new ChatServiceError("invalid-cursor"));
    const validCursor = firstPage.nextCursor;
    expect(validCursor).not.toBeNull();
    await expect(
      getChatMessagesForUser(userId, { nodeId, cursor: `${validCursor}$` }),
    ).rejects.toEqual(new ChatServiceError("invalid-cursor"));
    await expect(
      getChatMessagesForUser(userId, { nodeId, cursor: `${validCursor}===` }),
    ).rejects.toEqual(new ChatServiceError("invalid-cursor"));
    const malformedSequenceCursor = Buffer.from(
      JSON.stringify({ sequence: -1 }),
      "utf8",
    ).toString("base64url");
    await expect(
      getChatMessagesForUser(userId, { nodeId, cursor: malformedSequenceCursor }),
    ).rejects.toEqual(new ChatServiceError("invalid-cursor"));
    const outOfRangeSequenceCursor = Buffer.from(
      JSON.stringify({ sequence: "9223372036854775808" }),
      "utf8",
    ).toString("base64url");
    await expect(
      getChatMessagesForUser(userId, { nodeId, cursor: outOfRangeSequenceCursor }),
    ).rejects.toEqual(new ChatServiceError("invalid-cursor"));
    await expect(
      getChatMessagesForUser(userId, { nodeId, cursor: "x".repeat(129) }),
    ).rejects.toEqual(new ChatServiceError("invalid-cursor"));
  });

  it("allocates adjacent per-node sequence values across concurrent turns", async () => {
    const userId = await insertUser();
    const nodeId = await insertNode(userId, "Concurrent chat");

    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        createChatTurnForUser(userId, {
          nodeId,
          clientMessageId: randomUUID(),
          content: `Concurrent ${index}`,
          webSearchAuthorized: false,
        }),
      ),
    );

    const stored = await pool.query<{
      client_message_id: string;
      role: "assistant" | "user";
      sequence: string;
    }>(
      `select client_message_id, role, sequence::text
       from chat_messages
       where user_id = $1 and node_id = $2
       order by chat_messages.sequence`,
      [userId, nodeId],
    );
    expect(stored.rows.map(({ sequence }) => Number(sequence))).toEqual(
      Array.from({ length: 16 }, (_, index) => index),
    );
    for (let index = 0; index < stored.rows.length; index += 2) {
      expect(stored.rows[index]?.role).toBe("user");
      expect(stored.rows[index + 1]?.role).toBe("assistant");
      expect(stored.rows[index]?.client_message_id).toBe(
        stored.rows[index + 1]?.client_message_id,
      );
    }
  });

  it("preserves pagination and allocation above the safe integer range", async () => {
    const userId = await insertUser();
    const nodeId = await insertNode(userId, "High sequence chat");
    const existingClientMessageId = randomUUID();
    const createdAt = new Date();
    await pool.query(
      `insert into chat_messages
         (user_id, node_id, client_message_id, sequence, role, status, content,
          web_search_authorized, created_at, updated_at, completed_at)
       values
         ($1, $2, $3, $4, 'user', 'completed', 'High user message', false, $6, $6, $6),
         ($1, $2, $3, $5, 'assistant', 'completed', 'High assistant message', false, $6, $6, $6)`,
      [
        userId,
        nodeId,
        existingClientMessageId,
        "9007199254740992",
        "9007199254740993",
        createdAt,
      ],
    );

    const firstPage = await getChatMessagesForUser(userId, { nodeId, limit: 1 });
    expect(firstPage.messages).toMatchObject([
      { role: "assistant", content: "High assistant message" },
    ]);
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = await getChatMessagesForUser(userId, {
      nodeId,
      limit: 1,
      cursor: firstPage.nextCursor ?? undefined,
    });
    expect(secondPage.messages).toMatchObject([
      { role: "user", content: "High user message" },
    ]);

    const nextClientMessageId = randomUUID();
    await createChatTurnForUser(userId, {
      nodeId,
      clientMessageId: nextClientMessageId,
      content: "Continue exactly",
      webSearchAuthorized: false,
    });
    const stored = await pool.query<{ sequence: string }>(
      `select sequence::text
       from chat_messages
       where user_id = $1 and node_id = $2 and client_message_id = $3
       order by sequence`,
      [userId, nodeId, nextClientMessageId],
    );
    expect(stored.rows.map(({ sequence }) => sequence)).toEqual([
      "9007199254740994",
      "9007199254740995",
    ]);
  });

  it("retries a failed assistant placeholder without duplicating the user turn", async () => {
    const userId = await insertUser();
    const nodeId = await insertNode(userId);
    const clientMessageId = randomUUID();
    const created = await createChatTurnForUser(userId, {
      nodeId,
      clientMessageId,
      content: "Please try this once.",
      webSearchAuthorized: false,
    });

    const failed = await failChatTurnForUser(userId, {
      nodeId,
      clientMessageId,
      failureCode: "provider-timeout",
    });
    expect(failed).toMatchObject({
      id: created.assistantMessage.id,
      status: "failed",
      failureCode: "provider-timeout",
    });

    const retried = await retryChatTurnForUser(userId, { nodeId, clientMessageId });
    expect(retried).toMatchObject({
      userMessage: { id: created.userMessage.id, content: "Please try this once." },
      assistantMessage: {
        id: created.assistantMessage.id,
        status: "pending",
        content: "",
        failureCode: null,
      },
    });
    await expect(retryChatTurnForUser(userId, { nodeId, clientMessageId })).rejects.toEqual(
      new ChatServiceError("retry-unavailable"),
    );
    await expect(
      failChatTurnForUser(userId, {
        nodeId,
        clientMessageId,
        failureCode: "provider-request-id",
      } as unknown as FailChatTurnInput),
    ).rejects.toEqual(new ChatServiceError("invalid-failure-code"));
    const stored = await pool.query<{ count: number }>(
      `select count(*)::int as count
       from chat_messages
       where user_id = $1 and node_id = $2 and client_message_id = $3`,
      [userId, nodeId, clientMessageId],
    );
    expect(stored.rows[0]?.count).toBe(2);
  });

  it("cascades every conversation row with confirmed subtree deletion", async () => {
    const userId = await insertUser();
    const rootId = await insertNode(userId, "Doomed root");
    const childId = await insertNode(userId, "Doomed child", rootId);
    for (const nodeId of [rootId, childId]) {
      await createChatTurnForUser(userId, {
        nodeId,
        clientMessageId: randomUUID(),
        content: `Message for ${nodeId}`,
        webSearchAuthorized: false,
      });
    }

    await deleteNodeForUser(userId, { id: rootId });

    const remaining = await pool.query<{ count: number }>(
      `select count(*)::int as count from chat_messages where user_id = $1`,
      [userId],
    );
    expect(remaining.rows[0]?.count).toBe(0);
  });
});
