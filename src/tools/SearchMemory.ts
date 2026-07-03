import { z } from "zod";
import { pg } from "../db/client.js";
import { getEmbedding } from "../services/embedding.js";
import { getCachedEmbedding, setCachedEmbedding } from "../services/cache.js";

export const SearchMemorySchema = z.object({
  query: z.string().describe("Semantic search query"),
  limit: z.number().min(1).max(50).optional().default(10).describe("Max results"),
  memoryType: z
    .enum(["conversation", "decision", "learning", "fact"])
    .optional()
    .describe("Filter by memory type"),
  source: z
    .string()
    .optional()
    .describe("Filter by source (e.g. claude-code, manual, web, youtube)"),
  tags: z.array(z.string()).optional().describe("Filter by tags (AND)"),
  after: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), "must be an ISO 8601 date")
    .optional()
    .describe("Only memories after this ISO date (e.g. 2026-01-31 or 2026-01-31T12:00:00Z)"),
  before: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), "must be an ISO 8601 date")
    .optional()
    .describe("Only memories before this ISO date (e.g. 2026-01-31 or 2026-01-31T12:00:00Z)"),
  threshold: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Minimum cosine similarity (0..1). Results below this are dropped."),
  recencyWeight: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .default(0)
    .describe("0..1 blend of recency into ranking. 0 = pure similarity (default)."),
  halfLifeDays: z
    .number()
    .min(1)
    .optional()
    .default(90)
    .describe("Half-life (days) for the recency decay when recencyWeight > 0"),
  includeRejected: z
    .boolean()
    .optional()
    .default(false)
    .describe("Include rejected/superseded/disputed memories (excluded by default)"),
});

export type SearchMemoryInput = z.infer<typeof SearchMemorySchema>;

export async function searchMemory(input: SearchMemoryInput) {
  let embedding = await getCachedEmbedding(input.query);
  if (!embedding) {
    embedding = await getEmbedding(input.query);
    await setCachedEmbedding(input.query, embedding);
  }

  const vecLiteral = `[${embedding.join(",")}]`;

  const conditions: string[] = ["deleted_at IS NULL"];
  const values: unknown[] = [];
  let idx = 1;

  if (input.memoryType) {
    conditions.push(`memory_type = $${idx++}`);
    values.push(input.memoryType);
  }
  if (input.source) {
    conditions.push(`source = $${idx++}`);
    values.push(input.source);
  }
  if (input.tags?.length) {
    conditions.push(`tags @> $${idx++}::text[]`);
    values.push(input.tags);
  }
  if (input.after) {
    conditions.push(`created_at > $${idx++}::timestamptz`);
    values.push(input.after);
  }
  if (input.before) {
    conditions.push(`created_at < $${idx++}::timestamptz`);
    values.push(input.before);
  }
  // Hide memories a human has rejected, superseded, or disputed unless asked.
  // NULL governance (historical rows) always passes.
  if (!input.includeRejected) {
    conditions.push(`(review_status IS NULL OR review_status NOT IN ('rejected'))`);
    conditions.push(`(provenance_status IS NULL OR provenance_status NOT IN ('superseded', 'disputed'))`);
  }

  // Cosine similarity in [0,1]. Recency factor is a true half-life: it decays to
  // exactly 0.5 at halfLifeDays (hence the ln(2) factor — exp(-age/half) alone
  // would only reach ~0.37). Blended score = similarity*(1-w) + recency*w. With
  // w=0 (default) this reduces to pure similarity and ordering is unchanged.
  const w = input.recencyWeight ?? 0;
  const halfLife = input.halfLifeDays ?? 90;
  const simExpr = `1 - (embedding <=> '${vecLiteral}'::vector)`;
  const recencyExpr = `exp(- ln(2) * (EXTRACT(EPOCH FROM (now() - created_at)) / 86400.0) / ${halfLife})`;
  const scoreExpr = w > 0 ? `(${simExpr}) * ${1 - w} + (${recencyExpr}) * ${w}` : simExpr;

  if (input.threshold != null) {
    conditions.push(`(${simExpr}) >= $${idx++}`);
    values.push(input.threshold);
  }

  // Vector literal is safe — it's only floats from our embedding service.
  // Limit/weights are Zod-validated numbers.
  const query = `
    SELECT id, content, summary, source, source_id, memory_type, tags, entities,
           created_at, updated_at,
           provenance_status, review_status, can_use_as_instruction,
           created_by, confidence, visibility,
           ${simExpr} AS similarity,
           ${scoreExpr} AS score
    FROM memories
    WHERE ${conditions.join(" AND ")}
    ORDER BY score DESC
    LIMIT ${input.limit}
  `;

  const rows = values.length > 0
    ? await pg.unsafe(query, values as any[])
    : await pg.unsafe(query);

  const results = rows.map((r: any) => ({
    id: r.id,
    content: r.content,
    summary: r.summary,
    source: r.source,
    sourceId: r.source_id,
    memoryType: r.memory_type,
    tags: r.tags,
    entities: r.entities,
    similarity: Number(r.similarity),
    score: Number(r.score),
    provenanceStatus: r.provenance_status,
    reviewStatus: r.review_status,
    canUseAsInstruction: r.can_use_as_instruction,
    createdBy: r.created_by,
    confidence: r.confidence != null ? Number(r.confidence) : null,
    visibility: r.visibility,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    linkedMemories: [] as { id: string; similarity: number }[],
    // Lineage (derived_from links). A derivative carries `derivedFrom` pointers to
    // the source(s) it was produced from; a source carries `derivatives`.
    derivedFrom: [] as { id: string; similarity: number }[],
    derivatives: [] as { id: string; similarity: number }[],
  }));

  // Fetch linked memories for search results
  if (results.length > 0) {
    try {
      const ids = results.map((r: any) => r.id);
      const byId = new Map(results.map((r: any) => [r.id, r]));
      const links = await pg.unsafe(`
        SELECT source_memory_id, target_memory_id, similarity, relationship
        FROM memory_links
        WHERE source_memory_id = ANY($1) OR target_memory_id = ANY($1)
      `, [ids]);

      // Sources whose derivative is also in this page get collapsed: the
      // derivative is canonical (denser, decision-relevant) and the source rides
      // along as backing evidence, so the source drops out of the top-level list.
      const collapsed = new Set<string>();

      for (const link of links) {
        if (link.relationship === "derived_from") {
          // source_memory_id = derivative, target_memory_id = source
          const deriv = byId.get(link.source_memory_id);
          const src = byId.get(link.target_memory_id);
          if (deriv) deriv.derivedFrom.push({ id: link.target_memory_id, similarity: Number(link.similarity) });
          if (src) {
            src.derivatives.push({ id: link.source_memory_id, similarity: Number(link.similarity) });
            if (deriv) collapsed.add(src.id); // both in page → demote the source
          }
          continue;
        }
        // Plain similarity link: surface the other end only when it's off-page.
        for (const result of results) {
          if (link.source_memory_id === result.id && !ids.includes(link.target_memory_id)) {
            result.linkedMemories.push({ id: link.target_memory_id, similarity: Number(link.similarity) });
          } else if (link.target_memory_id === result.id && !ids.includes(link.source_memory_id)) {
            result.linkedMemories.push({ id: link.source_memory_id, similarity: Number(link.similarity) });
          }
        }
      }

      if (collapsed.size > 0) {
        return results.filter((r: any) => !collapsed.has(r.id));
      }
    } catch {
      // Links table may not exist yet — graceful degradation
    }
  }

  return results;
}
