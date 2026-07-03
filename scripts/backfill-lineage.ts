#!/usr/bin/env bun
// Backfill derived_from lineage across the existing corpus. External pipelines
// ingested both sources and enrichments-of-sources (e.g. a YouTube transcript and
// an Obsidian analysis note of it); those pairs currently read as near-duplicates.
// This re-runs lineage detection over every live memory, converting the flagged
// pairs into directional derived_from links. Idempotent — safe to re-run.
//
//   bun run scripts/backfill-lineage.ts [--limit N]
import { pg } from "../src/db/client.js";
import { detectLineage } from "../src/services/lineage.js";

const limitArg = process.argv.indexOf("--limit");
const limit = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : null;

const rows = (await pg`
  SELECT id, content, source, source_id AS "sourceId"
  FROM memories
  WHERE deleted_at IS NULL
  ORDER BY created_at ASC
  ${limit ? pg`LIMIT ${limit}` : pg``}
`) as { id: string; content: string; source: string | null; sourceId: string | null }[];

console.log(`[backfill-lineage] scanning ${rows.length} live memories…`);

let linked = 0;
let withLineage = 0;
let i = 0;
for (const r of rows) {
  // Direction-A only: every memory is processed, so each derivative finds its
  // source without the O(n²) reverse content scan.
  const n = await detectLineage(
    { memoryId: r.id, content: r.content, source: r.source, sourceId: r.sourceId },
    { reverse: false },
  );
  if (n > 0) {
    linked += n;
    withLineage++;
  }
  if (++i % 200 === 0) console.log(`[backfill-lineage]   ${i}/${rows.length} (${linked} links so far)`);
}

const [{ total }] = (await pg`
  SELECT count(*)::int AS total FROM memory_links WHERE relationship = 'derived_from'
`) as { total: number }[];

console.log(
  `[backfill-lineage] done. ${linked} link(s) created/promoted across ${withLineage} memories; ` +
    `${total} derived_from links total in corpus.`,
);
await pg.end();
