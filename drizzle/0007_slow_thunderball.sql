CREATE TABLE "branch_outline_inputs" (
	"outline_version_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"node_id" uuid NOT NULL,
	"source_node_id" uuid NOT NULL,
	"source_synthesis_version_id" uuid,
	"source_branch_outline_version_id" uuid,
	"summary_state" varchar(16) NOT NULL,
	"outline_state" varchar(16) NOT NULL,
	"source_state_fingerprint" varchar(64) NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "branch_outline_inputs_pkey" PRIMARY KEY("outline_version_id","position"),
	CONSTRAINT "branch_outline_inputs_source_unique" UNIQUE("outline_version_id","source_node_id"),
	CONSTRAINT "branch_outline_inputs_summary_state_check" CHECK ((
        "branch_outline_inputs"."summary_state" = 'none' and "branch_outline_inputs"."source_synthesis_version_id" is null
      ) or (
        "branch_outline_inputs"."summary_state" = 'published' and "branch_outline_inputs"."source_synthesis_version_id" is not null
      )),
	CONSTRAINT "branch_outline_inputs_outline_state_check" CHECK ((
        "branch_outline_inputs"."outline_state" = 'none' and "branch_outline_inputs"."source_branch_outline_version_id" is null
      ) or (
        "branch_outline_inputs"."outline_state" in ('current', 'stale')
        and "branch_outline_inputs"."source_branch_outline_version_id" is not null
      )),
	CONSTRAINT "branch_outline_inputs_fingerprint_check" CHECK ("branch_outline_inputs"."source_state_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "branch_outline_inputs_position_check" CHECK ("branch_outline_inputs"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "branch_outline_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"node_id" uuid NOT NULL,
	"client_request_id" uuid NOT NULL,
	"base_synthesis_version_id" uuid,
	"status" varchar(16) NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"model" varchar(100) NOT NULL,
	"reasoning_mode" varchar(16) NOT NULL,
	"reasoning_effort" varchar(16) NOT NULL,
	"input_fingerprint" varchar(64) NOT NULL,
	"provider_response_id" varchar(255),
	"failure_code" varchar(32),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "branch_outline_versions_user_node_id_unique" UNIQUE("user_id","node_id","id"),
	CONSTRAINT "branch_outline_versions_request_unique" UNIQUE("user_id","node_id","client_request_id"),
	CONSTRAINT "branch_outline_versions_status_check" CHECK ("branch_outline_versions"."status" in ('pending', 'completed', 'failed')),
	CONSTRAINT "branch_outline_versions_lifecycle_check" CHECK ((
        "branch_outline_versions"."status" = 'pending'
        and "branch_outline_versions"."content" = ''
        and "branch_outline_versions"."failure_code" is null
        and "branch_outline_versions"."completed_at" is null
      ) or (
        "branch_outline_versions"."status" = 'completed'
        and char_length("branch_outline_versions"."content") between 1 and 32000
        and btrim("branch_outline_versions"."content") <> ''
        and "branch_outline_versions"."failure_code" is null
        and "branch_outline_versions"."completed_at" is not null
      ) or (
        "branch_outline_versions"."status" = 'failed'
        and "branch_outline_versions"."content" = ''
        and "branch_outline_versions"."failure_code" is not null
        and "branch_outline_versions"."completed_at" is null
      )),
	CONSTRAINT "branch_outline_versions_profile_check" CHECK ("branch_outline_versions"."reasoning_mode" = 'pro' and "branch_outline_versions"."reasoning_effort" = 'high'),
	CONSTRAINT "branch_outline_versions_input_fingerprint_check" CHECK ("branch_outline_versions"."input_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "branch_outline_versions_failure_code_check" CHECK ("branch_outline_versions"."failure_code" is null or "branch_outline_versions"."failure_code" in (
        'generation-failed',
        'provider-refusal',
        'provider-timeout',
        'response-invalid',
        'stream-disconnected',
        'inputs-changed'
      ))
);
--> statement-breakpoint
CREATE TABLE "synthesis_inputs" (
	"synthesis_version_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"node_id" uuid NOT NULL,
	"relation" varchar(16) NOT NULL,
	"source_node_id" uuid NOT NULL,
	"source_synthesis_version_id" uuid,
	"source_branch_outline_version_id" uuid,
	"source_state_fingerprint" varchar(64) NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "synthesis_inputs_pkey" PRIMARY KEY("synthesis_version_id","relation","position"),
	CONSTRAINT "synthesis_inputs_source_unique" UNIQUE("synthesis_version_id","relation","source_node_id"),
	CONSTRAINT "synthesis_inputs_relation_state_check" CHECK ((
        "synthesis_inputs"."relation" = 'outline'
        and "synthesis_inputs"."source_node_id" = "synthesis_inputs"."node_id"
        and "synthesis_inputs"."source_synthesis_version_id" is null
        and "synthesis_inputs"."source_branch_outline_version_id" is not null
        and "synthesis_inputs"."position" = 0
      ) or (
        "synthesis_inputs"."relation" = 'related'
        and "synthesis_inputs"."source_synthesis_version_id" is not null
        and "synthesis_inputs"."source_branch_outline_version_id" is null
      )),
	CONSTRAINT "synthesis_inputs_fingerprint_check" CHECK ("synthesis_inputs"."source_state_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "synthesis_inputs_position_check" CHECK ("synthesis_inputs"."position" >= 0)
);
--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "current_branch_outline_version_id" uuid;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "branch_outline_stale_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "branch_outline_stale_reason" varchar(32);--> statement-breakpoint
ALTER TABLE "branch_outline_inputs" ADD CONSTRAINT "branch_outline_inputs_version_owner_fk" FOREIGN KEY ("user_id","node_id","outline_version_id") REFERENCES "public"."branch_outline_versions"("user_id","node_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_outline_versions" ADD CONSTRAINT "branch_outline_versions_node_owner_fk" FOREIGN KEY ("user_id","node_id") REFERENCES "public"."nodes"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_outline_versions" ADD CONSTRAINT "branch_outline_versions_base_owner_fk" FOREIGN KEY ("user_id","node_id","base_synthesis_version_id") REFERENCES "public"."synthesis_versions"("user_id","node_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synthesis_inputs" ADD CONSTRAINT "synthesis_inputs_version_owner_fk" FOREIGN KEY ("user_id","node_id","synthesis_version_id") REFERENCES "public"."synthesis_versions"("user_id","node_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_current_branch_outline_owner_fk" FOREIGN KEY ("user_id","id","current_branch_outline_version_id") REFERENCES "public"."branch_outline_versions"("user_id","node_id","id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
CREATE UNIQUE INDEX "branch_outline_versions_one_pending_per_node" ON "branch_outline_versions" USING btree ("user_id","node_id") WHERE "branch_outline_versions"."status" = 'pending';--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_branch_outline_stale_state_check" CHECK ((
        "nodes"."current_branch_outline_version_id" is null
        and "nodes"."branch_outline_stale_at" is null
        and "nodes"."branch_outline_stale_reason" is null
      ) or (
        "nodes"."current_branch_outline_version_id" is not null
        and (
          ("nodes"."branch_outline_stale_at" is null and "nodes"."branch_outline_stale_reason" is null)
          or
          ("nodes"."branch_outline_stale_at" is not null and "nodes"."branch_outline_stale_reason" is not null)
        )
      ));--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_branch_outline_stale_reason_check" CHECK ("nodes"."branch_outline_stale_reason" is null or "nodes"."branch_outline_stale_reason" in (
        'summary-changed',
        'branch-structure-changed',
        'branch-content-changed',
        'branch-availability-changed',
        'node-renamed'
      ));--> statement-breakpoint
CREATE FUNCTION "enforce_branch_outline_version_transition"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'branch_outline_versions_immutable_transition_check',
      MESSAGE = 'terminal Branch Outline versions are immutable';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.node_id IS DISTINCT FROM OLD.node_id
    OR NEW.client_request_id IS DISTINCT FROM OLD.client_request_id
    OR NEW.base_synthesis_version_id IS DISTINCT FROM OLD.base_synthesis_version_id
    OR NEW.model IS DISTINCT FROM OLD.model
    OR NEW.reasoning_mode IS DISTINCT FROM OLD.reasoning_mode
    OR NEW.reasoning_effort IS DISTINCT FROM OLD.reasoning_effort
    OR NEW.input_fingerprint IS DISTINCT FROM OLD.input_fingerprint
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'branch_outline_versions_immutable_transition_check',
      MESSAGE = 'Branch Outline generation identity is immutable';
  END IF;

  IF NEW.status = 'pending' THEN
    IF NEW.content IS DISTINCT FROM OLD.content
      OR NEW.failure_code IS DISTINCT FROM OLD.failure_code
      OR NEW.completed_at IS DISTINCT FROM OLD.completed_at THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'branch_outline_versions_immutable_transition_check',
        MESSAGE = 'pending Branch Outline content state is immutable';
    END IF;
  ELSIF NEW.status NOT IN ('completed', 'failed') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'branch_outline_versions_immutable_transition_check',
      MESSAGE = 'invalid Branch Outline transition';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "branch_outline_versions_immutable_transition_trigger"
BEFORE UPDATE ON "branch_outline_versions"
FOR EACH ROW EXECUTE FUNCTION "enforce_branch_outline_version_transition"();--> statement-breakpoint
CREATE FUNCTION "enforce_branch_outline_input_lifecycle"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT status INTO parent_status
    FROM branch_outline_versions
    WHERE id = NEW.outline_version_id
      AND user_id = NEW.user_id
      AND node_id = NEW.node_id
    FOR UPDATE;
    IF parent_status IS DISTINCT FROM 'pending' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'branch_outline_inputs_parent_pending_check',
        MESSAGE = 'Branch Outline inputs may only be attached while pending';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'branch_outline_inputs_immutable_check',
      MESSAGE = 'Branch Outline inputs are immutable';
  END IF;

  PERFORM 1
  FROM branch_outline_versions
  WHERE id = OLD.outline_version_id
    AND user_id = OLD.user_id
    AND node_id = OLD.node_id;
  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'branch_outline_inputs_immutable_check',
      MESSAGE = 'Branch Outline inputs are immutable';
  END IF;
  RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "branch_outline_inputs_lifecycle_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "branch_outline_inputs"
FOR EACH ROW EXECUTE FUNCTION "enforce_branch_outline_input_lifecycle"();--> statement-breakpoint
CREATE FUNCTION "enforce_synthesis_input_lifecycle"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT status INTO parent_status
    FROM synthesis_versions
    WHERE id = NEW.synthesis_version_id
      AND user_id = NEW.user_id
      AND node_id = NEW.node_id
    FOR UPDATE;
    IF parent_status IS DISTINCT FROM 'pending' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'synthesis_inputs_parent_pending_check',
        MESSAGE = 'synthesis inputs may only be attached while pending';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'synthesis_inputs_immutable_check',
      MESSAGE = 'synthesis inputs are immutable';
  END IF;

  PERFORM 1
  FROM synthesis_versions
  WHERE id = OLD.synthesis_version_id
    AND user_id = OLD.user_id
    AND node_id = OLD.node_id;
  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'synthesis_inputs_immutable_check',
      MESSAGE = 'synthesis inputs are immutable';
  END IF;
  RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "synthesis_inputs_lifecycle_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "synthesis_inputs"
FOR EACH ROW EXECUTE FUNCTION "enforce_synthesis_input_lifecycle"();
