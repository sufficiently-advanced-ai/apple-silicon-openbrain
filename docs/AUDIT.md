# OpenBrain Code Review & Data Audit

**Date:** 2026-07-02 · **Mode:** read-only (no code changed) · **Method:** four parallel audit passes (data shapes, routes/pathways, interfaces, cruft), verified against the **live** database (9,655 memories; 7,665 live / 1,990 soft-deleted) and live services. Findings marked **[2×]** were independently confirmed by two separate passes.

> **Remediation (same day):** C1, C2 (trusted-network model; tailnet stays open by design), C4, C5, and S1–S21 were fixed and deployed. C3 (plist secret) intentionally left as-is — the keychain approach has a history of breakage on this box. Data repairs applied: migrations 0010/0011 (drift capture, duplicate trigger drop, 7,172 dead/duplicate links removed, pair-unique index), 203 fingerprints re-canonicalized. Still open: the 3,220-row enrichment backlog (run `bun run scripts/enrich-backlog.ts` overnight) and the §3 cleanup items.

**Working-tree caveat:** uncommitted in-flight lineage work (drizzle `0008`/`0009`, `src/services/lineage.ts`, `scripts/backfill-lineage.ts`, modified tools/schema/UI) was treated as new work, not drift. Both migrations **are applied** to the live DB — the DB is ahead of git main but matches the working tree.

---

## 1. Critical findings

### C1. Bearer auth is trivially bypassable via `X-Forwarded-For` [2×]
`src/index.ts:37-44` resolves the client IP from the client-supplied `X-Forwarded-For` header *before* falling back to `this.requestIP()`. The MCP server binds `0.0.0.0:6277`, so any host on the LAN/Tailscale mesh can send `X-Forwarded-For: 127.0.0.1` and get full unauthenticated MCP access (store/update/delete/review). Compounding it: `tailscale serve` on :6443 proxies to `localhost:6277`, so *every* Tailscale-origin request already appears local to `requestIP()` — the bearer gate essentially never fires. `AUTH_TOKEN` is set but provides no real protection. Fix: only trust XFF when the socket peer is actually localhost (the proxy case), and verify Tailscale identity headers (`Tailscale-User-Login`) or require the token even for proxied requests.

### C2. Every write operation in the system is reachable unauthenticated
- `:6277` — `/api/*` is explicitly exempted from auth (`src/index.ts:36`): `POST/GET /api/ingest` (arbitrary URL → Firecrawl scrape or local `yt-dlp` run; SSRF/credit-burn vector, URL only checked for presence at `index.ts:126`), `POST /api/sources`, `PATCH/DELETE /api/sources/:id`, `POST /api/sources/:id/sync`, `POST /api/sources/poll-due`.
- `:6279` — the UI server binds `0.0.0.0` with **zero** auth code (`ui/server.ts:66-69`) and exposes destructive writes: `PUT /api/memories/:id`, `POST /api/memories/:id/review` (governance promotion!), `PATCH .../tags`, and four `/api/duplicates/*` mutators including bulk soft-delete of up to 100 rows and supersede.
- CORS is `Access-Control-Allow-Origin: *` on `/api/ingest` and `/api/sources` (`src/index.ts:27,120`, `src/api/sources.ts:27`) — any web page in a browser on the network can drive these.

CLAUDE.md frames `/api/*` as "local network only" by intent, but combined with C1 the effective posture is: the whole corpus is mutable and deletable by anything that can reach the box. On a Tailscale-only machine the blast radius is your own devices — but the review-promotion endpoint on :6279 means anything on the mesh can mint instruction-grade memory, which defeats the trust ladder's entire purpose.

### C3. Plaintext secret in the installed launchd plist
`~/Library/LaunchAgents/com.openbrain.mcp.plist` embeds `GOG_KEYRING_PASSWORD` in plaintext (the repo template `launchd/` correctly uses a `__GOG_KEYRING_PASSWORD__` placeholder; the installed copy has the real value). Move it to Keychain or an untracked env file with tight permissions, and rotate the password.

### C4. The fresh-install path produces a broken database [2×]
- `scripts/setup.sh:38-62` applies an inline 0000-era schema: no governance columns, no `content_fingerprint`, no `memory_links`/`memory_audit`/`sources`. `storeMemory` inserts governance columns (`src/tools/StoreMemory.ts:88-104`) → **every store and search fails on a machine installed via `installer/bootstrap.sh`**, which is the documented client-distribution path (`apps/mac/INSTALL-FOR-CLIENTS.md`).
- `bun run db:migrate` (`src/db/migrate.ts:7`) hard-codes **only `0000_initial.sql`** and will never apply 0001–0009, despite README:300 and CLAUDE.md advertising it as the migration applier. There is **no migration tracking table at all** (no `drizzle.__drizzle_migrations`), `drizzle/meta/` is gitignored and empty, and every migration past 0000 was applied by hand via `scripts/apply-migration.ts`.

This only works today because there is exactly one long-lived install.

### C5. UpdateMemory silently rewrites instruction-grade memory
`src/tools/UpdateMemory.ts:22-43` updates `content` (and re-embeds) without touching `review_status` / `can_use_as_instruction` / `provenance_status`. An agent can replace the content of a `user_confirmed`, instruction-grade memory wholesale and it stays instruction-grade — bypassing the trust ladder that StoreMemory carefully enforces on insert. Content changes should demote to `pending` (or at minimum flag for re-review). Live exposure is currently tiny (11 instruction-grade rows) but this is the exact hole the governance model exists to close.

---

## 2. Should-fix findings

### Schema & migrations
- **S1. Untracked live-DB drift from an external writer.** The live DB has objects in no migration and not in `schema.ts`: column `memories.origin_source_id uuid` (**1,649 rows** populated — likely a LCARS/Hermes pipeline), indexes `idx_memories_origin_source`, `idx_memories_deleted`, `idx_memories_expires`, and a `notify_openbrain_memory()` function with **three triggers — two of which are duplicate `AFTER INSERT` triggers firing `pg_notify` twice per insert**. Drop one trigger; capture the rest in a migration.
- **S2. `schema.ts` omits indexes the DB has** — the HNSW index `idx_memories_embedding` (from 0000) and `idx_memory_links_relationship` (0009) are not declared (`src/db/schema.ts:51-83,123-126`). If drizzle-kit diffing is ever wired up it would propose dropping the HNSW index.
- **S3. `memory_links` has no unique constraint, so `linking.ts`'s `ON CONFLICT DO NOTHING` is a no-op** (`src/services/linking.ts:28-32`). Live: 7 duplicate `similar` pairs. Add a unique index on `(least(source,target), greatest(source,target), relationship)`.
- **S4. Fingerprint JS/SQL mirror is broken for Unicode whitespace.** JS `\s` matches NBSP/ZWSP etc.; Postgres `\s` does not. **90 live rows** (~0.9%, mostly mail/web) have fingerprints the SQL expression can't reproduce, so exact-dup detection can miss across the JS/SQL boundary. Also 11 rows have NULL fingerprints. The CLAUDE.md "must mirror" invariant has no test (see S15).

### Data quality (live numbers)
- **S5. 3,220 live memories (42%) were never enriched** (`summary IS NULL`). Queue depth is currently ~0–3, so this is accumulated backlog, not active failure — run `scripts/enrich-backlog.ts`. Root causes worth noting: the queue **silently drops** work above depth 500 (`enrichment.ts:148`) and failures are console-log-only with no persisted state or retry sweep.
- **S6. Enrichment clobbers caller-supplied tags/entities.** `src/services/enrichment.ts:120-128` sets `tags`/`entities` unconditionally from the LLM output. Proven in data: of 675 mail memories stored with Gmail labels as tags, **exactly the 221 enriched ones lost their labels**. Merge instead of replace (or only fill empty fields). Same block: the extracted LLM JSON is cast, not Zod-validated — a malformed `entities` shape inserts silently into jsonb; and the UPDATE has no `deleted_at IS NULL` guard, so soft-deleted rows get re-titled.
- **S7. Audit log asserts lineage that doesn't exist.** 7,506 `link_derived` audit pairs vs only 3,087 surviving `derived_from` links — **4,419 audited pairs have no link** (the loose 2026-06-13 backfill was cleaned up with no compensating audit rows; every later day reconciles 1:1). There is no `unlink` action in `AuditAction` (`src/services/audit.ts:4-11`). Add one, and consider a one-time annotation for the historical gap.
- **S8. 7,165 memory_links (24%) have a soft-deleted endpoint** — dead weight every query filters around. Sweep links on delete (or in a periodic job).

### Services & contracts
- **S9. Embedding call: no timeout, no response validation, unversioned cache.** `src/services/embedding.ts:16-29` has no `AbortSignal` (a wedged MLX service — a documented failure mode — hangs every Store/Search call indefinitely; contrast enrichment's 60s timeout) and blindly casts the response, never checking `data[0].embedding` exists, is numeric, or is 1024-dim (the DB column blocks wrong-dim *inserts*, but search-path vectors go straight into the SQL literal, and a NaN-filled 1024 array passes everything). The Redis cache key (`cache.ts:22-37`) is a **64-bit-truncated** hash of text only — no model/dim versioning, so swapping embedding models serves stale cross-model vectors for 24h, invisibly.
- **S10. compat `search_thoughts`/`list_thoughts` bypass the Zod bounds** the native tools enforce: `compat.ts:110,148` declare `limit` with no `.max()` and call `searchMemory()` as a function, skipping `SearchMemorySchema`'s `max(50)`; `input.limit` is interpolated into `LIMIT ${...}` at `SearchMemory.ts:114` (numeric, so no injection — but unbounded).
- **S11. MCP session map leaks** [2×] — sessions are only removed on explicit close (`src/index.ts:69,77`); live `/health` shows **83–85 sessions**. Add an idle TTL sweep.
- **S12. LLM model config mismatch = GPU-thrash risk.** `config.ts:6` defaults `LLM_MODEL` to `Qwen3-8B-4bit`; the box actually runs `Qwen3.6-27B-4bit` (via `.env` + installed plist). If `.env` is ever absent, mlx-lm hot-swaps and thrashes the 32GB GPU. Fix the default and add a boot-time assert against mlx-lm's `/v1/models`.
- **S13. Installed vs repo plist drift; poll never installed.** Installed `com.openbrain.poll` runs 3×/day (StartCalendarInterval 07:00/12:30/18:00); the repo copy says hourly (StartInterval 3600). `scripts/install-services.sh:88-96` and `uninstall-services.sh:8` **omit the poll plist entirely** — headless polling only works because it was hand-installed.

### Tooling, tests, UI
- **S14. `bun run typecheck` is broken and partial.** `tsconfig.json:10` `rootDir: "src"` conflicts with `include`ing `scripts/**` → 4× TS6059, exit 1 (verified). `ui/` (463-line server) and `agents/` are never typechecked at all.
- **S15. `bun test` mutates the live database by default.** `src/__tests__/ob1-compat.test.ts` is a real end-to-end test against live Postgres + the live embed service (cleanup is marker-scoped, but it's still the default suite). Gate it behind an env flag. Beyond it and the 6 pure lineage tests, coverage is **zero** for: store→search with mocked services, enrichment, ingest, sourceSync, **auth**, the UI server's ~15 endpoints, cache, fingerprint JS↔SQL parity.
- **S16. UI manual adds are mislabeled as agent writes.** `ui/server.ts:165` calls `storeMemory(parsed)` with no opts, so a human using the dashboard's "New memory" form gets `created_by='agent'`, `review_status='pending'` — and lands in their own review queue. Pass `{ createdBy: "user" }`.
- **S17. Search-page governance badges are partially inert.** `ui/server.ts:179-183` applies `governanceView`/`peopleOf` to search rows, but `SearchMemory.ts:106-108` doesn't select `created_by`/`confidence`/`visibility` — so the badges silently never render on Search while working on Detail/Audit. Add the three columns to the select.
- **S18. `source_date` is never written by any ingest path** — read and sorted on everywhere (`ui/server.ts:90,132,138`, `RecallMemory.ts:23`) but only historical imports populated it; e.g. YouTube's `upload_date` is parsed (`youtube.ts:66`) then only embedded in the markdown header.

### MCP interface quality
- **S19. StoreMemory's description omits its two most surprising behaviors**: silent fingerprint dedup (`deduped:true` return, `StoreMemory.ts:68-75`) and the governance posture (writes enter as agent/generated/pending — a model storing a "rule" won't know to ask for `ReviewMemory confirm`). Ironically `capture_thought`'s description (`compat.ts:260`) documents both.
- **S20. Three different error shapes depending on tool and failure**: compat tools set MCP `isError:true`; native tools return `{error:...}` JSON without it; thrown errors (embed service down, malformed `after`/`before` date → raw Postgres error) surface as raw exception text. Unify, and validate dates with `z.string().datetime()`.
- **S21. Tool-choice ambiguity pulls callers to the wrong search.** `search_thoughts`' description is an affirmative usage prompt ("Use when the user asks about a topic…", `compat.ts:106`) with a hidden 0.5 threshold that returns *fewer* results than SearchMemory. Mark native tools as preferred and compat tools as "OB1 alias — prefer SearchMemory/RecallMemory". Also: `ListMemories.count` is page size with no `hasMore` (`ListMemories.ts:61`); SearchMemory's lineage collapse can return fewer than `limit` with no explanation (`SearchMemory.ts:154-184`).

---

## 3. Cleanup findings

- Dead code: `src/lib/types.ts` (entirely unimported; `MemoryType` includes `"conversation"` — 0 live rows), `getCachedSearch`/`setCachedSearch` (`cache.ts:41-51`, zero callers — yet CLAUDE.md advertises 5-min search caching), unused `pgvector` npm dep (`package.json:20`), dead `expires_at` column (schema, 0000, setup.sh — no expiry logic exists; 0 rows), no-op rethrow `enrichment.ts:130-136`, uncalled route `GET /api/sources/:id`.
- Duplicated logic (ingestion is otherwise a **single funnel** through `storeMemory()` — good): the `(source, source_id)` pre-check ×2 (`ingest.ts:19-33`, `mail.ts:152-159`); link extraction ×2 with **drifted skip-lists** (`mail.ts:16-50` follows any off-site URL incl. `/login`-type paths that `sourceSync.ts:41-72` filters); the try/ingest/count loop ×3 (`rss.ts:90-99`, `sourceSync.ts:76-84`, `mail.ts:222-231`).
- Dedup key quirks: mail pre-checks `thread.id` but stores `msg.id` (`mail.ts:184` vs `:212`) — replies re-fetch every poll and over-count `ingested`; YouTube uses the raw URL as `source_id` (`ingest.ts:41`) so `watch?v=`/`youtu.be` variants aren't deduped.
- Audit actor hardcoded `"user"` in UpdateMemory/DeleteMemory/ReviewMemory (`UpdateMemory.ts:47`, `DeleteMemory.ts:26`, `ReviewMemory.ts:99,119`) — only StoreMemory records the real actor.
- Config sprawl: `src/lib/config.ts` exists but only `src/` uses it — `ui/`, `agents/`, `scripts/` bypass it. Env vars read but undocumented: `OPEN_BRAIN_CITATION_BASE_URL`, `GOG_PATH` (`mail.ts:80`), `OPENBRAIN_UI_URL`; `DISABLE_ENRICHMENT` and config access in `mail.ts:80`/`enrichment.ts:58` bypass config.ts. Ports 6277/6278/6279/8000 hardcoded across ~6 surfaces each; default `DATABASE_URL` duplicated 4×. Magic numbers worth centralizing: enrichment cap 4000 (`enrichment.ts:19`), embed cap 8000 (`embedding.ts:8`), cache TTLs 86400/300 (`cache.ts:38,50`), linking 0.75/3 (`linking.ts:3-4`), queue depth 500 (`enrichment.ts:148`), timeouts/temperature/max_tokens (`enrichment.ts:45-46,71-72`).
- Stale docs/misc: `tests/agents/README.md` and `agents/prompts/README.md` claim the `--fixtures` flag "is not built yet" — it exists and works (`run-agent.ts:57-70,214-218`); `src/server.ts:14` version `"0.1.0"` vs package 0.2.0; `youtube.ts:84` field named `transcript` actually holds the full formatted document; `agents/launchd/com.openbrain.agent.template.plist` references a "Phase 5 Swift app generates this" flow that doesn't exist; `AgentsPane.swift:64,76` hardcodes `~/Developer/openbrain` paths; `embed-service/server.py:73` hardcodes host/port (changing `EMBEDDING_URL` moves clients but not the server, and the Python side has no input-length cap — a non-TS caller can OOM the GPU).

### What's fine (verified, one line each)
- Embeddings: 0 NULL, 0 wrong-dimension rows across 9,655.
- Instruction-grade CHECK: 0 violations; ReviewMemory's `confirm`/`supersede` logic is constraint-safe; 0 dangling supersede pointers.
- Live duplicate `(source, source_id)`: 0. Fingerprint dup clusters: 9, max size 2 — corpus is clean.
- Orphaned `memory_links`: 0 (FKs hold). `relationship` values all conform to the 0009 CHECK.
- MCP tool boundary: every registered tool validates through Zod; governance fields correctly excluded from the public StoreMemory schema; no SQL injection paths found.
- stdio and HTTP transports register the identical 13-tool set via shared `createServer()`.
- UI ↔ API shapes agree everywhere except S17; `index.html` XSS posture is sound; no external CDN deps.
- The in-flight `lineage.ts` is well-built: consistent direction convention, idempotent, honors the 0009 CHECK; its 6 unit tests pass.
- `installer/prereqs.sh` and `apps/mac` endpoint usage match current reality; agent prompt frontmatter matches `AgentConfig` 1:1.
- Enrichment's timeout/retry (60s abort, 1 retry network + 1 retry 5xx) is the best HTTP hygiene in the codebase.
- All scripts in `scripts/` are live; no missing npm deps; no commented-out code blocks anywhere.

---

## 4. CLAUDE.md drift — corrected architecture

What the doc says vs what the system is:

| CLAUDE.md claim | Reality |
|---|---|
| Enrichment uses `Qwen3-8B-4bit` (default) | Box runs `Qwen3.6-27B-4bit` via `.env`/plist; the code default is a thrash hazard (S12). The "`/no_think` prefix" note is also stale — Qwen3.6 requires `chat_template_kwargs:{enable_thinking:false}`, which is what `enrichment.ts:76` actually sends. |
| Redis caches "search results (5min TTL)" | Dead code — `getCachedSearch` has zero callers. Only embeddings are cached. |
| `bun run db:migrate` applies migrations | It applies only 0000. There is no migration tracking; everything else was applied by hand (C4). |
| "Bearer token required for non-localhost MCP" | Not effectively enforced: XFF-first check + Tailscale proxy collapse (C1). |
| `/api/*` "intended for local network only" | True, but understates: that's every write path in the system, including UI governance promotion, with CORS `*` (C2). |
| Source values "claude-code, manual, web, youtube" | Live distribution: web 6,042 / obsidian 1,219 / youtube 818 / mail 675 / blogwatcher 363 / firecrawl 227 / manual 168 / +9 more, plus `mcp` from capture_thought. |
| (not mentioned) | An external writer (LCARS/Hermes pipeline) adds `origin_source_id` + `pg_notify` triggers directly in the DB (S1); a poll launchd job drives source syncing 3×/day; `agents/run-agent.ts` runs prompt-pack agents against the UI API. These are real architecture components CLAUDE.md doesn't describe. |

**Corrected one-paragraph description:** OpenBrain is an MCP server (Bun, :6277, 0.0.0.0) exposing 7 native memory tools + 6 OB1-compat aliases over a shared `createServer()`, with unauthenticated-by-design `/api/ingest` + `/api/sources` REST routes; a localhost-only MLX embedding service (:6278, 1024-dim Qwen3 embeddings); enrichment via mlx-lm (:8000, Qwen3.6-27B, `enable_thinking:false`, serialized queue, fire-and-forget); Postgres 17 + pgvector (HNSW + GIN indexes, governance/trust-ladder columns, advisory content fingerprints, `memory_links` similarity + derived-from lineage, append-only `memory_audit`); optional Redis (embedding cache only); a Web UI (:6279, 0.0.0.0, no auth) that is also a full read-write admin surface including governance review and duplicate resolution; launchd jobs for the four services plus a hand-installed 3×/day poll job driving RSS/mail/webpage source sync; and an external notify-trigger integration writing directly to the DB.

---

## 5. Prioritized roadmap

**1. Close the auth holes (C1, C2, C3) — effort: S (half a day).**
Fix the XFF-first check, require the bearer token (or Tailscale identity headers) on `/api/*` writes and the entire UI server, kill CORS `*` on write routes, move `GOG_KEYRING_PASSWORD` out of the plist and rotate it. Why first: every other guarantee in the system (trust ladder, audit, dedup) is meaningless while any mesh peer can promote or delete memory unauthenticated. Unblocks: safely exposing the system to more devices/agents, which is the stated direction.

**2. Make migrations real (C4, S1, S2) — effort: M (1 day).**
Rewrite `src/db/migrate.ts` to iterate `drizzle/*.sql` with a tracking table; un-gitignore `drizzle/meta/`; replace `setup.sh`'s inline schema with the migration runner; fold the external-writer drift (`origin_source_id`, notify triggers — dropping the duplicate INSERT trigger) into a migration; declare the missing indexes in `schema.ts`; add the `memory_links` unique constraint (S3). Unblocks: fresh installs actually working (the client-distribution path is currently shipping a broken DB), safe schema evolution, and drizzle-kit diffing.

**3. Enrichment correctness + observability (S5, S6, and the fire-and-forget map) — effort: M (1–2 days).**
Merge LLM tags/entities with caller-supplied values instead of clobbering; Zod-validate the LLM JSON; add a `deleted_at IS NULL` guard; persist enrichment failures (an `enrich_status`/`enrich_error` column or dead-letter table) instead of console-only, and surface counts in `/health`; then sweep the 3,220-row backlog. The audit's pipeline trace found **every** post-insert hop (audit, enrichment, linking, lineage) is fire-and-forget with swallowed errors — a persisted status column is the cheapest observability that covers all of them. Unblocks: trusting summaries/tags corpus-wide, which is what search quality and the UI ride on.

**4. Test the core memory path + fix the harness (S14, S15, S4) — effort: M (1–2 days).**
Fix `tsconfig` (typecheck currently exits 1 and skips `ui/`+`agents/`); gate the live-DB integration test behind an env flag; add hermetic tests with a mocked embed service for store→search, the fingerprint JS↔SQL parity invariant (would have caught S4), auth (would have caught C1), and UpdateMemory's governance behavior (would have caught C5). Unblocks: making changes 1–3 without regressions; this is the enabling investment for everything else.

**5. Interface hardening pass (C5, S9–S11, S16–S21) — effort: M (1–2 days).**
Demote on UpdateMemory content change; add embed-call timeout + response validation + model-versioned cache keys; bound compat-tool limits; unify error signaling (`isError`); fix StoreMemory/`search_thoughts` descriptions and the "preferred tool" signals; fix UI `createdBy`; add the three missing SearchMemory columns; add a session TTL sweep. Mostly small, independent fixes — batchable as one PR.

**On "should the thoughts system merge into the main memory schema":** it already is merged. The thought tools are translating aliases in `src/tools/compat.ts` over the same `memories` table and the same `storeMemory()`/`searchMemory()` functions — there is no separate thoughts store. No action needed beyond the description/bounds fixes in item 5.

**On "consolidating the four ingestion pipelines":** less urgent than expected. All paths already converge on `storeMemory()` — the duplication is ~3 small blocks (pre-check, link extraction, per-item loop) worth a light shared-helper refactor during item 5, not a project.
