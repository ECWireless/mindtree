ALTER TABLE "chat_messages" DROP CONSTRAINT "chat_messages_role_state_check";--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "refinement_proposal_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_refinement_proposal_owner_fk" FOREIGN KEY ("user_id","node_id","refinement_proposal_id") REFERENCES "public"."synthesis_versions"("user_id","node_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_role_state_check" CHECK ((
        "chat_messages"."role" = 'user'
        and "chat_messages"."status" = 'completed'
        and "chat_messages"."completed_at" is not null
        and "chat_messages"."model" is null
        and "chat_messages"."provider_response_id" is null
        and "chat_messages"."context_fingerprint" is null
        and "chat_messages"."failure_code" is null
        and ("chat_messages"."proposal_requested" = true or "chat_messages"."refinement_proposal_id" is null)
      ) or (
        "chat_messages"."role" = 'assistant'
        and "chat_messages"."web_search_authorized" = false
        and "chat_messages"."proposal_requested" = false
        and "chat_messages"."refinement_proposal_id" is null
      ));--> statement-breakpoint
CREATE FUNCTION "enforce_synthesis_version_transition"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'synthesis_versions_immutable_transition_check',
      MESSAGE = 'decided synthesis versions are immutable';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.node_id IS DISTINCT FROM OLD.node_id
    OR NEW.base_version_id IS DISTINCT FROM OLD.base_version_id
    OR NEW.content IS DISTINCT FROM OLD.content
    OR NEW.model IS DISTINCT FROM OLD.model
    OR NEW.reasoning_mode IS DISTINCT FROM OLD.reasoning_mode
    OR NEW.reasoning_effort IS DISTINCT FROM OLD.reasoning_effort
    OR NEW.input_fingerprint IS DISTINCT FROM OLD.input_fingerprint
    OR NEW.generating_message_id IS DISTINCT FROM OLD.generating_message_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.status NOT IN ('approved', 'rejected', 'superseded')
    OR NEW.decided_at IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'synthesis_versions_immutable_transition_check',
      MESSAGE = 'synthesis proposal fields are immutable';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "synthesis_versions_immutable_transition_trigger"
BEFORE UPDATE ON "synthesis_versions"
FOR EACH ROW EXECUTE FUNCTION "enforce_synthesis_version_transition"();
