CREATE TABLE "citations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"owner_node_id" uuid NOT NULL,
	"assistant_message_id" uuid,
	"synthesis_version_id" uuid,
	"kind" varchar(16) NOT NULL,
	"ordinal" integer NOT NULL,
	"start_utf16" integer NOT NULL,
	"end_utf16" integer NOT NULL,
	"live_target_node_id" uuid,
	"live_target_synthesis_version_id" uuid,
	"target_node_id_snapshot" uuid,
	"target_title_snapshot" varchar(200),
	"target_parent_id_snapshot" uuid,
	"target_synthesis_version_id_snapshot" uuid,
	"target_deleted_at" timestamp with time zone,
	"external_url" text,
	"external_title" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "citations_owner_check" CHECK (num_nonnulls("citations"."assistant_message_id", "citations"."synthesis_version_id") = 1),
	CONSTRAINT "citations_kind_check" CHECK ("citations"."kind" in ('internal', 'external')),
	CONSTRAINT "citations_ordinal_check" CHECK ("citations"."ordinal" between 1 and 32),
	CONSTRAINT "citations_location_check" CHECK ("citations"."start_utf16" >= 0
        and "citations"."end_utf16" > "citations"."start_utf16"
        and "citations"."end_utf16" <= 64000),
	CONSTRAINT "citations_kind_fields_check" CHECK ((
        "citations"."kind" = 'internal'
        and "citations"."assistant_message_id" is null
        and "citations"."synthesis_version_id" is not null
        and "citations"."target_node_id_snapshot" is not null
        and "citations"."target_title_snapshot" is not null
        and "citations"."target_synthesis_version_id_snapshot" is not null
        and "citations"."external_url" is null
        and "citations"."external_title" is null
        and (
          ("citations"."live_target_node_id" is not null
            and "citations"."live_target_synthesis_version_id" is not null
            and "citations"."target_deleted_at" is null)
          or
          ("citations"."live_target_node_id" is null
            and "citations"."live_target_synthesis_version_id" is null
            and "citations"."target_deleted_at" is not null)
        )
      ) or (
        "citations"."kind" = 'external'
        and "citations"."live_target_node_id" is null
        and "citations"."live_target_synthesis_version_id" is null
        and "citations"."target_node_id_snapshot" is null
        and "citations"."target_title_snapshot" is null
        and "citations"."target_parent_id_snapshot" is null
        and "citations"."target_synthesis_version_id_snapshot" is null
        and "citations"."target_deleted_at" is null
        and "citations"."external_url" is not null
        and "citations"."external_title" is not null
      ))
);
--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_synthesis_owner_fk" FOREIGN KEY ("user_id","owner_node_id","synthesis_version_id") REFERENCES "public"."synthesis_versions"("user_id","node_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_message_owner_fk" FOREIGN KEY ("user_id","owner_node_id","assistant_message_id") REFERENCES "public"."chat_messages"("user_id","node_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_live_target_owner_fk" FOREIGN KEY ("user_id","live_target_node_id","live_target_synthesis_version_id") REFERENCES "public"."synthesis_versions"("user_id","node_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_live_snapshot_check" CHECK (
  "kind" <> 'internal'
  OR "live_target_node_id" IS NULL
  OR (
    "target_node_id_snapshot" = "live_target_node_id"
    AND "target_synthesis_version_id_snapshot" = "live_target_synthesis_version_id"
  )
);--> statement-breakpoint
CREATE UNIQUE INDEX "citations_synthesis_ordinal_unique" ON "citations" USING btree ("synthesis_version_id","ordinal") WHERE "citations"."synthesis_version_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "citations_message_ordinal_unique" ON "citations" USING btree ("assistant_message_id","ordinal") WHERE "citations"."assistant_message_id" is not null;--> statement-breakpoint
CREATE INDEX "citations_live_target_idx" ON "citations" USING btree ("user_id","live_target_node_id");--> statement-breakpoint
CREATE FUNCTION "enforce_citation_lifecycle"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status text;
  message_role text;
  message_status text;
  target_status text;
  target_current_version uuid;
  target_title text;
  target_parent_id uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.synthesis_version_id IS NOT NULL THEN
      SELECT status INTO parent_status
      FROM synthesis_versions
      WHERE id = NEW.synthesis_version_id
        AND user_id = NEW.user_id
        AND node_id = NEW.owner_node_id
      FOR UPDATE;
      IF parent_status IS DISTINCT FROM 'pending' THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          CONSTRAINT = 'citations_parent_pending_check',
          MESSAGE = 'synthesis citations may only be attached while pending';
      END IF;
    ELSE
      SELECT role, status INTO message_role, message_status
      FROM chat_messages
      WHERE id = NEW.assistant_message_id
        AND user_id = NEW.user_id
        AND node_id = NEW.owner_node_id
      FOR UPDATE;
      IF message_role IS DISTINCT FROM 'assistant'
        OR message_status NOT IN ('streaming', 'completed') THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          CONSTRAINT = 'citations_message_state_check',
          MESSAGE = 'message citations require an available assistant message';
      END IF;
    END IF;

    IF NEW.kind = 'internal' THEN
      SELECT
        synthesis_versions.status,
        nodes.published_synthesis_version_id,
        nodes.title,
        nodes.parent_id
      INTO target_status, target_current_version, target_title, target_parent_id
      FROM synthesis_versions
      INNER JOIN nodes
        ON nodes.user_id = synthesis_versions.user_id
        AND nodes.id = synthesis_versions.node_id
      WHERE synthesis_versions.user_id = NEW.user_id
        AND synthesis_versions.node_id = NEW.live_target_node_id
        AND synthesis_versions.id = NEW.live_target_synthesis_version_id;
      IF target_status IS DISTINCT FROM 'approved'
        OR target_current_version IS DISTINCT FROM NEW.live_target_synthesis_version_id
        OR target_title IS DISTINCT FROM NEW.target_title_snapshot
        OR target_parent_id IS DISTINCT FROM NEW.target_parent_id_snapshot THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          CONSTRAINT = 'citations_internal_target_current_check',
          MESSAGE = 'internal citations require exact current approved evidence';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF pg_trigger_depth() > 1
      AND OLD.kind = 'internal'
      AND OLD.live_target_node_id IS NOT NULL
      AND OLD.live_target_synthesis_version_id IS NOT NULL
      AND OLD.target_deleted_at IS NULL
      AND NEW.live_target_node_id IS NULL
      AND NEW.live_target_synthesis_version_id IS NULL
      AND NEW.target_deleted_at IS NOT NULL
      AND (to_jsonb(NEW) - ARRAY[
        'live_target_node_id',
        'live_target_synthesis_version_id',
        'target_deleted_at'
      ]) = (to_jsonb(OLD) - ARRAY[
        'live_target_node_id',
        'live_target_synthesis_version_id',
        'target_deleted_at'
      ]) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'citations_immutable_check',
      MESSAGE = 'citations are immutable';
  END IF;

  PERFORM 1
  FROM synthesis_versions
  WHERE id = OLD.synthesis_version_id
    AND user_id = OLD.user_id
    AND node_id = OLD.owner_node_id;
  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'citations_immutable_check',
      MESSAGE = 'citations are immutable';
  END IF;
  PERFORM 1
  FROM chat_messages
  WHERE id = OLD.assistant_message_id
    AND user_id = OLD.user_id
    AND node_id = OLD.owner_node_id;
  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'citations_immutable_check',
      MESSAGE = 'citations are immutable';
  END IF;
  RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "citations_lifecycle_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "citations"
FOR EACH ROW EXECUTE FUNCTION "enforce_citation_lifecycle"();--> statement-breakpoint
CREATE FUNCTION "clear_deleted_node_citation_targets"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE citations
  SET live_target_node_id = NULL,
      live_target_synthesis_version_id = NULL,
      target_deleted_at = now()
  WHERE user_id = OLD.user_id
    AND live_target_node_id = OLD.id;
  RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "nodes_clear_citation_targets_trigger"
BEFORE DELETE ON "nodes"
FOR EACH ROW EXECUTE FUNCTION "clear_deleted_node_citation_targets"();
