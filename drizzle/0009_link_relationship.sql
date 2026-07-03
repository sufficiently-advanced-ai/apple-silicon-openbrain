-- Typed memory links. 'similar' is the existing embedding-similarity link
-- (undirected); 'derived_from' is directional lineage where source_memory_id is
-- the derivative (e.g. an Obsidian analysis note) and target_memory_id is the
-- source it was produced from (e.g. the YouTube transcript). Lineage is detected
-- from deterministic back-references the derivative carries (a URL / video id),
-- not from similarity — so source→enrichment pairs stop reading as duplicates.
ALTER TABLE memory_links ADD COLUMN IF NOT EXISTS relationship text NOT NULL DEFAULT 'similar';

ALTER TABLE memory_links DROP CONSTRAINT IF EXISTS chk_memory_links_relationship;
ALTER TABLE memory_links ADD CONSTRAINT chk_memory_links_relationship
  CHECK (relationship IN ('similar', 'derived_from'));

-- Lineage lookups go both directions (a memory's source, and its derivatives).
CREATE INDEX IF NOT EXISTS idx_memory_links_relationship ON memory_links (relationship);
