import { z } from "zod";
import { eq, isNull, isNotNull, and } from "drizzle-orm";
import { db, pg } from "../db/client.js";
import { memories } from "../db/schema.js";
import { recordAudit } from "../services/audit.js";
import { linkRelatedMemories } from "../services/linking.js";

export const DeleteMemorySchema = z.object({
  id: z.string().uuid().describe("The memory UUID to soft-delete"),
});

export async function deleteMemory(
  input: z.infer<typeof DeleteMemorySchema>,
  opts?: { actor?: string; reason?: string },
) {
  const [row] = await db
    .update(memories)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(memories.id, input.id), isNull(memories.deletedAt)))
    .returning({ id: memories.id });

  if (!row) return { error: "Memory not found" };

  recordAudit({
    memoryId: row.id,
    action: "delete",
    actor: opts?.actor ?? "user",
    diff: opts?.reason ? { reason: opts.reason } : {},
  }).catch(() => {});

  // Similarity links to a deleted memory are dead weight every query filters
  // around; they're recomputable, so drop them now (restore re-links). Lineage
  // (derived_from) is kept — it's history. Best-effort, like the audit write.
  pg`
    DELETE FROM memory_links
    WHERE relationship <> 'derived_from'
      AND (source_memory_id = ${row.id} OR target_memory_id = ${row.id})
    RETURNING id
  `
    .then((removed) => {
      if (removed.length) {
        recordAudit({
          memoryId: row.id,
          action: "unlink",
          actor: opts?.actor ?? "user",
          diff: { reason: "memory deleted", count: removed.length },
        }).catch(() => {});
      }
    })
    .catch(() => {});

  return { id: row.id, deleted: true };
}

/** Undo a soft-delete. Only touches rows that are currently deleted. */
export async function restoreMemory(
  input: z.infer<typeof DeleteMemorySchema>,
  opts?: { actor?: string; reason?: string },
) {
  const [row] = await db
    .update(memories)
    .set({ deletedAt: null, updatedAt: new Date() })
    .where(and(eq(memories.id, input.id), isNotNull(memories.deletedAt)))
    .returning({ id: memories.id });

  if (!row) return { error: "Memory not found or not deleted" };

  recordAudit({
    memoryId: row.id,
    action: "restore",
    actor: opts?.actor ?? "user",
    diff: opts?.reason ? { reason: opts.reason } : {},
  }).catch(() => {});

  // Deletion dropped this memory's similarity links; recompute them.
  linkRelatedMemories(row.id).catch(() => {});

  return { id: row.id, restored: true };
}
