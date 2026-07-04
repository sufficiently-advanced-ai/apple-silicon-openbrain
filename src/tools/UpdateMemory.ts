import { z } from "zod";
import { eq, isNull, and } from "drizzle-orm";
import { db } from "../db/client.js";
import { memories } from "../db/schema.js";
import { getEmbedding } from "../services/embedding.js";
import { setCachedEmbedding } from "../services/cache.js";
import { queueEnrichment } from "../services/enrichment.js";
import { contentFingerprint } from "../services/fingerprint.js";
import { recordAudit } from "../services/audit.js";

export const UpdateMemorySchema = z.object({
  id: z.string().uuid().describe("The memory UUID to update"),
  content: z.string().optional().describe("New content (will re-embed and re-enrich)"),
  memoryType: z
    .enum(["conversation", "decision", "learning", "fact"])
    .optional()
    .describe("Updated type"),
  tags: z.array(z.string()).optional().describe("Replace tags"),
  entities: z.record(z.array(z.string())).optional().describe("Replace entities"),
});

export interface UpdateMemoryOptions {
  // Who is making this update. Server-side context (MCP passes "agent", the UI
  // passes "user") — never part of the public input schema.
  actor?: "user" | "agent" | "system";
}

export async function updateMemory(
  input: z.infer<typeof UpdateMemorySchema>,
  opts: UpdateMemoryOptions = {},
) {
  const actor = opts.actor ?? "user";
  const updates: Record<string, unknown> = { updatedAt: new Date() };

  const [existing] = await db
    .select({
      id: memories.id,
      reviewStatus: memories.reviewStatus,
      canUseAsInstruction: memories.canUseAsInstruction,
    })
    .from(memories)
    .where(and(eq(memories.id, input.id), isNull(memories.deletedAt)))
    .limit(1);
  if (!existing) return { error: "Memory not found" };

  // Trust-ladder guard: a non-user content rewrite of confirmed/instruction-
  // grade memory demotes it back to pending review. Without this, an agent
  // could replace the content of a user-confirmed rule wholesale while the row
  // kept can_use_as_instruction=true.
  const demoted =
    input.content !== undefined &&
    actor !== "user" &&
    (existing.canUseAsInstruction || existing.reviewStatus === "confirmed");

  if (input.content !== undefined) {
    const embedding = await getEmbedding(input.content);
    await setCachedEmbedding(input.content, embedding);
    updates.content = input.content;
    updates.embedding = embedding;
    // Keep the advisory dedup key in sync with the new content.
    updates.contentFingerprint = contentFingerprint(input.content);
  }
  if (demoted) {
    updates.reviewStatus = "pending";
    updates.canUseAsInstruction = false;
    updates.provenanceStatus = "generated";
    updates.requiresUserConfirmation = true;
  }
  if (input.memoryType !== undefined) updates.memoryType = input.memoryType;
  if (input.tags !== undefined) updates.tags = input.tags;
  if (input.entities !== undefined) updates.entities = input.entities;

  const [row] = await db
    .update(memories)
    .set(updates)
    .where(and(eq(memories.id, input.id), isNull(memories.deletedAt)))
    .returning({ id: memories.id, updatedAt: memories.updatedAt });

  if (!row) return { error: "Memory not found" };

  recordAudit({
    memoryId: row.id,
    action: "update",
    actor,
    diff: {
      contentChanged: input.content !== undefined,
      demoted,
      memoryType: input.memoryType,
      tags: input.tags,
      entities: input.entities,
    },
  }).catch(() => {});

  // Re-enrich if content changed (serial queue — see enrichment.ts)
  if (input.content) {
    queueEnrichment(row.id, input.content);
  }

  // Surface the demotion so an agent caller knows the memory now needs
  // ReviewMemory 'confirm' again.
  return demoted ? { ...row, demoted: true as const } : row;
}
