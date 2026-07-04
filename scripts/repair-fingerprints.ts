/**
 * Recompute content_fingerprint for every memory through the canonical JS
 * normalizer (src/services/fingerprint.ts) and fix rows that differ or are
 * NULL. Exists because the 0006 SQL backfill's regex diverged from JS on
 * Unicode whitespace (~90 rows), and a handful of rows were inserted between
 * backfill and code deploy with NULL fingerprints. Idempotent; safe to re-run.
 *
 *   bun run scripts/repair-fingerprints.ts [--dry-run]
 */
import { pg } from "../src/db/client.js";
import { contentFingerprint } from "../src/services/fingerprint.js";

const dryRun = process.argv.includes("--dry-run");
const BATCH = 500;

let scanned = 0;
let repaired = 0;
let lastId = "00000000-0000-0000-0000-000000000000";

for (;;) {
  const rows = (await pg`
    SELECT id, content, content_fingerprint
    FROM memories
    WHERE id > ${lastId}
    ORDER BY id
    LIMIT ${BATCH}
  `) as { id: string; content: string; content_fingerprint: string | null }[];
  if (rows.length === 0) break;

  for (const row of rows) {
    scanned++;
    const expected = contentFingerprint(row.content);
    if (row.content_fingerprint === expected) continue;
    repaired++;
    console.log(
      `${dryRun ? "[dry-run] " : ""}${row.id} ${row.content_fingerprint ?? "(null)"} -> ${expected}`,
    );
    if (!dryRun) {
      await pg`UPDATE memories SET content_fingerprint = ${expected} WHERE id = ${row.id}`;
    }
  }
  lastId = rows[rows.length - 1].id;
}

console.log(`scanned ${scanned}, ${dryRun ? "would repair" : "repaired"} ${repaired}`);
await pg.end();
