-- "Keep both" in the duplicates view. Dismissing a near-duplicate pair stamps
-- the link rather than deleting it: the link still powers the related-memories
-- list on the detail page, but the near-duplicates query skips it.
ALTER TABLE memory_links ADD COLUMN IF NOT EXISTS dismissed_at timestamptz;
