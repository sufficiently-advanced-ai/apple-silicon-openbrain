-- memory_links hygiene. linking.ts has always used ON CONFLICT DO NOTHING, but
-- the table never had a unique constraint, so the conflict clause was a no-op
-- and concurrent/repeated linking could insert duplicate pairs. Clean up, then
-- add the undirected-pair unique index that makes the conflict clause real.
-- (derived_from is directional in meaning, but lineage.ts treats a reverse
-- link as conflicting and never creates both directions, so undirected
-- uniqueness is correct for it too.)

-- 1. Similarity links pointing at soft-deleted memories are dead weight every
--    query filters around; similarity links are recomputable, so drop them.
--    Lineage (derived_from) is kept — it is history, and its queries join
--    against live memories anyway.
DELETE FROM memory_links l
WHERE l.relationship <> 'derived_from'
  AND EXISTS (
    SELECT 1 FROM memories m
    WHERE (m.id = l.source_memory_id OR m.id = l.target_memory_id)
      AND m.deleted_at IS NOT NULL
  );

-- 2. Collapse duplicate pairs (keep the earliest row; prefer a dismissed row so
--    a user's "keep both" decision survives the dedup).
DELETE FROM memory_links a
USING memory_links b
WHERE a.id <> b.id
  AND a.relationship = b.relationship
  AND least(a.source_memory_id, a.target_memory_id) = least(b.source_memory_id, b.target_memory_id)
  AND greatest(a.source_memory_id, a.target_memory_id) = greatest(b.source_memory_id, b.target_memory_id)
  AND (
    (a.dismissed_at IS NULL AND b.dismissed_at IS NOT NULL)
    OR ((a.dismissed_at IS NULL) = (b.dismissed_at IS NULL)
        AND (a.created_at, a.id) > (b.created_at, b.id))
  );

-- 3. One link per undirected pair per relationship.
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_links_pair_unique
  ON memory_links (
    least(source_memory_id, target_memory_id),
    greatest(source_memory_id, target_memory_id),
    relationship
  );
