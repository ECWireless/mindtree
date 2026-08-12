ALTER TABLE "citations" DROP CONSTRAINT "citations_location_check";--> statement-breakpoint
DROP INDEX "citations_synthesis_ordinal_unique";--> statement-breakpoint
DROP INDEX "citations_message_ordinal_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "citations_synthesis_internal_ordinal_unique" ON "citations" USING btree ("synthesis_version_id","ordinal") WHERE "citations"."synthesis_version_id" is not null and "citations"."kind" = 'internal';--> statement-breakpoint
CREATE UNIQUE INDEX "citations_synthesis_external_occurrence_unique" ON "citations" USING btree ("synthesis_version_id","ordinal","start_utf16","end_utf16") WHERE "citations"."synthesis_version_id" is not null and "citations"."kind" = 'external';--> statement-breakpoint
CREATE UNIQUE INDEX "citations_message_external_occurrence_unique" ON "citations" USING btree ("assistant_message_id","ordinal","start_utf16","end_utf16") WHERE "citations"."assistant_message_id" is not null and "citations"."kind" = 'external';--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_external_bounds_check" CHECK ("citations"."kind" <> 'external' or (
        char_length("citations"."external_url") between 1 and 2048
        and "citations"."external_url" ~ '^https?://'
        and char_length("citations"."external_title") between 1 and 500
        and btrim("citations"."external_title") <> ''
      ));--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_location_check" CHECK ((
        "citations"."kind" = 'internal'
        and "citations"."start_utf16" >= 0
        and "citations"."end_utf16" > "citations"."start_utf16"
        and "citations"."end_utf16" <= 64000
      ) or (
        "citations"."kind" = 'external'
        and "citations"."start_utf16" >= 0
        and "citations"."end_utf16" = "citations"."start_utf16"
        and "citations"."end_utf16" <= 64000
      ));