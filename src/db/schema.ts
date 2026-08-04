import { sql } from "drizzle-orm";
import {
  boolean,
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
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
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("nodes_user_id_id_unique").on(table.userId, table.id),
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
      ) or (
        ${table.role} = 'assistant'
        and ${table.webSearchAuthorized} = false
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
};
