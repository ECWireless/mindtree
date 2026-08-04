CREATE TABLE "chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"node_id" uuid NOT NULL,
	"client_message_id" uuid NOT NULL,
	"role" varchar(16) NOT NULL,
	"status" varchar(16) NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"model" varchar(100),
	"provider_response_id" varchar(255),
	"failure_code" varchar(64),
	"web_search_authorized" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "chat_messages_turn_role_unique" UNIQUE("user_id","node_id","client_message_id","role"),
	CONSTRAINT "chat_messages_role_check" CHECK ("chat_messages"."role" in ('user', 'assistant')),
	CONSTRAINT "chat_messages_status_check" CHECK ("chat_messages"."status" in ('pending', 'streaming', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "chat_messages_role_state_check" CHECK ((
        "chat_messages"."role" = 'user'
        and "chat_messages"."status" = 'completed'
        and "chat_messages"."completed_at" is not null
        and "chat_messages"."model" is null
        and "chat_messages"."provider_response_id" is null
        and "chat_messages"."failure_code" is null
      ) or (
        "chat_messages"."role" = 'assistant'
        and "chat_messages"."web_search_authorized" = false
      )),
	CONSTRAINT "chat_messages_completion_check" CHECK ((
        "chat_messages"."status" = 'completed'
        and "chat_messages"."completed_at" is not null
        and "chat_messages"."failure_code" is null
      ) or (
        "chat_messages"."status" = 'failed'
        and "chat_messages"."completed_at" is null
        and "chat_messages"."failure_code" is not null
      ) or (
        "chat_messages"."status" in ('pending', 'streaming', 'cancelled')
        and "chat_messages"."completed_at" is null
        and "chat_messages"."failure_code" is null
      )),
	CONSTRAINT "chat_messages_content_length_check" CHECK ((
        "chat_messages"."role" = 'user'
        and char_length("chat_messages"."content") between 1 and 16000
        and btrim("chat_messages"."content") <> ''
      ) or (
        "chat_messages"."role" = 'assistant'
        and char_length("chat_messages"."content") <= 64000
        and ("chat_messages"."status" <> 'completed' or char_length("chat_messages"."content") >= 1)
      ))
);
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_node_owner_fk" FOREIGN KEY ("user_id","node_id") REFERENCES "public"."nodes"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_messages_pagination_idx" ON "chat_messages" USING btree ("user_id","node_id","created_at","id");