import { z } from "zod";
import { desc, isNull, and, sql, eq, ilike } from "drizzle-orm";
import { isAuthorizedRequest } from "../src/lib/auth.js";
import { db, pg } from "../src/db/client.js";
import { memories } from "../src/db/schema.js";
import { recordAudit } from "../src/services/audit.js";
import { deleteMemory, restoreMemory } from "../src/tools/DeleteMemory.js";
import { storeMemory, StoreMemorySchema } from "../src/tools/StoreMemory.js";
import { updateMemory, UpdateMemorySchema } from "../src/tools/UpdateMemory.js";
import { recallMemory } from "../src/tools/RecallMemory.js";
import { searchMemory, SearchMemorySchema } from "../src/tools/SearchMemory.js";
import { reviewMemory, ReviewMemorySchema } from "../src/tools/ReviewMemory.js";

/**
 * Derive OB1-shaped display fields from our own trust ladder. The OB1 dashboard
 * thinks in `quality_score` / `importance` / `sensitivity_tier`; we don't have
 * those columns, so we translate from the governance columns we DO have. Aliases
 * translate, they don't pretend the taxonomies match (same rule as compat.ts).
 */
function governanceView(row: {
  reviewStatus?: string | null;
  provenanceStatus?: string | null;
  createdBy?: string | null;
  confidence?: number | null;
  visibility?: string | null;
}) {
  const rs = row.reviewStatus ?? null;
  const ps = row.provenanceStatus ?? null;
  let qualityScore: number;
  if (rs === "rejected" || ps === "disputed" || ps === "superseded") qualityScore = 10;
  else if (rs === "confirmed" || ps === "user_confirmed" || ps === "imported") qualityScore = 90;
  else if (rs === "evidence_only") qualityScore = 55;
  else if (rs === "pending" || row.createdBy === "agent") qualityScore = 25;
  else qualityScore = 60; // historical/NULL governance
  return {
    qualityScore,
    importance: row.confidence != null ? Math.round(row.confidence * 100) : null,
    sensitivityTier: row.visibility ?? null,
  };
}

/** People list from our entities jsonb (mirrors peopleOf() in compat.ts). */
function peopleOf(entities: unknown): string[] {
  const e = (entities ?? {}) as Record<string, unknown>;
  return Array.isArray(e.person) ? (e.person as string[]) : [];
}

// Strict UUID shape so malformed IDs return a clean 404 from the router instead
// of reaching recallMemory() and failing as a DB-level uuid cast error.
const ID_RE = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";

/** Parse a query param to a finite number, falling back when absent/invalid. */
const numberParam = (raw: string | null, fallback: number) => {
  const n = raw == null ? fallback : Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

const PORT = Number(process.env.UI_PORT ?? 6279);
const indexHtml = await Bun.file(new URL("./index.html", import.meta.url)).text();

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;

    // Same trust gate as the MCP server: loopback/tailnet/LAN pass, anything
    // else needs the bearer token. This server exposes destructive writes
    // (edit, review, bulk delete) and previously had no auth at all.
    if (!isAuthorizedRequest(req, this.requestIP(req)?.address)) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (req.method === "GET" && pathname === "/") {
      return new Response(indexHtml, { headers: { "content-type": "text/html" } });
    }

    if (req.method === "GET" && pathname === "/api/memories") {
      const limit = Math.min(Math.max(numberParam(url.searchParams.get("limit"), 100), 1), 500);
      const tag = url.searchParams.get("tag");
      const type = url.searchParams.get("type");
      const source = url.searchParams.get("source");
      const q = url.searchParams.get("q");

      const conds = [isNull(memories.deletedAt)];
      if (tag) conds.push(sql`${tag} = ANY(${memories.tags})`);
      if (type) conds.push(eq(memories.memoryType, type));
      if (source) conds.push(eq(memories.source, source));
      if (q) conds.push(ilike(memories.content, `%${q}%`));

      const effectiveDate = sql<string>`coalesce(${memories.sourceDate}, ${memories.createdAt})`.as("effective_date");
      const rows = await db
        .select({
          id: memories.id,
          content: memories.content,
          summary: memories.summary,
          source: memories.source,
          memoryType: memories.memoryType,
          tags: memories.tags,
          entities: memories.entities,
          createdAt: memories.createdAt,
          sourceDate: memories.sourceDate,
          effectiveDate,
        })
        .from(memories)
        .where(and(...conds))
        .orderBy(desc(effectiveDate))
        .limit(limit);
      return json(rows);
    }

    if (req.method === "GET" && pathname === "/api/stats") {
      const [totals] = await pg`
        SELECT count(*)::int AS total FROM memories WHERE deleted_at IS NULL
      `;
      const bySource = await pg`
        SELECT coalesce(source, '(none)') AS key, count(*)::int AS count
        FROM memories WHERE deleted_at IS NULL
        GROUP BY source ORDER BY count DESC
      `;
      const byType = await pg`
        SELECT coalesce(memory_type, '(none)') AS key, count(*)::int AS count
        FROM memories WHERE deleted_at IS NULL
        GROUP BY memory_type ORDER BY count DESC
      `;
      const topTags = await pg`
        SELECT tag, count(*)::int AS count
        FROM memories, unnest(tags) AS tag
        WHERE deleted_at IS NULL
        GROUP BY tag ORDER BY count DESC LIMIT 40
      `;
      const perDay = await pg`
        SELECT date_trunc('day', coalesce(source_date, created_at))::date AS day, count(*)::int AS count
        FROM memories WHERE deleted_at IS NULL
          AND coalesce(source_date, created_at) > now() - interval '30 days'
        GROUP BY day ORDER BY day
      `;
      const perMonth = await pg`
        SELECT to_char(date_trunc('month', coalesce(source_date, created_at)), 'YYYY-MM') AS month,
               count(*)::int AS count
        FROM memories WHERE deleted_at IS NULL
          AND coalesce(source_date, created_at) > now() - interval '2 years'
        GROUP BY month ORDER BY month
      `;
      const [coverage] = await pg`
        SELECT
          count(*) FILTER (WHERE source_date IS NOT NULL)::int AS with_source_date,
          count(*)::int AS total
        FROM memories WHERE deleted_at IS NULL
      `;
      return json({
        total: totals.total,
        bySource,
        byType,
        topTags,
        perDay,
        perMonth,
        coverage,
      });
    }

    if (req.method === "POST" && pathname === "/api/memories") {
      try {
        const body = await req.json();
        const parsed = StoreMemorySchema.parse({ ...body, source: body.source || "manual" });
        // A dashboard add is a human write — without this it lands in the
        // review queue as agent-generated evidence.
        const result = await storeMemory(parsed, { createdBy: "user" });
        return json(result, 201);
      } catch (err) {
        return json({ error: (err as Error).message }, 400);
      }
    }

    // POST /api/search  body: { query, limit?, threshold?, memoryType?, source?, tags? }
    // Semantic search with similarity scores (OB1 Search page).
    if (req.method === "POST" && pathname === "/api/search") {
      try {
        const body = await req.json();
        const parsed = SearchMemorySchema.parse(body);
        const rows = await searchMemory(parsed);
        const results = rows.map((r) => ({
          ...r,
          people: peopleOf(r.entities),
          ...governanceView(r),
        }));
        return json(results);
      } catch (err) {
        return json({ error: (err as Error).message }, 400);
      }
    }

    // GET /api/audit  — review queue: agent-written evidence + explicitly-pending
    // memory that a human hasn't yet decided on. This is OB1's "low quality_score"
    // list, expressed in our trust ladder.
    if (req.method === "GET" && pathname === "/api/audit") {
      const limit = Math.min(Math.max(numberParam(url.searchParams.get("limit"), 100), 1), 500);
      const rows = await pg`
        SELECT id, content, summary, source, memory_type AS "memoryType", tags, entities,
               created_at AS "createdAt", source_date AS "sourceDate",
               provenance_status AS "provenanceStatus", review_status AS "reviewStatus",
               created_by AS "createdBy", confidence, visibility,
               requires_user_confirmation AS "requiresUserConfirmation"
        FROM memories
        WHERE deleted_at IS NULL
          AND (
            review_status = 'pending'
            OR (created_by = 'agent'
                AND (review_status IS NULL OR review_status NOT IN ('confirmed', 'rejected', 'evidence_only')))
          )
        ORDER BY created_at ASC
        LIMIT ${limit}
      `;
      const out = (rows as any[]).map((r) => ({ ...r, ...governanceView(r) }));
      return json(out);
    }

    // GET /api/duplicates?threshold=0.9 — exact (fingerprint) groups + near (vector) pairs.
    if (req.method === "GET" && pathname === "/api/duplicates") {
      const threshold = Math.min(Math.max(numberParam(url.searchParams.get("threshold"), 0.9), 0), 1);
      const groupLimit = 50;

      // Exact duplicates: rows sharing a content_fingerprint (advisory dedup key).
      // Already-resolved memory (superseded/disputed/rejected) is excluded so
      // resolving a group actually clears it from this view (same default
      // exclusion as ListMemories).
      const dupRows = (await pg`
        WITH live AS (
          SELECT * FROM memories
          WHERE deleted_at IS NULL AND content_fingerprint IS NOT NULL
            AND coalesce(provenance_status, '') NOT IN ('superseded', 'disputed')
            AND coalesce(review_status, '') <> 'rejected'
        ),
        dup AS (
          SELECT content_fingerprint FROM live
          GROUP BY content_fingerprint HAVING count(*) > 1
        )
        SELECT m.content_fingerprint AS fp, m.id, m.content, m.created_at AS "createdAt",
               m.source, m.review_status AS "reviewStatus", m.provenance_status AS "provenanceStatus"
        FROM live m JOIN dup ON dup.content_fingerprint = m.content_fingerprint
        ORDER BY m.content_fingerprint, m.created_at
      `) as any[];
      const groupMap = new Map<string, any[]>();
      for (const r of dupRows) {
        const arr = groupMap.get(r.fp) ?? [];
        arr.push({ id: r.id, content: r.content, createdAt: r.createdAt, source: r.source, reviewStatus: r.reviewStatus, provenanceStatus: r.provenanceStatus });
        groupMap.set(r.fp, arr);
      }
      const exact = Array.from(groupMap.entries())
        .slice(0, groupLimit)
        .map(([fingerprint, members]) => ({ fingerprint, members }));

      // Near duplicates: high-similarity vector links.
      const near = (await pg`
        SELECT l.similarity,
               l.source_memory_id AS "aId", sa.content AS "aContent", sa.created_at AS "aCreatedAt",
               l.target_memory_id AS "bId", sb.content AS "bContent", sb.created_at AS "bCreatedAt"
        FROM memory_links l
        JOIN memories sa ON sa.id = l.source_memory_id AND sa.deleted_at IS NULL
          AND coalesce(sa.provenance_status, '') NOT IN ('superseded', 'disputed')
          AND coalesce(sa.review_status, '') <> 'rejected'
        JOIN memories sb ON sb.id = l.target_memory_id AND sb.deleted_at IS NULL
          AND coalesce(sb.provenance_status, '') NOT IN ('superseded', 'disputed')
          AND coalesce(sb.review_status, '') <> 'rejected'
        WHERE l.similarity >= ${threshold} AND l.dismissed_at IS NULL
          AND l.relationship <> 'derived_from'
        ORDER BY l.similarity DESC
        LIMIT 50
      `) as any[];

      return json({ exact, near, threshold });
    }

    // POST /api/duplicates/resolve
    // body: { keepId, supersedeId, notes? }  — single pair, or
    //       { pairs: [{ keepId, supersedeId }], notes? }  — bulk keep/supersede
    if (req.method === "POST" && pathname === "/api/duplicates/resolve") {
      try {
        const body = (await req.json()) as {
          keepId?: string; supersedeId?: string; notes?: string;
          pairs?: { keepId?: string; supersedeId?: string }[];
        };
        const pairs = body.pairs ?? [{ keepId: body.keepId, supersedeId: body.supersedeId }];
        if (pairs.length > 100) return json({ error: "too many pairs (max 100)" }, 400);
        const resolved: string[] = [];
        for (const p of pairs) {
          const parsed = ReviewMemorySchema.parse({
            id: p.keepId,
            action: "supersede",
            relatedId: p.supersedeId,
            notes: body.notes,
          });
          const result = await reviewMemory(parsed, { actor: "user" });
          if ("error" in result) {
            if (pairs.length === 1) return json(result, 400);
            continue;
          }
          resolved.push(p.supersedeId!);
        }
        return json({ resolved, count: resolved.length });
      } catch (err) {
        return json({ error: (err as Error).message }, 400);
      }
    }

    // POST /api/duplicates/delete  body: { ids: string[], reason?: string }
    // Soft-delete every listed memory — for junk pairs/groups where neither
    // side is worth keeping (email footers, bad scrapes). Audited per row.
    if (req.method === "POST" && pathname === "/api/duplicates/delete") {
      try {
        const body = (await req.json()) as { ids?: unknown; reason?: string };
        const ids = z.array(z.string().uuid()).min(1).max(100).parse(body.ids);
        const deleted: string[] = [];
        for (const id of ids) {
          const r = await deleteMemory({ id }, { actor: "web", reason: body.reason ?? "duplicate cleanup" });
          if (!("error" in r)) deleted.push(id);
        }
        return json({ deleted, count: deleted.length });
      } catch (err) {
        return json({ error: (err as Error).message }, 400);
      }
    }

    // POST /api/duplicates/dismiss  body: { pairs: [{ aId, bId }] }
    // "Keep both": stamp the link so the pair stops surfacing as a duplicate.
    // The link survives and still feeds the related-memories list.
    if (req.method === "POST" && pathname === "/api/duplicates/dismiss") {
      try {
        const body = (await req.json()) as { pairs?: unknown };
        const pairs = z
          .array(z.object({ aId: z.string().uuid(), bId: z.string().uuid() }))
          .min(1).max(100)
          .parse(body.pairs);
        let count = 0;
        for (const p of pairs) {
          const updated = await pg`
            UPDATE memory_links SET dismissed_at = now()
            WHERE dismissed_at IS NULL
              AND ((source_memory_id = ${p.aId} AND target_memory_id = ${p.bId})
                OR (source_memory_id = ${p.bId} AND target_memory_id = ${p.aId}))
            RETURNING id
          `;
          if (updated.length) {
            count++;
            for (const id of [p.aId, p.bId]) {
              recordAudit({
                memoryId: id,
                action: "review",
                actor: "web",
                diff: { keepBoth: true, pairedWith: id === p.aId ? p.bId : p.aId },
              }).catch(() => {});
            }
          }
        }
        return json({ dismissed: count });
      } catch (err) {
        return json({ error: (err as Error).message }, 400);
      }
    }

    // POST /api/duplicates/restore  body: { ids: string[] }
    // Undo for the duplicates view's delete: clears deleted_at on each row.
    if (req.method === "POST" && pathname === "/api/duplicates/restore") {
      try {
        const body = (await req.json()) as { ids?: unknown };
        const ids = z.array(z.string().uuid()).min(1).max(100).parse(body.ids);
        const restored: string[] = [];
        for (const id of ids) {
          const r = await restoreMemory({ id }, { actor: "web", reason: "undo duplicate delete" });
          if (!("error" in r)) restored.push(id);
        }
        return json({ restored, count: restored.length });
      } catch (err) {
        return json({ error: (err as Error).message }, 400);
      }
    }

    // POST /api/memories/:id/review  body: { action, notes?, relatedId? }
    const reviewMatch = pathname.match(new RegExp(`^/api/memories/(${ID_RE})/review$`, "i"));
    if (req.method === "POST" && reviewMatch) {
      try {
        const body = await req.json();
        const parsed = ReviewMemorySchema.parse({ ...body, id: reviewMatch[1] });
        const result = await reviewMemory(parsed, { actor: "user" });
        if ("error" in result) return json(result, 400);
        return json(result);
      } catch (err) {
        return json({ error: (err as Error).message }, 400);
      }
    }

    // GET /api/memories/:id — full detail incl. governance + linked memories.
    const detailMatch = pathname.match(new RegExp(`^/api/memories/(${ID_RE})$`, "i"));
    if (req.method === "GET" && detailMatch) {
      const id = detailMatch[1];
      const m = await recallMemory({ id });
      if ("error" in m) return json(m, 404);
      // Linked (related) memories from the similarity-link table. Lineage
      // (derived_from) is surfaced separately via recallMemory's
      // derivedFrom/derivatives, so it's excluded from plain Connections here.
      const links = (await pg`
        SELECT source_memory_id AS s, target_memory_id AS t, similarity
        FROM memory_links
        WHERE (source_memory_id = ${id} OR target_memory_id = ${id})
          AND relationship <> 'derived_from'
        ORDER BY similarity DESC
        LIMIT 20
      `) as any[];
      const linkedIds = links.map((l) => (l.s === id ? l.t : l.s));
      let linkedMemories: any[] = [];
      if (linkedIds.length) {
        const linkedRows = (await pg`
          SELECT id, content, memory_type AS "memoryType", created_at AS "createdAt"
          FROM memories WHERE id = ANY(${linkedIds}) AND deleted_at IS NULL
        `) as any[];
        const simById = new Map(links.map((l) => [l.s === id ? l.t : l.s, Number(l.similarity)]));
        linkedMemories = linkedRows.map((r) => ({ ...r, similarity: simById.get(r.id) ?? 0 }))
          .sort((a, b) => b.similarity - a.similarity);
      }
      return json({ ...m, people: peopleOf(m.entities), ...governanceView(m), linkedMemories });
    }

    // PUT /api/memories/:id — inline edit (content / type / tags).
    if (req.method === "PUT" && detailMatch) {
      try {
        const body = await req.json();
        const parsed = UpdateMemorySchema.parse({ ...body, id: detailMatch[1] });
        const result = await updateMemory(parsed, { actor: "user" });
        if ("error" in result) return json(result, 404);
        return json(result);
      } catch (err) {
        return json({ error: (err as Error).message }, 400);
      }
    }

    // PATCH /api/memories/:id/tags  body: { add?: string[], remove?: string[] }
    const tagMatch = pathname.match(/^\/api\/memories\/([0-9a-f-]{36})\/tags$/i);
    if (req.method === "PATCH" && tagMatch) {
      try {
        const id = tagMatch[1];
        const body = (await req.json()) as { add?: string[]; remove?: string[] };
        const [row] = await db
          .select({ tags: memories.tags })
          .from(memories)
          .where(and(eq(memories.id, id), isNull(memories.deletedAt)));
        if (!row) return json({ error: "not found" }, 404);

        const set = new Set(row.tags ?? []);
        for (const t of body.add ?? []) {
          const trimmed = t.trim();
          if (trimmed) set.add(trimmed);
        }
        for (const t of body.remove ?? []) set.delete(t);

        const result = await updateMemory({ id, tags: Array.from(set) }, { actor: "user" });
        return json(result);
      } catch (err) {
        return json({ error: (err as Error).message }, 400);
      }
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`OpenBrain UI → http://0.0.0.0:${PORT}`);
