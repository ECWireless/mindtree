CREATE EXTENSION IF NOT EXISTS "vector";--> statement-breakpoint
CREATE TABLE "node_embeddings" (
	"user_id" text NOT NULL,
	"node_id" uuid NOT NULL,
	"source_synthesis_version_id" uuid NOT NULL,
	"model" varchar(100) NOT NULL,
	"dimensions" integer NOT NULL,
	"embedding" vector(3072) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "node_embeddings_pkey" PRIMARY KEY("user_id","node_id"),
	CONSTRAINT "node_embeddings_profile_check" CHECK ("node_embeddings"."model" = 'text-embedding-3-large' and "node_embeddings"."dimensions" = 3072)
);
--> statement-breakpoint
ALTER TABLE "node_embeddings" ADD CONSTRAINT "node_embeddings_node_owner_fk" FOREIGN KEY ("user_id","node_id") REFERENCES "public"."nodes"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_embeddings" ADD CONSTRAINT "node_embeddings_source_owner_fk" FOREIGN KEY ("user_id","node_id","source_synthesis_version_id") REFERENCES "public"."synthesis_versions"("user_id","node_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_user_id_id_published_unique" UNIQUE("user_id","id","published_synthesis_version_id");--> statement-breakpoint
ALTER TABLE "node_embeddings" ADD CONSTRAINT "node_embeddings_current_owner_fk" FOREIGN KEY ("user_id","node_id","source_synthesis_version_id") REFERENCES "public"."nodes"("user_id","id","published_synthesis_version_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE FUNCTION "enforce_node_embedding_approved_source"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM 1
  FROM synthesis_versions
  WHERE user_id = NEW.user_id
    AND node_id = NEW.node_id
    AND id = NEW.source_synthesis_version_id
    AND status = 'approved';
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'node_embeddings_approved_source_check',
      MESSAGE = 'node embeddings require an approved synthesis source';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "node_embeddings_approved_source_trigger"
BEFORE INSERT OR UPDATE ON "node_embeddings"
FOR EACH ROW EXECUTE FUNCTION "enforce_node_embedding_approved_source"();
