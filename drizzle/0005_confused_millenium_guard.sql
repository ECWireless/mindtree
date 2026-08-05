CREATE TABLE "synthesis_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"node_id" uuid NOT NULL,
	"base_version_id" uuid,
	"status" varchar(16) NOT NULL,
	"content" text NOT NULL,
	"model" varchar(100) NOT NULL,
	"reasoning_mode" varchar(16) NOT NULL,
	"reasoning_effort" varchar(16) NOT NULL,
	"input_fingerprint" varchar(64) NOT NULL,
	"generating_message_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "synthesis_versions_user_node_id_unique" UNIQUE("user_id","node_id","id"),
	CONSTRAINT "synthesis_versions_generating_message_unique" UNIQUE("generating_message_id"),
	CONSTRAINT "synthesis_versions_status_check" CHECK ("synthesis_versions"."status" in ('pending', 'approved', 'rejected', 'superseded')),
	CONSTRAINT "synthesis_versions_decision_state_check" CHECK ((
        "synthesis_versions"."status" = 'pending' and "synthesis_versions"."decided_at" is null
      ) or (
        "synthesis_versions"."status" in ('approved', 'rejected', 'superseded')
        and "synthesis_versions"."decided_at" is not null
      )),
	CONSTRAINT "synthesis_versions_content_length_check" CHECK (char_length("synthesis_versions"."content") between 1 and 32000 and btrim("synthesis_versions"."content") <> ''),
	CONSTRAINT "synthesis_versions_profile_check" CHECK ("synthesis_versions"."reasoning_mode" = 'pro' and "synthesis_versions"."reasoning_effort" = 'high'),
	CONSTRAINT "synthesis_versions_input_fingerprint_check" CHECK ("synthesis_versions"."input_fingerprint" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "chat_messages" DROP CONSTRAINT "chat_messages_role_state_check";--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "proposal_requested" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "published_synthesis_version_id" uuid;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "synthesis_stale_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_user_node_id_unique" UNIQUE("user_id","node_id","id");--> statement-breakpoint
ALTER TABLE "synthesis_versions" ADD CONSTRAINT "synthesis_versions_node_owner_fk" FOREIGN KEY ("user_id","node_id") REFERENCES "public"."nodes"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synthesis_versions" ADD CONSTRAINT "synthesis_versions_base_owner_fk" FOREIGN KEY ("user_id","node_id","base_version_id") REFERENCES "public"."synthesis_versions"("user_id","node_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synthesis_versions" ADD CONSTRAINT "synthesis_versions_message_owner_fk" FOREIGN KEY ("user_id","node_id","generating_message_id") REFERENCES "public"."chat_messages"("user_id","node_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_published_synthesis_owner_fk" FOREIGN KEY ("user_id","id","published_synthesis_version_id") REFERENCES "public"."synthesis_versions"("user_id","node_id","id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
CREATE UNIQUE INDEX "synthesis_versions_one_pending_per_node" ON "synthesis_versions" USING btree ("user_id","node_id") WHERE "synthesis_versions"."status" = 'pending';--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_role_state_check" CHECK ((
        "chat_messages"."role" = 'user'
        and "chat_messages"."status" = 'completed'
        and "chat_messages"."completed_at" is not null
        and "chat_messages"."model" is null
        and "chat_messages"."provider_response_id" is null
        and "chat_messages"."context_fingerprint" is null
        and "chat_messages"."failure_code" is null
      ) or (
        "chat_messages"."role" = 'assistant'
        and "chat_messages"."web_search_authorized" = false
        and "chat_messages"."proposal_requested" = false
      ));
