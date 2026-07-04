import { z } from "zod";
import { eq, isNull, and, or, notInArray, desc, arrayContains, type SQL } from "drizzle-orm";
import { db } from "../db/client.js";
import { memories } from "../db/schema.js";

export const ListMemoriesSchema = z.object({
  limit: z.number().min(1).max(100).optional().default(20).describe("Max results"),
  offset: z.number().min(0).optional().default(0).describe("Pagination offset"),
  memoryType: z
    .enum(["conversation", "decision", "learning", "fact"])
    .optional()
    .describe("Filter by type"),
  source: z
    .string()
    .optional()
    .describe("Filter by source (e.g. claude-code, manual, web, youtube)"),
  tags: z.array(z.string()).optional().describe("Filter by tags"),
  includeRejected: z
    .boolean()
    .optional()
    .default(false)
    .describe("Include rejected/superseded/disputed memories (excluded by default)"),
});

export async function listMemories(input: z.infer<typeof ListMemoriesSchema>) {
  const conditions: (SQL | undefined)[] = [isNull(memories.deletedAt)];

  if (input.memoryType) conditions.push(eq(memories.memoryType, input.memoryType));
  if (input.source) conditions.push(eq(memories.source, input.source));
  if (input.tags?.length) conditions.push(arrayContains(memories.tags, input.tags));
  // Hide memories a human has rejected, superseded, or disputed unless asked.
  // NULL governance (historical rows) always passes — mirrors SearchMemory.
  if (!input.includeRejected) {
    conditions.push(
      or(isNull(memories.reviewStatus), notInArray(memories.reviewStatus, ["rejected"]))
    );
    conditions.push(
      or(
        isNull(memories.provenanceStatus),
        notInArray(memories.provenanceStatus, ["superseded", "disputed"])
      )
    );
  }

  // Fetch one past the page so callers can tell whether another page exists
  // without a second probing call.
  const rows = await db
    .select({
      id: memories.id,
      content: memories.content,
      summary: memories.summary,
      source: memories.source,
      memoryType: memories.memoryType,
      tags: memories.tags,
      createdAt: memories.createdAt,
    })
    .from(memories)
    .where(and(...conditions))
    .orderBy(desc(memories.createdAt))
    .limit(input.limit + 1)
    .offset(input.offset);

  const hasMore = rows.length > input.limit;
  const page = hasMore ? rows.slice(0, input.limit) : rows;
  return { memories: page, count: page.length, hasMore };
}
