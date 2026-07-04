import { z } from "zod";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { memories } from "../db/schema.js";
import { recordAudit } from "../services/audit.js";

export const ReviewMemorySchema = z.object({
  id: z.string().uuid().describe("The memory UUID to review"),
  action: z
    .enum([
      "confirm",
      "evidence_only",
      "reject",
      "restrict_scope",
      "mark_stale",
      "dispute",
      "supersede",
    ])
    .describe(
      "Review action. 'confirm' promotes the memory to instruction-grade (user_confirmed); " +
        "'evidence_only' keeps it as evidence; 'reject' disables it; 'supersede' requires relatedId."
    ),
  notes: z.string().optional().describe("Optional reviewer notes (recorded in the audit log)"),
  relatedId: z
    .string()
    .uuid()
    .optional()
    .describe("For 'supersede': the older memory UUID this one replaces"),
});

export type ReviewMemoryInput = z.infer<typeof ReviewMemorySchema>;

// Each action's effect on the trust-ladder columns. `confirm` is the only action
// that may set can_use_as_instruction=true, and it sets provenance_status in the
// same update so the chk_memories_instruction_grade CHECK is satisfied.
type Patch = Partial<typeof memories.$inferInsert>;

function patchFor(action: ReviewMemoryInput["action"]): Patch {
  switch (action) {
    case "confirm":
      return {
        reviewStatus: "confirmed",
        provenanceStatus: "user_confirmed",
        canUseAsInstruction: true,
        canUseAsEvidence: true,
        requiresUserConfirmation: false,
      };
    case "evidence_only":
      return { reviewStatus: "evidence_only", canUseAsInstruction: false, canUseAsEvidence: true };
    case "reject":
      return { reviewStatus: "rejected", canUseAsInstruction: false, canUseAsEvidence: false };
    case "restrict_scope":
      return { reviewStatus: "restricted", visibility: "restricted" };
    case "mark_stale":
      return { reviewStatus: "stale" };
    case "dispute":
      return { provenanceStatus: "disputed", canUseAsInstruction: false };
    case "supersede":
      return { reviewStatus: "merged" };
  }
}

export interface ReviewMemoryOptions {
  // Who is reviewing. Server-side context (MCP passes "agent", the UI passes
  // "user") — recorded in the audit log so an agent-driven confirm is
  // distinguishable from a human one.
  actor?: "user" | "agent" | "system";
}

export async function reviewMemory(input: ReviewMemoryInput, opts: ReviewMemoryOptions = {}) {
  const actor = opts.actor ?? "user";
  const [existing] = await db
    .select({ id: memories.id, reviewStatus: memories.reviewStatus })
    .from(memories)
    .where(and(eq(memories.id, input.id), isNull(memories.deletedAt)))
    .limit(1);
  if (!existing) return { error: "Memory not found" };

  const patch = patchFor(input.action);

  if (input.action === "supersede") {
    if (!input.relatedId) {
      return { error: "'supersede' requires relatedId (the older memory being replaced)" };
    }
    if (input.relatedId === input.id) {
      return { error: "A memory cannot supersede itself" };
    }
    // Validate the target exists and is live before mutating either row, so we
    // don't leave a dangling supersedes pointer or audit a non-memory.
    const [target] = await db
      .select({ id: memories.id })
      .from(memories)
      .where(and(eq(memories.id, input.relatedId), isNull(memories.deletedAt)))
      .limit(1);
    if (!target) return { error: "supersede target (relatedId) not found" };

    // This memory supersedes the older one: point at it, and mark the older one
    // superseded so it is no longer auto-injected.
    patch.supersedes = input.relatedId;
    await db
      .update(memories)
      .set({ provenanceStatus: "superseded", reviewStatus: "merged", updatedAt: new Date() })
      .where(eq(memories.id, input.relatedId));
    recordAudit({
      memoryId: input.relatedId,
      action: "supersede",
      actor,
      diff: { supersededBy: input.id, notes: input.notes ?? null },
    }).catch(() => {});
  }

  const [row] = await db
    .update(memories)
    // Any completed review clears the pending-confirmation flag — a human has
    // now acted on this memory regardless of which action they chose.
    .set({ ...patch, requiresUserConfirmation: false, updatedAt: new Date() })
    .where(eq(memories.id, input.id))
    .returning({
      id: memories.id,
      reviewStatus: memories.reviewStatus,
      provenanceStatus: memories.provenanceStatus,
      canUseAsInstruction: memories.canUseAsInstruction,
    });

  recordAudit({
    memoryId: input.id,
    action: "review",
    actor,
    diff: { action: input.action, from: existing.reviewStatus, notes: input.notes ?? null },
  }).catch(() => {});

  return row;
}
