CREATE TABLE "nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"parent_id" uuid,
	"position" integer NOT NULL,
	"title" varchar(200) NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nodes_user_id_id_unique" UNIQUE("user_id","id"),
	CONSTRAINT "nodes_sibling_position_unique" UNIQUE NULLS NOT DISTINCT("user_id","parent_id","position") DEFERRABLE INITIALLY IMMEDIATE,
	CONSTRAINT "nodes_not_own_parent_check" CHECK ("nodes"."parent_id" is null or "nodes"."parent_id" <> "nodes"."id"),
	CONSTRAINT "nodes_position_non_negative_check" CHECK ("nodes"."position" >= 0),
	CONSTRAINT "nodes_title_trimmed_length_check" CHECK ("nodes"."title" !~ '^[[:space:]]|[[:space:]]$' and char_length("nodes"."title") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_parent_owner_fk" FOREIGN KEY ("user_id","parent_id") REFERENCES "public"."nodes"("user_id","id") ON DELETE cascade ON UPDATE no action;
