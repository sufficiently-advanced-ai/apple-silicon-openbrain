import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { memories } from "../db/schema.js";
import { config } from "../lib/config.js";

const SYSTEM_PROMPT = `You are a metadata extraction service. You ALWAYS respond with valid JSON only, no thinking, no explanation.`

const ENRICHMENT_PROMPT = `Extract metadata from the following text. Return ONLY a JSON object with these keys:
- "summary": 1-2 sentence summary
- "tags": array of 2-5 lowercase topic tags (no spaces)
- "entities": object with keys "person", "org", "tech", "concept", "location" mapping to arrays of names

Text:
`;

// Cap content sent to the LLM. Long Obsidian sections can tokenize to 10k+
// tokens and OOM the Metal GPU; summary/tag extraction only needs the first
// few paragraphs to be useful.
const MAX_ENRICH_CHARS = 4000;

// Scraped markdown is front-loaded with boilerplate: image URLs (CDN params
// like w1440-h810-n-nu), nav/share links, and inline HTML. Sent raw, that
// noise dominates the 4000-char budget and the model tags the chrome instead
// of the article. Strip it down to prose before truncating.
export function cleanForEnrichment(content: string): string {
  return (
    content
      // markdown images (incl. nested in links): drop entirely
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      // markdown links: keep anchor text, drop URL
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      // reference-style link definitions
      .replace(/^\s*\[[^\]]+\]:\s+\S+.*$/gm, "")
      // bare URLs
      .replace(/https?:\/\/\S+/g, "")
      // inline HTML tags
      .replace(/<\/?[a-zA-Z][^>]*>/g, "")
      // collapse runs of blank lines / whitespace
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

const ENRICH_TIMEOUT_MS = 60_000;
const RETRY_DELAY_MS = 2_000;

interface EnrichmentFields {
  summary: string | null;
  tags: string[];
  entities: Record<string, string[]>;
}

// The LLM's JSON is not trusted shape-wise: tags can come back as a string,
// entities values as scalars, etc. Keep only well-typed parts so malformed
// output degrades to "less enrichment" instead of dirty rows or PG type errors.
function sanitizeEnrichment(raw: unknown): EnrichmentFields | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const summary =
    typeof obj.summary === "string" && obj.summary.trim() ? obj.summary.trim() : null;
  const tags = Array.isArray(obj.tags)
    ? obj.tags.filter((t): t is string => typeof t === "string" && t.trim() !== "")
    : [];
  const entities: Record<string, string[]> = {};
  if (typeof obj.entities === "object" && obj.entities !== null && !Array.isArray(obj.entities)) {
    for (const [key, value] of Object.entries(obj.entities as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        const strings = value.filter((v): v is string => typeof v === "string");
        if (strings.length) entities[key] = strings;
      }
    }
  }
  return { summary, tags, entities };
}

async function postEnrichment(body: string): Promise<Response> {
  return fetch(`${config.llmUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(ENRICH_TIMEOUT_MS),
  });
}

export async function enrichMemory(memoryId: string, content: string): Promise<void> {
  if (process.env.DISABLE_ENRICHMENT === "true") return;
  const cleaned = cleanForEnrichment(content);
  const truncated =
    cleaned.length > MAX_ENRICH_CHARS
      ? cleaned.slice(0, MAX_ENRICH_CHARS) + "\n\n[...truncated for enrichment...]"
      : cleaned;

  const body = JSON.stringify({
    model: config.llmModel,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: ENRICHMENT_PROMPT + truncated },
    ],
    temperature: 0.1,
    max_tokens: 1024,
    // Qwen3.x are reasoning models. /no_think is a no-op; this is the switch
    // that actually suppresses the chain-of-thought. Without it, reasoning
    // exhausts the 1024-token budget and content comes back empty.
    chat_template_kwargs: { enable_thinking: false },
  });

  let res: Response;
  try {
    res = await postEnrichment(body);
  } catch (err) {
    // Network/timeout/abort — single retry. Deterministic errors (4xx, JSON
    // parse) are not retried below.
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    res = await postEnrichment(body);
  }

  if (res.status >= 500) {
    // Server-side transient — retry once.
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    res = await postEnrichment(body);
  }

  if (!res.ok) {
    throw new Error(`Enrichment LLM HTTP ${res.status}`);
  }

  const data = (await res.json()) as {
    choices: { message: { content: string } }[];
  };

  let raw = data.choices[0]?.message?.content ?? "";
  // Strip <think>...</think> blocks from Qwen3 reasoning
  raw = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  // Extract JSON from potential markdown code blocks
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.error("[enrichment] no JSON found in response");
    return;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(jsonMatch[0]);
  } catch {
    console.error("[enrichment] response JSON failed to parse, skipping");
    return;
  }
  const parsed = sanitizeEnrichment(parsedJson);
  if (!parsed) {
    console.error("[enrichment] response JSON was not an object, skipping");
    return;
  }

  // Merge with what the row already carries instead of clobbering it —
  // caller-supplied tags (Gmail labels, manual tags) and entities used to be
  // wiped by every enrichment pass. Also re-check deleted_at: the row may have
  // been soft-deleted while this job sat in the queue.
  const [existing] = await db
    .select({ summary: memories.summary, tags: memories.tags, entities: memories.entities })
    .from(memories)
    .where(and(eq(memories.id, memoryId), isNull(memories.deletedAt)))
    .limit(1);
  if (!existing) return;

  const mergedTags = [...new Set([...(existing.tags ?? []), ...parsed.tags])];
  const existingEntities =
    typeof existing.entities === "object" && existing.entities !== null
      ? (existing.entities as Record<string, string[]>)
      : {};
  const mergedEntities: Record<string, string[]> = { ...existingEntities };
  for (const [key, values] of Object.entries(parsed.entities)) {
    const prior = Array.isArray(mergedEntities[key]) ? mergedEntities[key] : [];
    mergedEntities[key] = [...new Set([...prior, ...values])];
  }

  await db
    .update(memories)
    .set({
      summary: parsed.summary ?? existing.summary,
      tags: mergedTags,
      entities: mergedEntities,
      updatedAt: new Date(),
    })
    .where(and(eq(memories.id, memoryId), isNull(memories.deletedAt)));
}

// ---------------------------------------------------------------------------
// Serial enrichment queue.
//
// Ingest bursts (RSS digest runs ingest dozens of URLs back-to-back) used to
// fire enrichMemory() concurrently — every call landed on the single-GPU
// mlx-lm server at once, queue wait blew past ENRICH_TIMEOUT_MS, and most of
// the batch silently failed (rows left with summary=null, tags=[]). Same
// reason enrich-backlog.ts runs at concurrency=1. This queue gives the live
// path the same discipline: one in-flight enrichment, FIFO, bounded.
// ---------------------------------------------------------------------------

const MAX_QUEUE_DEPTH = 500;
let queueDepth = 0;
let queueTail: Promise<void> = Promise.resolve();

/**
 * Enqueue an enrichment to run after all previously queued enrichments.
 * Fire-and-forget for callers; failures are logged, never thrown.
 */
export function queueEnrichment(memoryId: string, content: string): void {
  if (queueDepth >= MAX_QUEUE_DEPTH) {
    console.warn(
      `[enrich-queue] depth ${queueDepth} >= ${MAX_QUEUE_DEPTH}, dropping ${memoryId}. ` +
        `Run scripts/enrich-backlog.ts to sweep.`,
    );
    return;
  }
  queueDepth++;
  queueTail = queueTail
    .then(() => enrichMemory(memoryId, content))
    .catch((err) => {
      console.warn(
        `[enrich-queue] ${memoryId.slice(0, 8)} failed: ${err instanceof Error ? err.message : err}`,
      );
    })
    .finally(() => {
      queueDepth--;
    });
}

export function enrichmentQueueDepth(): number {
  return queueDepth;
}
