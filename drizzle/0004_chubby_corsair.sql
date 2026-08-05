ALTER TABLE "chat_messages" DROP CONSTRAINT "chat_messages_role_state_check";--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "context_fingerprint" varchar(64);--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_context_fingerprint_check" CHECK ("chat_messages"."context_fingerprint" is null or "chat_messages"."context_fingerprint" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
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
      ));