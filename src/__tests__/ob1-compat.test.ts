import { test, expect, beforeAll, afterAll } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../server.js";
import { pg } from "../db/client.js";

// End-to-end exercise of the OB1-compat tools + governance model against the
// live local DB/embedding/enrichment services, driven through a real MCP
// in-memory client (so tool registration in server.ts is covered too).
//
// OPT-IN: this suite writes to (and hard-deletes marker rows from) the live
// `openbrain` database, so the default `bun test` skips it. Run with
// `bun run test:live` (sets OPENBRAIN_LIVE_TESTS=1).
const LIVE = process.env.OPENBRAIN_LIVE_TESTS === "1";

const MARKER = `obtest-${Date.now()}`;
let client: Client;

if (!LIVE) {
  test.skip("OB1 compat live suite (set OPENBRAIN_LIVE_TESTS=1 to run)", () => {});
} else {

function textOf(res: any): string {
  return res.content.map((c: any) => c.text).join("\n");
}
async function call(name: string, args: Record<string, unknown> = {}) {
  return textOf(await client.callTool({ name, arguments: args }));
}

beforeAll(async () => {
  const server = createServer();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientT);
});

afterAll(async () => {
  // Remove anything this test created, plus its audit rows.
  const rows = (await pg`SELECT id FROM memories WHERE content LIKE ${"%" + MARKER + "%"} OR source = 'test-ob1-compat'`) as any[];
  const ids = rows.map((r) => r.id);
  if (ids.length) {
    await pg`DELETE FROM memory_audit WHERE memory_id IN ${pg(ids)}`;
    await pg`DELETE FROM memory_links WHERE source_memory_id IN ${pg(ids)} OR target_memory_id IN ${pg(ids)}`;
    await pg`DELETE FROM memories WHERE id IN ${pg(ids)}`;
  }
  await pg.end();
});

test("all OB1 canonical tools are registered", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const n of ["search", "fetch", "search_thoughts", "list_thoughts", "thought_stats", "capture_thought"]) {
    expect(names).toContain(n);
  }
  // Native + governance tools also present.
  expect(names).toContain("StoreMemory");
  expect(names).toContain("ReviewMemory");
});

test("capture_thought stores as evidence, then dedupes on identical content", async () => {
  const content = `${MARKER} the capital of testlandia is bunbury`;
  const first = await call("capture_thought", { content });
  expect(first.toLowerCase()).toContain("evidence");
  const id = first.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] ?? "";
  expect(id).toBeTruthy();

  // Governance defaults for an agent capture.
  const [row] = (await pg`SELECT created_by, provenance_status, review_status, can_use_as_instruction, content_fingerprint FROM memories WHERE id = ${id}`) as any[];
  expect(row.created_by).toBe("agent");
  expect(row.provenance_status).toBe("generated");
  expect(row.review_status).toBe("pending");
  expect(row.can_use_as_instruction).toBe(false);
  expect(row.content_fingerprint).toBeTruthy();

  // Capture log written.
  const [audit] = (await pg`SELECT action FROM memory_audit WHERE memory_id = ${id} AND action='capture'`) as any[];
  expect(audit?.action).toBe("capture");

  const second = await call("capture_thought", { content });
  expect(second.toLowerCase()).toContain("already captured");
});

test("search / fetch (ChatGPT-compat) round-trip", async () => {
  const searchJson = JSON.parse(await call("search", { query: `${MARKER} capital testlandia` }));
  expect(Array.isArray(searchJson.results)).toBe(true);
  expect(searchJson.results.length).toBeGreaterThan(0);
  const hit = searchJson.results[0];
  expect(hit).toHaveProperty("id");
  expect(hit).toHaveProperty("title");
  expect(hit).toHaveProperty("url");

  const doc = JSON.parse(await call("fetch", { id: hit.id }));
  expect(doc.id).toBe(hit.id);
  expect(typeof doc.text).toBe("string");
  expect(doc.metadata).toHaveProperty("type");
});

test("search_thoughts and list_thoughts return formatted text", async () => {
  const st = await call("search_thoughts", { query: `${MARKER} bunbury`, limit: 5, threshold: 0.1 });
  expect(st).toContain("match");
  const lt = await call("list_thoughts", { limit: 5 });
  expect(lt.toLowerCase()).toContain("recent memory");
});

test("thought_stats reports a total", async () => {
  const stats = await call("thought_stats");
  expect(stats).toMatch(/Total memories: \d+/);
});

test("ReviewMemory confirm promotes to instruction-grade and clears pending flag; reject hides from search", async () => {
  // Confirm path.
  const stored = JSON.parse(await call("StoreMemory", {
    content: `${MARKER} confirmable fact about widgets`,
    source: "test-ob1-compat",
  }));
  const confirm = JSON.parse(await call("ReviewMemory", { id: stored.id, action: "confirm" }));
  expect(confirm.provenanceStatus).toBe("user_confirmed");
  expect(confirm.canUseAsInstruction).toBe(true);
  // Any completed review clears requires_user_confirmation.
  const [row] = (await pg`SELECT requires_user_confirmation FROM memories WHERE id = ${stored.id}`) as any[];
  expect(row.requires_user_confirmation).toBe(false);

  // Reject path: a rejected memory must not surface in default search.
  const rejected = JSON.parse(await call("StoreMemory", {
    content: `${MARKER} rejectable nonsense about widgets`,
    source: "test-ob1-compat",
  }));
  await call("ReviewMemory", { id: rejected.id, action: "reject" });
  // reject is also a completed review → pending flag cleared.
  const [rrow] = (await pg`SELECT requires_user_confirmation FROM memories WHERE id = ${rejected.id}`) as any[];
  expect(rrow.requires_user_confirmation).toBe(false);
  const visible = JSON.parse(await call("search", { query: `${MARKER} rejectable nonsense widgets` }));
  const ids = visible.results.map((r: any) => r.id);
  expect(ids).not.toContain(rejected.id);
});

test("StoreMemory ignores caller-supplied trust fields (no review-queue bypass)", async () => {
  // createdBy/provenanceStatus are NOT in the public schema; an injection attempt
  // is stripped and the write still defaults to agent/generated/pending.
  const stored = JSON.parse(await call("StoreMemory", {
    content: `${MARKER} injection attempt should not be import`,
    source: "test-ob1-compat",
    createdBy: "import",
    provenanceStatus: "imported",
  } as any));
  const [row] = (await pg`SELECT created_by, provenance_status, review_status FROM memories WHERE id = ${stored.id}`) as any[];
  expect(row.created_by).toBe("agent");
  expect(row.provenance_status).toBe("generated");
  expect(row.review_status).toBe("pending");
});

test("ListMemories excludes rejected memories by default, includes them on request", async () => {
  const stored = JSON.parse(await call("StoreMemory", {
    content: `${MARKER} list-filter rejected widget`,
    source: "test-ob1-compat",
  }));
  await call("ReviewMemory", { id: stored.id, action: "reject" });

  // Default: rejected memory is hidden.
  const def = JSON.parse(await call("ListMemories", { source: "test-ob1-compat", limit: 100 }));
  expect(def.memories.map((m: any) => m.id)).not.toContain(stored.id);

  // Opt-in: includeRejected surfaces it again.
  const incl = JSON.parse(await call("ListMemories", {
    source: "test-ob1-compat",
    limit: 100,
    includeRejected: true,
  }));
  expect(incl.memories.map((m: any) => m.id)).toContain(stored.id);
});

test("ReviewMemory supersede validates the target", async () => {
  const a = JSON.parse(await call("StoreMemory", { content: `${MARKER} supersede self test`, source: "test-ob1-compat" }));
  const self = JSON.parse(await call("ReviewMemory", { id: a.id, action: "supersede", relatedId: a.id }));
  expect(self.error).toMatch(/cannot supersede itself/i);
  const missing = JSON.parse(await call("ReviewMemory", {
    id: a.id,
    action: "supersede",
    relatedId: "00000000-0000-0000-0000-000000000000",
  }));
  expect(missing.error).toMatch(/not found/i);
});

} // end if (LIVE)
