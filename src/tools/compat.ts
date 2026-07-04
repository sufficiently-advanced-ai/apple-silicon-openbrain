/**
 * OB1 ("Open Brain") canonical MCP tool parity.
 *
 * Nate B. Jones's OB1 reference server (github.com/NateBJones-Projects/OB1)
 * exposes search / fetch / search_thoughts / list_thoughts / thought_stats /
 * capture_thought over a `thoughts` table whose metadata carries type/topics/
 * people. Companion skills, prompt packs, and ChatGPT connectors call those
 * exact tool names and parse their text/JSON output.
 *
 * These are thin translating aliases over our own tools + store. They bridge
 * field *names* (memoryType→type, tags→topics, entities.person→people) but do
 * NOT pretend the taxonomies are identical — our memoryType enum differs from
 * OB1's, so a filter that finds nothing returns nothing honestly.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sql } from "drizzle-orm";
import { db, pg } from "../db/client.js";
import { config } from "../lib/config.js";
import { searchMemory } from "./SearchMemory.js";
import { recallMemory } from "./RecallMemory.js";
import { storeMemory } from "./StoreMemory.js";

type TextResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const text = (t: string, isError = false): TextResult => ({
  content: [{ type: "text", text: t }],
  ...(isError ? { isError } : {}),
});

function thoughtTitle(content: string, createdAt?: string | Date): string {
  const firstLine = content.replace(/\s+/g, " ").trim().slice(0, 80);
  const datePrefix = createdAt ? new Date(createdAt).toLocaleDateString() : "OpenBrain";
  return firstLine ? `${datePrefix} - ${firstLine}` : `${datePrefix} memory`;
}

function thoughtUrl(id: string): string {
  return `${config.citationBaseUrl.replace(/\/$/, "")}/${id}`;
}

/** People list from our entities jsonb (OB1 carries this as metadata.people). */
function peopleOf(entities: unknown): string[] {
  const e = (entities ?? {}) as Record<string, unknown>;
  return Array.isArray(e.person) ? (e.person as string[]) : [];
}

export function registerCompatTools(server: McpServer): void {
  // --- ChatGPT compatibility: search / fetch ---
  server.tool(
    "search",
    "Search OpenBrain memories by meaning (OB1/ChatGPT-compatible). Read-only; returns id/title/url results for use with `fetch`.",
    { query: z.string().describe("The search query to run against OpenBrain memories") },
    async ({ query }) => {
      try {
        const rows = await searchMemory({
          query,
          limit: 10,
          recencyWeight: 0,
          halfLifeDays: 90,
          includeRejected: false,
        });
        const results = rows.map((r) => ({
          id: r.id,
          title: thoughtTitle(r.content, r.createdAt),
          url: thoughtUrl(r.id),
        }));
        return text(JSON.stringify({ results }));
      } catch (err) {
        return text(`Error: ${(err as Error).message}`, true);
      }
    }
  );

  const UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

  server.tool(
    "fetch",
    "Fetch one OpenBrain memory by ID after using `search` (OB1/ChatGPT-compatible). Read-only; returns full text and metadata for citation. Native callers get richer output (governance, lineage) from RecallMemory.",
    { id: z.string().describe("The OpenBrain memory ID (UUID) returned by `search`") },
    async ({ id }) => {
      try {
        if (!UUID_RE.test(id)) {
          return text(`Fetch error: '${id}' is not a memory ID — use the UUID returned by \`search\`.`, true);
        }
        const m = await recallMemory({ id });
        if ("error" in m) return text(`Fetch error: ${m.error}`, true);
        const document = {
          id: m.id,
          title: thoughtTitle(m.content, m.createdAt),
          text: m.content,
          url: thoughtUrl(m.id),
          metadata: {
            type: m.memoryType,
            topics: m.tags ?? [],
            people: peopleOf(m.entities),
            source: m.source,
            source_id: m.sourceId,
            created_at: m.createdAt,
            updated_at: m.updatedAt,
          },
        };
        return text(JSON.stringify(document));
      } catch (err) {
        return text(`Error: ${(err as Error).message}`, true);
      }
    }
  );

  // --- search_thoughts ---
  server.tool(
    "search_thoughts",
    "OB1-compatible alias returning text-formatted search results with a 0.5 similarity floor. Native callers should prefer SearchMemory (structured output, filters, no hidden threshold).",
    {
      query: z.string().describe("What to search for"),
      limit: z.number().int().min(1).max(50).optional().default(10).describe("Max results (1-50)"),
      threshold: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .default(0.5)
        .describe("Minimum cosine similarity (0..1); results below are dropped. Default 0.5"),
    },
    async ({ query, limit, threshold }) => {
      try {
        const rows = await searchMemory({
          query,
          limit,
          threshold,
          recencyWeight: 0,
          halfLifeDays: 90,
          includeRejected: false,
        });
        if (rows.length === 0) return text(`No memories found matching "${query}".`);
        const formatted = rows.map((r, i) => {
          const parts = [
            `--- Result ${i + 1} (${(r.similarity * 100).toFixed(1)}% match) ---`,
            `Captured: ${new Date(r.createdAt).toLocaleDateString()}`,
            `Type: ${r.memoryType || "unknown"}`,
          ];
          if (r.tags?.length) parts.push(`Topics: ${r.tags.join(", ")}`);
          const people = peopleOf(r.entities);
          if (people.length) parts.push(`People: ${people.join(", ")}`);
          parts.push(`\n${r.content}`);
          return parts.join("\n");
        });
        return text(`Found ${rows.length} memory(ies):\n\n${formatted.join("\n\n")}`);
      } catch (err) {
        return text(`Error: ${(err as Error).message}`, true);
      }
    }
  );

  // --- list_thoughts ---
  server.tool(
    "list_thoughts",
    "OB1-compatible alias listing recent memories as text, with optional filters by type, topic, person, or time range. Native callers should prefer ListMemories (structured output, pagination).",
    {
      limit: z.number().int().min(1).max(200).optional().default(10).describe("Max results (1-200)"),
      type: z.string().optional().describe("Filter by memoryType"),
      topic: z.string().optional().describe("Filter by tag"),
      person: z.string().optional().describe("Filter by person entity"),
      days: z.number().optional().describe("Only memories from the last N days"),
      includeRejected: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include rejected/superseded/disputed memories (excluded by default)"),
    },
    async ({ limit, type, topic, person, days, includeRejected }) => {
      try {
        const conds = [sql`deleted_at IS NULL`];
        if (type) conds.push(sql`memory_type = ${type}`);
        if (topic) conds.push(sql`tags @> ARRAY[${topic}]::text[]`);
        if (person) conds.push(sql`entities @> ${JSON.stringify({ person: [person] })}::jsonb`);
        if (days) conds.push(sql`created_at >= now() - (${days} || ' days')::interval`);
        // Hide governance-rejected memories by default (NULL governance passes).
        if (!includeRejected) {
          conds.push(sql`(review_status IS NULL OR review_status NOT IN ('rejected'))`);
          conds.push(sql`(provenance_status IS NULL OR provenance_status NOT IN ('superseded', 'disputed'))`);
        }

        const rows = await db.execute<{
          content: string;
          memory_type: string | null;
          tags: string[] | null;
          created_at: string;
        }>(sql`
          SELECT content, memory_type, tags, created_at
          FROM memories
          WHERE ${sql.join(conds, sql` AND `)}
          ORDER BY created_at DESC
          LIMIT ${limit}
        `);

        const list = (rows as unknown as any[]);
        if (!list.length) return text("No memories found.");
        const formatted = list.map((r, i) => {
          const tags = Array.isArray(r.tags) ? r.tags.join(", ") : "";
          return `${i + 1}. [${new Date(r.created_at).toLocaleDateString()}] (${r.memory_type || "??"}${tags ? " - " + tags : ""})\n   ${r.content.replace(/\s+/g, " ").trim().slice(0, 200)}`;
        });
        return text(`${list.length} recent memory(ies):\n\n${formatted.join("\n\n")}`);
      } catch (err) {
        return text(`Error: ${(err as Error).message}`, true);
      }
    }
  );

  // --- thought_stats ---
  server.tool(
    "thought_stats",
    "Summary of all captured memories (OB1-compatible): totals, date range, types, top topics and people.",
    {},
    async () => {
      try {
        const [{ count, oldest, newest }] = (await pg`
          SELECT count(*)::int AS count,
                 min(created_at) AS oldest,
                 max(created_at) AS newest
          FROM memories WHERE deleted_at IS NULL
        `) as any[];

        const types = (await pg`
          SELECT coalesce(memory_type, 'unknown') AS k, count(*)::int AS v
          FROM memories WHERE deleted_at IS NULL
          GROUP BY 1 ORDER BY v DESC LIMIT 10
        `) as any[];

        const topics = (await pg`
          SELECT t AS k, count(*)::int AS v
          FROM memories, unnest(tags) AS t
          WHERE deleted_at IS NULL
          GROUP BY 1 ORDER BY v DESC LIMIT 10
        `) as any[];

        const people = (await pg`
          SELECT p AS k, count(*)::int AS v
          FROM memories, jsonb_array_elements_text(entities->'person') AS p
          WHERE deleted_at IS NULL
          GROUP BY 1 ORDER BY v DESC LIMIT 10
        `) as any[];

        const lines: string[] = [
          `Total memories: ${count}`,
          `Date range: ${
            count && oldest && newest
              ? `${new Date(oldest).toLocaleDateString()} → ${new Date(newest).toLocaleDateString()}`
              : "N/A"
          }`,
          "",
          "Types:",
          ...types.map((t) => `  ${t.k}: ${t.v}`),
        ];
        if (topics.length) {
          lines.push("", "Top topics:");
          for (const t of topics) lines.push(`  ${t.k}: ${t.v}`);
        }
        if (people.length) {
          lines.push("", "People mentioned:");
          for (const p of people) lines.push(`  ${p.k}: ${p.v}`);
        }
        return text(lines.join("\n"));
      } catch (err) {
        return text(`Error: ${(err as Error).message}`, true);
      }
    }
  );

  // --- capture_thought ---
  server.tool(
    "capture_thought",
    "Save a new memory to OpenBrain (OB1-compatible). Generates an embedding and enriches asynchronously. Agent-written memory enters as evidence pending review, not instruction.",
    {
      content: z
        .string()
        .describe("The memory to capture — a clear, standalone statement retrievable later by any AI"),
    },
    async ({ content }) => {
      try {
        const result = await storeMemory({ content, source: "mcp" }, { createdBy: "agent" });
        if ("deduped" in result && result.deduped) {
          return text(`Already captured (duplicate of existing memory ${result.id}).`);
        }
        return text(`Captured memory ${result.id} as evidence (pending review).`);
      } catch (err) {
        return text(`Error: ${(err as Error).message}`, true);
      }
    }
  );
}
