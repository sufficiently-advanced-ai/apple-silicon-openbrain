-- Capture live-DB objects created outside migrations (the LCARS/Hermes
-- pg_notify integration and its supporting column/indexes), so fresh installs
-- match the production database and drizzle-kit diffing has nothing to drop.
-- Also drops openbrain_memory_notify_insert — an exact duplicate of
-- openbrain_memory_notify that made every cowork-session/obsidian insert fire
-- pg_notify twice.

ALTER TABLE memories ADD COLUMN IF NOT EXISTS origin_source_id uuid;

CREATE INDEX IF NOT EXISTS idx_memories_origin_source
  ON memories (origin_source_id)
  WHERE origin_source_id IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_memories_deleted
  ON memories (deleted_at)
  WHERE deleted_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_memories_expires
  ON memories (expires_at)
  WHERE expires_at IS NOT NULL AND deleted_at IS NULL;

-- Notifies external listeners (LCARS daemon) when a cowork-session/obsidian
-- memory lands or finishes enrichment (summary NULL -> non-NULL).
CREATE OR REPLACE FUNCTION notify_openbrain_memory()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  payload text;
BEGIN
  -- Only care about relevant sources
  IF NEW.source NOT IN ('cowork-session', 'obsidian') THEN
    RETURN NEW;
  END IF;

  -- On INSERT: fire immediately with whatever we have (summary may be NULL)
  -- On UPDATE: only fire when summary transitions from NULL → non-NULL
  IF TG_OP = 'UPDATE' THEN
    IF OLD.summary IS NOT NULL OR NEW.summary IS NULL THEN
      RETURN NEW; -- already notified, or still no summary
    END IF;
  END IF;

  payload := json_build_object(
    'op',      TG_OP,
    'source',  NEW.source,
    'summary', COALESCE(LEFT(NEW.summary, 120), ''),
    'tags',    COALESCE(array_to_string(NEW.tags, ','), '')
  )::text;

  PERFORM pg_notify('openbrain_memory', payload);
  RETURN NEW;
END;
$function$;

-- Duplicate of openbrain_memory_notify (same event, same function) — drop it.
DROP TRIGGER IF EXISTS openbrain_memory_notify_insert ON memories;

DROP TRIGGER IF EXISTS openbrain_memory_notify ON memories;
CREATE TRIGGER openbrain_memory_notify
  AFTER INSERT ON memories
  FOR EACH ROW EXECUTE FUNCTION notify_openbrain_memory();

DROP TRIGGER IF EXISTS openbrain_memory_notify_update ON memories;
CREATE TRIGGER openbrain_memory_notify_update
  AFTER UPDATE OF summary ON memories
  FOR EACH ROW EXECUTE FUNCTION notify_openbrain_memory();
