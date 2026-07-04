import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { memories } from "../db/schema.js";
import { getEmbedding } from "../services/embedding.js";
import { getCachedEmbedding, setCachedEmbedding } from "../services/cache.js";
import { queueEnrichment } from "../services/enrichment.js";
import { linkRelatedMemories } from "../services/linking.js";
import { detectLineage } from "../services/lineage.js";
import { contentFingerprint } from "../services/fingerprint.js";
import { recordAudit } from "../services/audit.js";

export const StoreMemorySchema = z.object({
  content: z.string().describe("The text content to store as a memory"),
  source: z
    .string()
    .optional()
    .describe("Where this memory came from (e.g. claude-code, manual, web, youtube, import)"),
  sourceId: z.string().optional().describe("External identifier from the source"),
  memoryType: z
    .enum(["conversation", "decision", "learning", "fact"])
    .optional()
    .describe("Classification of the memory"),
  tags: z.array(z.string()).optional().describe("Tags for categorization"),
  entities: z
    .record(z.array(z.string()))
    .optional()
    .describe("Named entities: { person: [...], tech: [...], ... }"),
  sourceDate: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), "must be an ISO 8601 date")
    .optional()
    .describe(
      "ISO date the content was originally created/published (article date, video upload, email date) — distinct from when it is stored",
    ),
});

export type StoreMemoryInput = z.infer<typeof StoreMemorySchema>;

// Trusted, server-side-only governance context. These are deliberately NOT part
// of StoreMemorySchema (the public MCP input shape) — exposing them would let any
// caller mark a write as "import" to skip the review queue. Only trusted internal
// callers (ingest, mail, compat capture) pass these.
export interface StoreMemoryOptions {
  enrich?: boolean;
  createdBy?: "user" | "agent" | "system" | "import";
  provenanceStatus?: "observed" | "inferred" | "user_confirmed" | "imported" | "generated";
  confidence?: number;
  // Forward-compat scope passthrough (single-user today; no enforcement).
  workspaceId?: string;
  projectId?: string;
  visibility?: string;
}

export async function storeMemory(input: StoreMemoryInput, opts: StoreMemoryOptions = {}) {
  const enrich = opts.enrich ?? true;

  // Derive governance defaults. Core rule: agent-written memory enters as
  // *evidence*, not *instruction* — only an explicit human review (ReviewMemory)
  // promotes it to instruction-grade. Provenance/createdBy come from trusted
  // server-side context (opts), never from the public tool input.
  const createdBy = opts.createdBy ?? "agent";
  const provenanceStatus =
    opts.provenanceStatus ?? (createdBy === "import" ? "imported" : "generated");
  // Imported/system content isn't part of the human review queue; agent/user
  // writes start pending review.
  const reviewStatus = createdBy === "agent" || createdBy === "user" ? "pending" : null;
  const requiresUserConfirmation = createdBy === "agent" || createdBy === "user";

  const fingerprint = contentFingerprint(input.content);

  // Advisory content dedup for freeform captures (no external sourceId). URL/mail
  // memories already dedup on (source, source_id); this catches identical agent
  // captures that arrive without a sourceId.
  if (!input.sourceId) {
    const [dupe] = await db
      .select({ id: memories.id, createdAt: memories.createdAt })
      .from(memories)
      .where(and(eq(memories.contentFingerprint, fingerprint), isNull(memories.deletedAt)))
      .limit(1);
    if (dupe) return { id: dupe.id, createdAt: dupe.createdAt, deduped: true as const };
  }

  // Get embedding (check cache first)
  let embedding = await getCachedEmbedding(input.content);
  if (!embedding) {
    embedding = await getEmbedding(input.content);
    await setCachedEmbedding(input.content, embedding);
  }

  const [row] = await db
    .insert(memories)
    .values({
      content: input.content,
      embedding,
      source: input.source ?? null,
      sourceId: input.sourceId ?? null,
      memoryType: input.memoryType ?? null,
      tags: input.tags ?? [],
      entities: input.entities ?? {},
      sourceDate: input.sourceDate ? new Date(input.sourceDate) : null,
      contentFingerprint: fingerprint,
      createdBy,
      provenanceStatus,
      confidence: opts.confidence ?? null,
      reviewStatus,
      requiresUserConfirmation,
      workspaceId: opts.workspaceId ?? null,
      projectId: opts.projectId ?? null,
      visibility: opts.visibility ?? null,
    })
    // Backstop against the SELECT-then-INSERT dedup race: if a concurrent run
    // already inserted this (source, source_id), the partial unique index makes
    // this a no-op instead of a duplicate row.
    .onConflictDoNothing()
    .returning({ id: memories.id, createdAt: memories.createdAt });

  // No row returned => a concurrent insert won the race. Return the existing row
  // and skip enrichment/linking, which already ran (or will run) for the winner.
  if (!row) {
    const [existing] = await db
      .select({ id: memories.id, createdAt: memories.createdAt })
      .from(memories)
      .where(
        and(
          // Drizzle's eq(col, null) emits `= NULL` (never matches). Use isNull
          // for the null case so the race-lost fallback resolves correctly.
          input.source == null ? isNull(memories.source) : eq(memories.source, input.source),
          input.sourceId == null
            ? isNull(memories.sourceId)
            : eq(memories.sourceId, input.sourceId),
          isNull(memories.deletedAt),
        ),
      )
      .limit(1);
    if (!existing) throw new Error("insert conflicted but no existing row found");
    return { id: existing.id, createdAt: existing.createdAt };
  }

  // Append-only audit (fire-and-forget).
  recordAudit({
    memoryId: row.id,
    action: "capture",
    source: input.source ?? null,
    actor: createdBy,
    diff: { provenanceStatus, reviewStatus, memoryType: input.memoryType ?? null },
  }).catch(() => {});

  // Fire-and-forget enrichment via mlx-lm (skipped during bulk imports).
  // Serialized through queueEnrichment — RSS/webpage sync bursts used to fire
  // dozens of concurrent LLM calls and time most of them out (see enrichment.ts).
  if (enrich) {
    queueEnrichment(row.id, input.content);
  }

  // Fire-and-forget cross-memory linking, then lineage detection. Lineage runs
  // after linking so it can promote a just-created `similar` link into a
  // directional `derived_from` when this memory is a source/derivative pair.
  linkRelatedMemories(row.id)
    .then(() =>
      detectLineage({
        memoryId: row.id,
        content: input.content,
        source: input.source,
        sourceId: input.sourceId,
      }),
    )
    .catch(() => {});

  return { id: row.id, createdAt: row.createdAt };
}
