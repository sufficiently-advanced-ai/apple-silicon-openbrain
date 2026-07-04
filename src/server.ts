import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StoreMemorySchema, storeMemory } from "./tools/StoreMemory.js";
import { SearchMemorySchema, searchMemory } from "./tools/SearchMemory.js";
import { RecallMemorySchema, recallMemory } from "./tools/RecallMemory.js";
import { ListMemoriesSchema, listMemories } from "./tools/ListMemories.js";
import { UpdateMemorySchema, updateMemory } from "./tools/UpdateMemory.js";
import { DeleteMemorySchema, deleteMemory } from "./tools/DeleteMemory.js";
import { ReviewMemorySchema, reviewMemory } from "./tools/ReviewMemory.js";
import { registerCompatTools } from "./tools/compat.js";

// Unified result envelope: `{error}` results and thrown exceptions both surface
// as MCP isError, matching the compat tools — callers used to see three
// different error shapes depending on tool and failure mode.
type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const result = await fn();
    const isError =
      typeof result === "object" && result !== null && "error" in result;
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      ...(isError ? { isError: true } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: JSON.stringify({ error: message }) }],
      isError: true,
    };
  }
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: "openbrain",
    version: "0.2.0",
  });

  server.tool(
    "StoreMemory",
    "Store a new memory with semantic embedding; summary/tags/entities are enriched asynchronously via LLM. " +
      "Identical content (same fingerprint) returns the existing memory with deduped:true instead of storing twice. " +
      "MCP writes enter the trust ladder as agent evidence pending review — use ReviewMemory 'confirm' to promote " +
      "a memory to instruction-grade.",
    StoreMemorySchema.shape,
    async (input) => run(() => storeMemory(input as any))
  );

  server.tool(
    "SearchMemory",
    "Preferred semantic search across stored memories, ranked by cosine similarity with optional filters, " +
      "similarity threshold, and recency blending. Rejected/superseded/disputed memories are excluded unless " +
      "includeRejected. May return fewer than `limit` results: when a source and a note derived from it both " +
      "match, the source is collapsed into the derivative's derivedFrom list.",
    SearchMemorySchema.shape,
    async (input) => run(() => searchMemory(input as any))
  );

  server.tool(
    "RecallMemory",
    "Retrieve a specific memory by its UUID, including governance/trust-ladder fields and lineage " +
      "(derivedFrom: sources it was produced from; derivatives: notes produced from it).",
    RecallMemorySchema.shape,
    async (input) => run(() => recallMemory(input as any))
  );

  server.tool(
    "ListMemories",
    "List memories newest-first with optional filters for type, source, and tags. Paginated via limit/offset; " +
      "`count` is the page size and `hasMore` indicates whether another page exists.",
    ListMemoriesSchema.shape,
    async (input) => run(() => listMemories(input as any))
  );

  server.tool(
    "UpdateMemory",
    "Update a memory's content or metadata. Content changes trigger re-embedding and re-enrichment; a content " +
      "change to a confirmed/instruction-grade memory demotes it back to pending review (returned as demoted:true) " +
      "— ask the user to ReviewMemory 'confirm' it again.",
    UpdateMemorySchema.shape,
    async (input) => run(() => updateMemory(input as any, { actor: "agent" }))
  );

  server.tool(
    "DeleteMemory",
    "Soft-delete a memory by UUID. The memory is marked as deleted but not removed from the database " +
      "(recoverable — ask the user to restore via the web UI's duplicates view if needed).",
    DeleteMemorySchema.shape,
    async (input) => run(() => deleteMemory(input as any, { actor: "agent" }))
  );

  server.tool(
    "ReviewMemory",
    "Review an agent-written memory (trust ladder). 'confirm' promotes it to instruction-grade (user_confirmed) — " +
      "only do this on the user's explicit say-so; 'evidence_only'/'reject'/'restrict_scope'/'mark_stale'/'dispute'/" +
      "'supersede' adjust its lifecycle. 'supersede' means: this memory (id) replaces the older relatedId.",
    ReviewMemorySchema.shape,
    async (input) => run(() => reviewMemory(input as any, { actor: "agent" }))
  );

  // OB1 ("Open Brain") canonical tool parity: search, fetch, search_thoughts,
  // list_thoughts, thought_stats, capture_thought.
  registerCompatTools(server);

  return server;
}
