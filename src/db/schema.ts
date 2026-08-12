import { sql } from "drizzle-orm";
import {
  boolean,
  bigint,
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
  vector,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).defaultNow().notNull();

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique("user_email_unique"),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique("session_token_unique"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("session_user_id_idx").on(table.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("account_user_id_idx").on(table.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const nodes = pgTable(
  "nodes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id"),
    position: integer("position").notNull(),
    title: varchar("title", { length: 200 }).notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    // The reviewed migration owns the deferred composite FK to synthesisVersions.
    // Keeping that circular edge out of this initializer preserves exact table types.
    publishedSynthesisVersionId: uuid("published_synthesis_version_id"),
    synthesisStaleAt: timestamp("synthesis_stale_at", { withTimezone: true }),
    // The reviewed migration owns the deferred composite FK to branchOutlineVersions.
    currentBranchOutlineVersionId: uuid("current_branch_outline_version_id"),
    branchOutlineStaleAt: timestamp("branch_outline_stale_at", { withTimezone: true }),
    branchOutlineStaleReason: varchar("branch_outline_stale_reason", {
      length: 32,
      enum: [
        "summary-changed",
        "branch-structure-changed",
        "branch-content-changed",
        "branch-availability-changed",
        "node-renamed",
      ],
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("nodes_user_id_id_unique").on(table.userId, table.id),
    unique("nodes_user_id_id_published_unique").on(
      table.userId,
      table.id,
      table.publishedSynthesisVersionId,
    ),
    unique("nodes_sibling_position_unique")
      .on(table.userId, table.parentId, table.position)
      .nullsNotDistinct(),
    foreignKey({
      name: "nodes_parent_owner_fk",
      columns: [table.userId, table.parentId],
      foreignColumns: [table.userId, table.id],
    }).onDelete("cascade"),
    check(
      "nodes_not_own_parent_check",
      sql`${table.parentId} is null or ${table.parentId} <> ${table.id}`,
    ),
    check("nodes_position_non_negative_check", sql`${table.position} >= 0`),
    check(
      "nodes_title_trimmed_length_check",
      sql`${table.title} !~ '^[[:space:]]|[[:space:]]$' and char_length(${table.title}) between 1 and 200`,
    ),
    check(
      "nodes_branch_outline_stale_state_check",
      sql`(
        ${table.currentBranchOutlineVersionId} is null
        and ${table.branchOutlineStaleAt} is null
        and ${table.branchOutlineStaleReason} is null
      ) or (
        ${table.currentBranchOutlineVersionId} is not null
        and (
          (${table.branchOutlineStaleAt} is null and ${table.branchOutlineStaleReason} is null)
          or
          (${table.branchOutlineStaleAt} is not null and ${table.branchOutlineStaleReason} is not null)
        )
      )`,
    ),
    check(
      "nodes_branch_outline_stale_reason_check",
      sql`${table.branchOutlineStaleReason} is null or ${table.branchOutlineStaleReason} in (
        'summary-changed',
        'branch-structure-changed',
        'branch-content-changed',
        'branch-availability-changed',
        'node-renamed'
      )`,
    ),
  ],
);

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    nodeId: uuid("node_id").notNull(),
    clientMessageId: uuid("client_message_id").notNull(),
    sequence: bigint("sequence", { mode: "bigint" }).notNull(),
    role: varchar("role", { length: 16, enum: ["user", "assistant"] }).notNull(),
    status: varchar("status", {
      length: 16,
      enum: ["pending", "streaming", "completed", "failed", "cancelled"],
    }).notNull(),
    content: text("content").default("").notNull(),
    model: varchar("model", { length: 100 }),
    providerResponseId: varchar("provider_response_id", { length: 255 }),
    contextFingerprint: varchar("context_fingerprint", { length: 64 }),
    failureCode: varchar("failure_code", { length: 64 }),
    webSearchAuthorized: boolean("web_search_authorized").default(false).notNull(),
    proposalRequested: boolean("proposal_requested").default(false).notNull(),
    // The reviewed migration owns the circular owner-scoped FK to synthesisVersions.
    refinementProposalId: uuid("refinement_proposal_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    unique("chat_messages_turn_role_unique").on(
      table.userId,
      table.nodeId,
      table.clientMessageId,
      table.role,
    ),
    foreignKey({
      name: "chat_messages_node_owner_fk",
      columns: [table.userId, table.nodeId],
      foreignColumns: [nodes.userId, nodes.id],
    }).onDelete("cascade"),
    unique("chat_messages_node_sequence_unique").on(
      table.userId,
      table.nodeId,
      table.sequence,
    ),
    unique("chat_messages_user_node_id_unique").on(
      table.userId,
      table.nodeId,
      table.id,
    ),
    check("chat_messages_role_check", sql`${table.role} in ('user', 'assistant')`),
    check(
      "chat_messages_status_check",
      sql`${table.status} in ('pending', 'streaming', 'completed', 'failed', 'cancelled')`,
    ),
    check(
      "chat_messages_role_state_check",
      sql`(
        ${table.role} = 'user'
        and ${table.status} = 'completed'
        and ${table.completedAt} is not null
        and ${table.model} is null
        and ${table.providerResponseId} is null
        and ${table.contextFingerprint} is null
        and ${table.failureCode} is null
        and (${table.proposalRequested} = true or ${table.refinementProposalId} is null)
      ) or (
        ${table.role} = 'assistant'
        and ${table.webSearchAuthorized} = false
        and ${table.proposalRequested} = false
        and ${table.refinementProposalId} is null
      )`,
    ),
    check(
      "chat_messages_completion_check",
      sql`(
        ${table.status} = 'completed'
        and ${table.completedAt} is not null
        and ${table.failureCode} is null
      ) or (
        ${table.status} = 'failed'
        and ${table.completedAt} is null
        and ${table.failureCode} is not null
      ) or (
        ${table.status} in ('pending', 'streaming', 'cancelled')
        and ${table.completedAt} is null
        and ${table.failureCode} is null
      )`,
    ),
    check(
      "chat_messages_context_fingerprint_check",
      sql`${table.contextFingerprint} is null or ${table.contextFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "chat_messages_failure_code_check",
      sql`${table.failureCode} is null or ${table.failureCode} in (
        'assistant-unavailable',
        'generation-failed',
        'provider-refusal',
        'provider-timeout',
        'response-invalid',
        'stream-disconnected'
      )`,
    ),
    check(
      "chat_messages_content_length_check",
      sql`(
        ${table.role} = 'user'
        and char_length(${table.content}) between 1 and 16000
        and btrim(${table.content}) <> ''
      ) or (
        ${table.role} = 'assistant'
        and char_length(${table.content}) <= 64000
        and (${table.status} <> 'completed' or char_length(${table.content}) >= 1)
      )`,
    ),
  ],
);

export const synthesisVersions = pgTable(
  "synthesis_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    nodeId: uuid("node_id").notNull(),
    baseVersionId: uuid("base_version_id"),
    status: varchar("status", {
      length: 16,
      enum: ["pending", "approved", "rejected", "superseded"],
    }).notNull(),
    content: text("content").notNull(),
    model: varchar("model", { length: 100 }).notNull(),
    reasoningMode: varchar("reasoning_mode", { length: 16 }).notNull(),
    reasoningEffort: varchar("reasoning_effort", { length: 16 }).notNull(),
    inputFingerprint: varchar("input_fingerprint", { length: 64 }).notNull(),
    generatingMessageId: uuid("generating_message_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (table) => [
    unique("synthesis_versions_user_node_id_unique").on(
      table.userId,
      table.nodeId,
      table.id,
    ),
    unique("synthesis_versions_generating_message_unique").on(
      table.generatingMessageId,
    ),
    uniqueIndex("synthesis_versions_one_pending_per_node")
      .on(table.userId, table.nodeId)
      .where(sql`${table.status} = 'pending'`),
    foreignKey({
      name: "synthesis_versions_node_owner_fk",
      columns: [table.userId, table.nodeId],
      foreignColumns: [nodes.userId, nodes.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "synthesis_versions_base_owner_fk",
      columns: [table.userId, table.nodeId, table.baseVersionId],
      foreignColumns: [table.userId, table.nodeId, table.id],
    }),
    foreignKey({
      name: "synthesis_versions_message_owner_fk",
      columns: [table.userId, table.nodeId, table.generatingMessageId],
      foreignColumns: [
        chatMessages.userId,
        chatMessages.nodeId,
        chatMessages.id,
      ],
    }),
    check(
      "synthesis_versions_status_check",
      sql`${table.status} in ('pending', 'approved', 'rejected', 'superseded')`,
    ),
    check(
      "synthesis_versions_decision_state_check",
      sql`(
        ${table.status} = 'pending' and ${table.decidedAt} is null
      ) or (
        ${table.status} in ('approved', 'rejected', 'superseded')
        and ${table.decidedAt} is not null
      )`,
    ),
    check(
      "synthesis_versions_content_length_check",
      sql`char_length(${table.content}) between 1 and 32000 and btrim(${table.content}) <> ''`,
    ),
    check(
      "synthesis_versions_profile_check",
      sql`${table.reasoningMode} = 'pro' and ${table.reasoningEffort} = 'high'`,
    ),
    check(
      "synthesis_versions_input_fingerprint_check",
      sql`${table.inputFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

// The reviewed migration owns the nullable live-target FK and citation lifecycle
// triggers because PostgreSQL must preserve immutable snapshots while clearing
// both live target columns during explicit node deletion.
export const citations = pgTable(
  "citations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    ownerNodeId: uuid("owner_node_id").notNull(),
    assistantMessageId: uuid("assistant_message_id"),
    synthesisVersionId: uuid("synthesis_version_id"),
    kind: varchar("kind", { length: 16, enum: ["internal", "external"] }).notNull(),
    ordinal: integer("ordinal").notNull(),
    startUtf16: integer("start_utf16").notNull(),
    endUtf16: integer("end_utf16").notNull(),
    liveTargetNodeId: uuid("live_target_node_id"),
    liveTargetSynthesisVersionId: uuid("live_target_synthesis_version_id"),
    targetNodeIdSnapshot: uuid("target_node_id_snapshot"),
    targetTitleSnapshot: varchar("target_title_snapshot", { length: 200 }),
    targetParentIdSnapshot: uuid("target_parent_id_snapshot"),
    targetSynthesisVersionIdSnapshot: uuid("target_synthesis_version_id_snapshot"),
    targetDeletedAt: timestamp("target_deleted_at", { withTimezone: true }),
    externalUrl: text("external_url"),
    externalTitle: varchar("external_title", { length: 500 }),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "citations_synthesis_owner_fk",
      columns: [table.userId, table.ownerNodeId, table.synthesisVersionId],
      foreignColumns: [
        synthesisVersions.userId,
        synthesisVersions.nodeId,
        synthesisVersions.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "citations_message_owner_fk",
      columns: [table.userId, table.ownerNodeId, table.assistantMessageId],
      foreignColumns: [chatMessages.userId, chatMessages.nodeId, chatMessages.id],
    }).onDelete("cascade"),
    uniqueIndex("citations_synthesis_internal_ordinal_unique")
      .on(table.synthesisVersionId, table.ordinal)
      .where(sql`${table.synthesisVersionId} is not null and ${table.kind} = 'internal'`),
    uniqueIndex("citations_synthesis_external_occurrence_unique")
      .on(table.synthesisVersionId, table.ordinal, table.startUtf16, table.endUtf16)
      .where(sql`${table.synthesisVersionId} is not null and ${table.kind} = 'external'`),
    uniqueIndex("citations_message_external_occurrence_unique")
      .on(table.assistantMessageId, table.ordinal, table.startUtf16, table.endUtf16)
      .where(sql`${table.assistantMessageId} is not null and ${table.kind} = 'external'`),
    index("citations_live_target_idx").on(table.userId, table.liveTargetNodeId),
    check(
      "citations_owner_check",
      sql`num_nonnulls(${table.assistantMessageId}, ${table.synthesisVersionId}) = 1`,
    ),
    check(
      "citations_kind_check",
      sql`${table.kind} in ('internal', 'external')`,
    ),
    check(
      "citations_ordinal_check",
      sql`${table.ordinal} between 1 and 32`,
    ),
    check(
      "citations_location_check",
      sql`(
        ${table.kind} = 'internal'
        and ${table.startUtf16} >= 0
        and ${table.endUtf16} > ${table.startUtf16}
        and ${table.endUtf16} <= 64000
      ) or (
        ${table.kind} = 'external'
        and ${table.startUtf16} >= 0
        and ${table.endUtf16} = ${table.startUtf16}
        and ${table.endUtf16} <= 64000
      )`,
    ),
    check(
      "citations_kind_fields_check",
      sql`(
        ${table.kind} = 'internal'
        and ${table.assistantMessageId} is null
        and ${table.synthesisVersionId} is not null
        and ${table.targetNodeIdSnapshot} is not null
        and ${table.targetTitleSnapshot} is not null
        and ${table.targetSynthesisVersionIdSnapshot} is not null
        and ${table.externalUrl} is null
        and ${table.externalTitle} is null
        and (
          (${table.liveTargetNodeId} is not null
            and ${table.liveTargetSynthesisVersionId} is not null
            and ${table.targetDeletedAt} is null)
          or
          (${table.liveTargetNodeId} is null
            and ${table.liveTargetSynthesisVersionId} is null
            and ${table.targetDeletedAt} is not null)
        )
      ) or (
        ${table.kind} = 'external'
        and ${table.liveTargetNodeId} is null
        and ${table.liveTargetSynthesisVersionId} is null
        and ${table.targetNodeIdSnapshot} is null
        and ${table.targetTitleSnapshot} is null
        and ${table.targetParentIdSnapshot} is null
        and ${table.targetSynthesisVersionIdSnapshot} is null
        and ${table.targetDeletedAt} is null
        and ${table.externalUrl} is not null
        and ${table.externalTitle} is not null
      )`,
    ),
    check(
      "citations_external_bounds_check",
      sql`${table.kind} <> 'external' or (
        char_length(${table.externalUrl}) between 1 and 2048
        and ${table.externalUrl} ~ '^https?://'
        and char_length(${table.externalTitle}) between 1 and 500
        and btrim(${table.externalTitle}) <> ''
      )`,
    ),
  ],
);

export const branchOutlineVersions = pgTable(
  "branch_outline_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    nodeId: uuid("node_id").notNull(),
    clientRequestId: uuid("client_request_id").notNull(),
    baseSynthesisVersionId: uuid("base_synthesis_version_id"),
    status: varchar("status", {
      length: 16,
      enum: ["pending", "completed", "failed"],
    }).notNull(),
    content: text("content").default("").notNull(),
    model: varchar("model", { length: 100 }).notNull(),
    reasoningMode: varchar("reasoning_mode", { length: 16 }).notNull(),
    reasoningEffort: varchar("reasoning_effort", { length: 16 }).notNull(),
    inputFingerprint: varchar("input_fingerprint", { length: 64 }).notNull(),
    providerResponseId: varchar("provider_response_id", { length: 255 }),
    failureCode: varchar("failure_code", {
      length: 32,
      enum: [
        "generation-failed",
        "provider-refusal",
        "provider-timeout",
        "response-invalid",
        "stream-disconnected",
        "inputs-changed",
      ],
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    unique("branch_outline_versions_user_node_id_unique").on(
      table.userId,
      table.nodeId,
      table.id,
    ),
    unique("branch_outline_versions_request_unique").on(
      table.userId,
      table.nodeId,
      table.clientRequestId,
    ),
    uniqueIndex("branch_outline_versions_one_pending_per_node")
      .on(table.userId, table.nodeId)
      .where(sql`${table.status} = 'pending'`),
    foreignKey({
      name: "branch_outline_versions_node_owner_fk",
      columns: [table.userId, table.nodeId],
      foreignColumns: [nodes.userId, nodes.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "branch_outline_versions_base_owner_fk",
      columns: [table.userId, table.nodeId, table.baseSynthesisVersionId],
      foreignColumns: [
        synthesisVersions.userId,
        synthesisVersions.nodeId,
        synthesisVersions.id,
      ],
    }),
    check(
      "branch_outline_versions_status_check",
      sql`${table.status} in ('pending', 'completed', 'failed')`,
    ),
    check(
      "branch_outline_versions_lifecycle_check",
      sql`(
        ${table.status} = 'pending'
        and ${table.content} = ''
        and ${table.failureCode} is null
        and ${table.completedAt} is null
      ) or (
        ${table.status} = 'completed'
        and char_length(${table.content}) between 1 and 32000
        and btrim(${table.content}) <> ''
        and ${table.failureCode} is null
        and ${table.completedAt} is not null
      ) or (
        ${table.status} = 'failed'
        and ${table.content} = ''
        and ${table.failureCode} is not null
        and ${table.completedAt} is null
      )`,
    ),
    check(
      "branch_outline_versions_profile_check",
      sql`${table.reasoningMode} = 'pro' and ${table.reasoningEffort} = 'high'`,
    ),
    check(
      "branch_outline_versions_input_fingerprint_check",
      sql`${table.inputFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "branch_outline_versions_failure_code_check",
      sql`${table.failureCode} is null or ${table.failureCode} in (
        'generation-failed',
        'provider-refusal',
        'provider-timeout',
        'response-invalid',
        'stream-disconnected',
        'inputs-changed'
      )`,
    ),
  ],
);

export const branchOutlineInputs = pgTable(
  "branch_outline_inputs",
  {
    outlineVersionId: uuid("outline_version_id").notNull(),
    userId: text("user_id").notNull(),
    nodeId: uuid("node_id").notNull(),
    sourceNodeId: uuid("source_node_id").notNull(),
    sourceSynthesisVersionId: uuid("source_synthesis_version_id"),
    sourceBranchOutlineVersionId: uuid("source_branch_outline_version_id"),
    summaryState: varchar("summary_state", {
      length: 16,
      enum: ["none", "published"],
    }).notNull(),
    outlineState: varchar("outline_state", {
      length: 16,
      enum: ["none", "current", "stale"],
    }).notNull(),
    sourceStateFingerprint: varchar("source_state_fingerprint", { length: 64 }).notNull(),
    position: integer("position").notNull(),
  },
  (table) => [
    primaryKey({
      name: "branch_outline_inputs_pkey",
      columns: [table.outlineVersionId, table.position],
    }),
    unique("branch_outline_inputs_source_unique").on(
      table.outlineVersionId,
      table.sourceNodeId,
    ),
    foreignKey({
      name: "branch_outline_inputs_version_owner_fk",
      columns: [table.userId, table.nodeId, table.outlineVersionId],
      foreignColumns: [
        branchOutlineVersions.userId,
        branchOutlineVersions.nodeId,
        branchOutlineVersions.id,
      ],
    }).onDelete("cascade"),
    check(
      "branch_outline_inputs_summary_state_check",
      sql`(
        ${table.summaryState} = 'none' and ${table.sourceSynthesisVersionId} is null
      ) or (
        ${table.summaryState} = 'published' and ${table.sourceSynthesisVersionId} is not null
      )`,
    ),
    check(
      "branch_outline_inputs_outline_state_check",
      sql`(
        ${table.outlineState} = 'none' and ${table.sourceBranchOutlineVersionId} is null
      ) or (
        ${table.outlineState} in ('current', 'stale')
        and ${table.sourceBranchOutlineVersionId} is not null
      )`,
    ),
    check(
      "branch_outline_inputs_fingerprint_check",
      sql`${table.sourceStateFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    check("branch_outline_inputs_position_check", sql`${table.position} >= 0`),
  ],
);

// The reviewed migration seals these input rows to their parent-version lifecycle.
export const synthesisInputs = pgTable(
  "synthesis_inputs",
  {
    synthesisVersionId: uuid("synthesis_version_id").notNull(),
    userId: text("user_id").notNull(),
    nodeId: uuid("node_id").notNull(),
    relation: varchar("relation", {
      length: 16,
      enum: ["outline", "related"],
    }).notNull(),
    sourceNodeId: uuid("source_node_id").notNull(),
    sourceSynthesisVersionId: uuid("source_synthesis_version_id"),
    sourceBranchOutlineVersionId: uuid("source_branch_outline_version_id"),
    sourceStateFingerprint: varchar("source_state_fingerprint", { length: 64 }).notNull(),
    position: integer("position").notNull(),
  },
  (table) => [
    primaryKey({
      name: "synthesis_inputs_pkey",
      columns: [table.synthesisVersionId, table.relation, table.position],
    }),
    unique("synthesis_inputs_source_unique").on(
      table.synthesisVersionId,
      table.relation,
      table.sourceNodeId,
    ),
    foreignKey({
      name: "synthesis_inputs_version_owner_fk",
      columns: [table.userId, table.nodeId, table.synthesisVersionId],
      foreignColumns: [
        synthesisVersions.userId,
        synthesisVersions.nodeId,
        synthesisVersions.id,
      ],
    }).onDelete("cascade"),
    check(
      "synthesis_inputs_relation_state_check",
      sql`(
        ${table.relation} = 'outline'
        and ${table.sourceNodeId} = ${table.nodeId}
        and ${table.sourceSynthesisVersionId} is null
        and ${table.sourceBranchOutlineVersionId} is not null
        and ${table.position} = 0
      ) or (
        ${table.relation} = 'related'
        and ${table.sourceSynthesisVersionId} is not null
        and ${table.sourceBranchOutlineVersionId} is null
      )`,
    ),
    check(
      "synthesis_inputs_fingerprint_check",
      sql`${table.sourceStateFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    check("synthesis_inputs_position_check", sql`${table.position} >= 0`),
  ],
);

export const nodeEmbeddings = pgTable(
  "node_embeddings",
  {
    userId: text("user_id").notNull(),
    nodeId: uuid("node_id").notNull(),
    sourceSynthesisVersionId: uuid("source_synthesis_version_id").notNull(),
    model: varchar("model", { length: 100 }).notNull(),
    dimensions: integer("dimensions").notNull(),
    embedding: vector("embedding", {
      dimensions: 3_072,
    }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({
      name: "node_embeddings_pkey",
      columns: [table.userId, table.nodeId],
    }),
    foreignKey({
      name: "node_embeddings_node_owner_fk",
      columns: [table.userId, table.nodeId],
      foreignColumns: [nodes.userId, nodes.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "node_embeddings_source_owner_fk",
      columns: [table.userId, table.nodeId, table.sourceSynthesisVersionId],
      foreignColumns: [
        synthesisVersions.userId,
        synthesisVersions.nodeId,
        synthesisVersions.id,
      ],
    }),
    foreignKey({
      name: "node_embeddings_current_owner_fk",
      columns: [table.userId, table.nodeId, table.sourceSynthesisVersionId],
      foreignColumns: [
        nodes.userId,
        nodes.id,
        nodes.publishedSynthesisVersionId,
      ],
    }).onDelete("cascade"),
    check(
      "node_embeddings_profile_check",
      sql`${table.model} = 'text-embedding-3-large' and ${table.dimensions} = 3072`,
    ),
  ],
);

export const authSchema = {
  user,
  session,
  account,
  verification,
};

export const schema = {
  ...authSchema,
  nodes,
  chatMessages,
  synthesisVersions,
  citations,
  synthesisInputs,
  nodeEmbeddings,
  branchOutlineVersions,
  branchOutlineInputs,
};
