import { createHash } from "node:crypto";

/**
 * Normalize content for advisory deduplication: lowercase, collapse all
 * whitespace runs to a single space, and trim.
 *
 * THIS function is the canonical fingerprint definition. The SQL backfill in
 * drizzle/0006_governance.sql approximated it but diverged on Unicode
 * whitespace (JS \s matches NBSP/ZWSP etc., Postgres \s does not) — those rows
 * were repaired by scripts/repair-fingerprints.ts, which recomputes through
 * this function. Any future backfill must go through that script, not raw SQL.
 */
export function normalizeForFingerprint(content: string): string {
  return content.toLowerCase().replace(/\s+/g, " ").trim();
}

/** sha256 hex of the normalized content. */
export function contentFingerprint(content: string): string {
  return createHash("sha256").update(normalizeForFingerprint(content), "utf8").digest("hex");
}
