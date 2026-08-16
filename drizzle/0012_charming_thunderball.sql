CREATE TABLE "branch_share_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"root_node_id" uuid NOT NULL,
	"secret_digest" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "branch_share_links_user_root_unique" UNIQUE("user_id","root_node_id"),
	CONSTRAINT "branch_share_links_secret_digest_unique" UNIQUE("secret_digest"),
	CONSTRAINT "branch_share_links_secret_digest_check" CHECK ("branch_share_links"."secret_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "branch_share_links" ADD CONSTRAINT "branch_share_links_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_share_links" ADD CONSTRAINT "branch_share_links_root_owner_fk" FOREIGN KEY ("user_id","root_node_id") REFERENCES "public"."nodes"("user_id","id") ON DELETE cascade ON UPDATE no action;