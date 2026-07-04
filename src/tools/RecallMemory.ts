import { z } from "zod";
import { eq, isNull, and } from "drizzle-orm";
import { db, pg } from "../db/client.js";
import { memories } from "../db/schema.js";

export const RecallMemorySchema = z.object({
  id: z.string().uuid().describe("The memory UUID to retrieve"),
});

export async function recallMemory(input: z.infer<typeof RecallMemorySchema>) {
  const [row] = await db
    .select({
      id: memories.id,
      content: memories.content,
      summary: memories.summary,
      source: memories.source,
      sourceId: memories.sourceId,
      memoryType: memories.memoryType,
      tags: memories.tags,
      entities: memories.entities,
      createdAt: memories.createdAt,
      updatedAt: memories.updatedAt,
      sourceDate: memories.sourceDate,
      // Governance / trust-ladder columns — surfaced for the Detail view.
      provenanceStatus: memories.provenanceStatus,
      reviewStatus: memories.reviewStatus,
      createdBy: memories.createdBy,
      confidence: memories.confidence,
      canUseAsInstruction: memories.canUseAsInstruction,
      canUseAsEvidence: memories.canUseAsEvidence,
      requiresUserConfirmation: memories.requiresUserConfirmation,
      visibility: memories.visibility,
      supersedes: memories.supersedes,
    })
    .from(memories)
    .where(and(eq(memories.id, input.id), isNull(memories.deletedAt)));

  if (!row) return { error: "Memory not found" };

  // Lineage (derived_from links) for the Detail view. `derivedFrom` are the
  // source(s) this memory was produced from; `derivatives` are notes produced
  // from this memory. Best-effort — never fail the recall over the links table.
  let derivedFrom: LineageRef[] = [];
  let derivatives: LineageRef[] = [];
  try {
    derivedFrom = (await pg`
      SELECT l.target_memory_id AS id, l.similarity, m.summary, m.source,
             m.source_id AS "sourceId", left(m.content, 240) AS snippet
      FROM memory_links l
      JOIN memories m ON m.id = l.target_memory_id AND m.deleted_at IS NULL
      WHERE l.relationship = 'derived_from' AND l.source_memory_id = ${input.id}
      ORDER BY l.similarity DESC`) as unknown as LineageRef[];
    derivatives = (await pg`
      SELECT l.source_memory_id AS id, l.similarity, m.summary, m.source,
             m.source_id AS "sourceId", left(m.content, 240) AS snippet
      FROM memory_links l
      JOIN memories m ON m.id = l.source_memory_id AND m.deleted_at IS NULL
      WHERE l.relationship = 'derived_from' AND l.target_memory_id = ${input.id}
      ORDER BY l.similarity DESC`) as unknown as LineageRef[];
  } catch {
    // Links table may not exist yet — graceful degradation.
  }

  return { ...row, derivedFrom, derivatives };
}

interface LineageRef {
  id: string;
  similarity: number;
  summary: string | null;
  source: string | null;
  sourceId: string | null;
  snippet: string;
}
