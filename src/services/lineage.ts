import { pg } from "../db/client.js";
import { recordAudit } from "./audit.js";

// Lineage detection. External pipelines ingest both a *source* (e.g. a YouTube
// transcript) and an *enrichment derived from it* (e.g. an Obsidian analysis
// note). Their text differs, so neither (source, source_id) nor content-
// fingerprint dedup catches them — they only surface later as embedding-
// similarity links and read as duplicates. But the derivative carries a
// deterministic back-reference to its source (a YouTube URL / video id, or the
// article URL), and the source encodes that same id in its source_id. We match
// on that back-reference and record a directional `derived_from` link instead of
// leaving the pair as an undifferentiated `similar` duplicate.
//
// Direction convention: derived_from link has source_memory_id = the derivative,
// target_memory_id = the source it was produced from.

// Primary captures: a source IS the thing (an article, a video, an email), not
// an enrichment of something else. Lineage only flows from a *note-like*
// derivative (an Obsidian analysis, a manual note) TO a primary source. A
// primary→primary back-reference is a citation or a sibling re-capture (web
// hyperlinks web, an email links an article, the same video transcribed twice) —
// not enrichment lineage, so we don't record it as derived_from.
const PRIMARY_SOURCES = new Set(["web", "youtube", "firecrawl", "blogwatcher", "mail"]);
const isPrimary = (source?: string | null) => !!source && PRIMARY_SOURCES.has(source);

// YouTube video ids only when they appear in a real URL context (avoids matching
// the date "2026-05-26-" which is also 11 url-safe chars).
const YT_RE =
  /(?:youtube\.com\/(?:watch\?(?:[^\s&]*&)*v=|embed\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/gi;
const URL_RE = /https?:\/\/[^\s<>")\]]+/gi;

/** Strip scheme/www/query/fragment/trailing slash → lowercase host+path. */
export function normalizeUrl(u: string): string {
  return u
    .trim()
    .replace(/[).,'"\];]+$/, "")
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .split("#")[0]
    .split("?")[0]
    .replace(/\/+$/, "")
    .toLowerCase();
}

/**
 * Extract strong, deterministic identifiers from text: YouTube video ids and
 * normalized article URLs. Returns plain substring needles usable against either
 * source_id or content. YouTube watch URLs collapse to their video id (a generic
 * "youtube.com/watch" needle would match everything), and bare-host needles are
 * dropped as too broad.
 */
export function extractRefs(text: string): string[] {
  if (!text) return [];
  const out = new Set<string>();
  for (const m of text.matchAll(YT_RE)) out.add(m[1]);
  for (const m of text.matchAll(URL_RE)) {
    const n = normalizeUrl(m[0]);
    if (!n.includes("/")) continue; // bare host — too generic
    if (/^(m\.)?youtu(be\.com|\.be)\b/.test(n)) continue; // covered by video id
    if (n.length >= 8) out.add(n);
  }
  return [...out];
}

/**
 * Record (or promote to) a directional derived_from link. Idempotent: an
 * existing derived_from is left alone; any pre-existing `similar` link(s) between
 * the pair are collapsed into the single canonical derived_from row, carrying the
 * embedding similarity straight from the stored vectors (no service call).
 * Returns the action taken, or null if skipped.
 */
async function linkDerived(
  derivativeId: string,
  sourceId: string,
): Promise<"created" | "promoted" | "exists" | null> {
  if (derivativeId === sourceId) return null;

  // Already linked this direction → nothing to do.
  const fwd = await pg`
    SELECT 1 FROM memory_links
    WHERE relationship = 'derived_from'
      AND source_memory_id = ${derivativeId} AND target_memory_id = ${sourceId}
    LIMIT 1`;
  if (fwd.length) return "exists";

  // Already linked the *other* way (conflicting lineage) → leave it; don't cycle.
  const rev = await pg`
    SELECT 1 FROM memory_links
    WHERE relationship = 'derived_from'
      AND source_memory_id = ${sourceId} AND target_memory_id = ${derivativeId}
    LIMIT 1`;
  if (rev.length) return null;

  // Collapse any undirected similar link(s) between the pair into one derived_from.
  const hadSimilar = await pg`
    DELETE FROM memory_links
    WHERE relationship <> 'derived_from'
      AND ((source_memory_id = ${derivativeId} AND target_memory_id = ${sourceId})
        OR (source_memory_id = ${sourceId} AND target_memory_id = ${derivativeId}))
    RETURNING id`;

  await pg`
    INSERT INTO memory_links (source_memory_id, target_memory_id, similarity, relationship)
    SELECT ${derivativeId}, ${sourceId},
           COALESCE(1 - (d.embedding <=> s.embedding), 0)::real, 'derived_from'
    FROM memories d, memories s
    WHERE d.id = ${derivativeId} AND s.id = ${sourceId}`;

  recordAudit({
    memoryId: derivativeId,
    action: "link_derived",
    actor: "system",
    diff: { derivedFrom: sourceId, promotedFromSimilar: hadSimilar.length > 0 },
  }).catch(() => {});

  return hadSimilar.length ? "promoted" : "created";
}

export interface LineageInput {
  memoryId: string;
  content: string;
  source?: string | null;
  sourceId?: string | null;
}

/**
 * Detect and record lineage for a freshly stored (or backfilled) memory, in both
 * ingest orders:
 *   A. Incoming is the *derivative* — its content carries a back-reference whose
 *      id is encoded in some existing source's source_id. Link incoming → source.
 *   B. Incoming is the *source* — an already-stored derivative's content carries a
 *      back-reference to this memory's id. Link that derivative → incoming.
 * Returns the number of derived_from links created/promoted.
 */
export async function detectLineage(
  input: LineageInput,
  opts: { reverse?: boolean } = {},
): Promise<number> {
  // `reverse` (Direction B) does content full-scans to find already-stored
  // derivatives of an incoming source. It's needed on live ingest (a source can
  // arrive after its derivative) but is redundant — and O(n²) — during a full
  // backfill, where every derivative is processed and finds its source via
  // Direction A. Backfill passes { reverse: false }.
  const reverse = opts.reverse ?? true;
  const { memoryId, content } = input;
  const source = input.source ?? null;
  const sourceId = input.sourceId ?? null;
  try {
    const needles = extractRefs(content);
    if (sourceId && /^https?:\/\//i.test(sourceId)) {
      const su = normalizeUrl(sourceId);
      if (su.includes("/")) needles.push(su);
    }
    if (needles.length === 0) return 0;

    const lc = (s: string) => s.toLowerCase();
    const sourceIdLc = sourceId ? lc(sourceId) : "";
    // "Owned" needles are encoded in this memory's own source_id → this memory is
    // the source for them. The rest are back-references → this memory is a derivative.
    const owned = needles.filter((n) => sourceIdLc && sourceIdLc.includes(lc(n)));
    const backRefs = needles.filter((n) => !owned.includes(n));

    let count = 0;

    // Direction A: incoming is the derivative. Only note-like memories are
    // enrichments; a primary capture (an article/video/email) is never a
    // derivative of something it links to. Find every primary source whose
    // source_id encodes the back-referenced id and link to each — a source can
    // have several sibling captures (e.g. the same video transcribed twice), and
    // the derivative derives from all of them, so all those pairs collapse out of
    // the duplicates view rather than just one.
    if (!isPrimary(source)) {
      for (const needle of backRefs) {
        const srcs = await pg`
          SELECT id FROM memories
          WHERE deleted_at IS NULL AND id <> ${memoryId}
            AND source = ANY(${[...PRIMARY_SOURCES]})
            AND source_id IS NOT NULL
            AND strpos(lower(source_id), ${lc(needle)}) > 0
          LIMIT 25`;
        for (const src of srcs) {
          const r = await linkDerived(memoryId, src.id as string);
          if (r === "created" || r === "promoted") count++;
        }
      }
    }

    // Direction B: incoming is a primary source. Find already-stored note-like
    // derivatives whose content references this memory's id but that don't
    // themselves own it (so we skip sibling re-captures of the same source).
    for (const needle of reverse && isPrimary(source) ? owned : []) {
      const derivs = await pg`
        SELECT id FROM memories
        WHERE deleted_at IS NULL AND id <> ${memoryId}
          AND (source IS NULL OR source <> ALL(${[...PRIMARY_SOURCES]}))
          AND strpos(lower(content), ${lc(needle)}) > 0
          AND (source_id IS NULL OR strpos(lower(source_id), ${lc(needle)}) = 0)
        LIMIT 25`;
      for (const d of derivs) {
        const r = await linkDerived(d.id as string, memoryId);
        if (r === "created" || r === "promoted") count++;
      }
    }

    if (count > 0) {
      console.log(`[lineage] ${memoryId.slice(0, 8)}… recorded ${count} derived_from link(s)`);
    }
    return count;
  } catch (err) {
    console.error(`[lineage] failed for ${memoryId}:`, err instanceof Error ? err.message : err);
    return 0;
  }
}
