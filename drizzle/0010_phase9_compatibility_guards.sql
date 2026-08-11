CREATE FUNCTION "invalidate_node_embedding_before_publication_change"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.published_synthesis_version_id IS DISTINCT FROM OLD.published_synthesis_version_id THEN
    DELETE FROM node_embeddings
    WHERE user_id = OLD.user_id
      AND node_id = OLD.id;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "nodes_invalidate_embedding_before_publication_change_trigger"
BEFORE UPDATE OF "published_synthesis_version_id" ON "nodes"
FOR EACH ROW EXECUTE FUNCTION "invalidate_node_embedding_before_publication_change"();--> statement-breakpoint
CREATE FUNCTION "enforce_current_related_inputs_on_synthesis_approval"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  related_input record;
  related_count integer := 0;
  source_current_version uuid;
  source_status text;
BEGIN
  IF OLD.status = 'pending' AND NEW.status = 'approved' THEN
    FOR related_input IN
      SELECT source_node_id, source_synthesis_version_id, position
      FROM synthesis_inputs
      WHERE user_id = NEW.user_id
        AND node_id = NEW.node_id
        AND synthesis_version_id = NEW.id
        AND relation = 'related'
      ORDER BY position
    LOOP
      IF related_count >= 5
        OR related_input.position <> related_count
        OR related_input.source_node_id = NEW.node_id
        OR related_input.source_synthesis_version_id IS NULL THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          CONSTRAINT = 'synthesis_versions_related_inputs_current_check',
          MESSAGE = 'approved synthesis related inputs must be bounded and ordered';
      END IF;

      SELECT
        nodes.published_synthesis_version_id,
        synthesis_versions.status
      INTO source_current_version, source_status
      FROM nodes
      LEFT JOIN synthesis_versions
        ON synthesis_versions.user_id = nodes.user_id
        AND synthesis_versions.node_id = nodes.id
        AND synthesis_versions.id = nodes.published_synthesis_version_id
      WHERE nodes.user_id = NEW.user_id
        AND nodes.id = related_input.source_node_id
      FOR UPDATE OF nodes;

      IF NOT FOUND
        OR source_current_version IS DISTINCT FROM related_input.source_synthesis_version_id
        OR source_status IS DISTINCT FROM 'approved' THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          CONSTRAINT = 'synthesis_versions_related_inputs_current_check',
          MESSAGE = 'approved synthesis related inputs must reference exact current approved sources';
      END IF;

      related_count := related_count + 1;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "synthesis_versions_related_inputs_current_trigger"
BEFORE UPDATE OF "status" ON "synthesis_versions"
FOR EACH ROW EXECUTE FUNCTION "enforce_current_related_inputs_on_synthesis_approval"();
