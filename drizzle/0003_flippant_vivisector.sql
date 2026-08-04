DROP INDEX "chat_messages_pagination_idx";--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "sequence" bigint;--> statement-breakpoint
WITH "ranked_messages" AS (
	SELECT
		"id",
		row_number() OVER (
			PARTITION BY "user_id", "node_id"
			ORDER BY
				"created_at",
				"client_message_id",
				CASE "role" WHEN 'user' THEN 0 ELSE 1 END,
				"id"
		) - 1 AS "sequence"
	FROM "chat_messages"
)
UPDATE "chat_messages"
SET "sequence" = "ranked_messages"."sequence"
FROM "ranked_messages"
WHERE "chat_messages"."id" = "ranked_messages"."id";--> statement-breakpoint
ALTER TABLE "chat_messages" ALTER COLUMN "sequence" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_node_sequence_unique" UNIQUE("user_id","node_id","sequence");--> statement-breakpoint
UPDATE "chat_messages"
SET "failure_code" = 'generation-failed'
WHERE "failure_code" IS NOT NULL
	AND "failure_code" NOT IN (
		'assistant-unavailable',
		'generation-failed',
		'provider-refusal',
		'provider-timeout',
		'response-invalid',
		'stream-disconnected'
	);--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_failure_code_check" CHECK ("chat_messages"."failure_code" is null or "chat_messages"."failure_code" in (
        'assistant-unavailable',
        'generation-failed',
        'provider-refusal',
        'provider-timeout',
        'response-invalid',
        'stream-disconnected'
      ));
