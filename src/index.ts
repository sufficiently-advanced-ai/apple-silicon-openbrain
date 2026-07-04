import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer } from "./server.js";
import { config } from "./lib/config.js";
import { isAuthorizedRequest } from "./lib/auth.js";
import { ingestUrl } from "./services/ingest.js";
import { enrichmentQueueDepth } from "./services/enrichment.js";
import { handleSourcesRoute } from "./api/sources.js";

// Session management: map session IDs to their transport+server
const sessions = new Map<
  string,
  {
    transport: WebStandardStreamableHTTPServerTransport;
    server: ReturnType<typeof createServer>;
    lastSeen: number;
  }
>();

// HTTP MCP clients that vanish without closing their session leak a Map entry
// (and a server object) forever — the live box had accumulated 80+. Sweep
// sessions idle past the TTL; a swept client just re-initializes on next use.
const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;
const SESSION_SWEEP_INTERVAL_MS = 15 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - SESSION_IDLE_MS;
  let swept = 0;
  for (const [id, session] of sessions) {
    if (session.lastSeen < cutoff) {
      sessions.delete(id);
      swept++;
      Promise.resolve(session.transport.close()).catch(() => {});
    }
  }
  if (swept > 0) console.log(`[sessions] swept ${swept} idle session(s), ${sessions.size} live`);
}, SESSION_SWEEP_INTERVAL_MS).unref();

const app = Bun.serve({
  port: config.mcpPort,
  hostname: config.mcpHost,
  idleTimeout: 255, // MCP sessions need long-lived connections (max for Bun)

  async fetch(req) {
    const url = new URL(req.url);

    // CORS preflight for /api/* routes (must run before auth)
    if (req.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // Trusted networks (loopback / tailnet / LAN) pass; anything else needs the
    // bearer token. Applies to /mcp AND /api/* — the old gate skipped /api/*
    // entirely and trusted a spoofable X-Forwarded-For (see lib/auth.ts).
    // /health stays open for probes.
    if (url.pathname !== "/health" && !isAuthorizedRequest(req, this.requestIP(req)?.address)) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (url.pathname === "/mcp") {
      const sessionId = req.headers.get("mcp-session-id");

      // Existing session
      if (sessionId && sessions.has(sessionId)) {
        const session = sessions.get(sessionId)!;
        session.lastSeen = Date.now();
        return session.transport.handleRequest(req);
      }

      // New session (initialization request)
      if (req.method === "POST") {
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, { transport, server, lastSeen: Date.now() });
          },
          onsessionclosed: (id) => {
            sessions.delete(id);
          },
        });

        const server = createServer();
        await server.connect(transport);

        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };

        return transport.handleRequest(req);
      }

      return new Response("Bad Request: missing session ID", { status: 400 });
    }

    // GET-based ingest for bookmarklet (avoids CSP issues on target pages)
    if (url.pathname === "/api/ingest" && req.method === "GET") {
      const targetUrl = url.searchParams.get("url");
      if (!targetUrl) {
        return new Response("<html><body style='font:14px monospace;background:#1a1a2e;color:#f00;padding:20px'>Missing ?url= parameter</body></html>", {
          status: 400,
          headers: { "Content-Type": "text/html" },
        });
      }

      try {
        const { status, title } = await ingestUrl(targetUrl);
        const safeTitle = title.replace(/</g, "&lt;");
        if (status === "duplicate") {
          return new Response(`<html><body style="font:14px monospace;background:#1a1a2e;color:#ff0;padding:20px">Already saved</body><script>setTimeout(()=>window.close(),1500)</script></html>`, {
            headers: { "Content-Type": "text/html" },
          });
        }
        return new Response(`<html><body style="font:14px monospace;background:#1a1a2e;color:#0f0;padding:20px">Saved: ${safeTitle}</body><script>setTimeout(()=>window.close(),2000)</script></html>`, {
          status: 201,
          headers: { "Content-Type": "text/html" },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message.replace(/</g, "&lt;") : "Internal error";
        return new Response(`<html><body style="font:14px monospace;background:#1a1a2e;color:#f00;padding:20px">Error: ${message}</body></html>`, {
          status: 500,
          headers: { "Content-Type": "text/html" },
        });
      }
    }

    if (url.pathname === "/api/ingest" && req.method === "POST") {
      const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json",
      };

      try {
        const body = (await req.json()) as { url?: string };
        if (!body.url || typeof body.url !== "string") {
          return Response.json({ error: "Missing 'url' field" }, { status: 400, headers: corsHeaders });
        }

        const result = await ingestUrl(body.url);
        const httpStatus = result.status === "created" ? 201 : 200;
        return Response.json(result, { status: httpStatus, headers: corsHeaders });
      } catch (err) {
        console.error("Ingest error:", err);
        const message = err instanceof Error ? err.message : "Internal error";
        return Response.json({ error: message }, { status: 500, headers: corsHeaders });
      }
    }

    if (url.pathname === "/health") {
      return Response.json({
        status: "ok",
        service: "openbrain",
        sessions: sessions.size,
        enrichmentQueueDepth: enrichmentQueueDepth(),
      });
    }

    // Sources CRUD + sync (Phase 0). Returns null if URL doesn't match.
    if (url.pathname.startsWith("/api/sources")) {
      const sourcesResponse = await handleSourcesRoute(req, url);
      if (sourcesResponse) return sourcesResponse;
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`OpenBrain MCP server listening on ${config.mcpHost}:${config.mcpPort}`);

// Boot-time sanity check: LLM_MODEL must match what mlx-lm actually has loaded,
// or every enrichment call hot-swaps the model and thrashes the GPU. Non-fatal —
// the server is useful without enrichment — but loud.
(async () => {
  try {
    const res = await fetch(`${config.llmUrl}/v1/models`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return;
    const data = (await res.json()) as { data?: { id?: string }[] };
    const loaded = (data.data ?? []).map((m) => m.id).filter(Boolean) as string[];
    if (loaded.length > 0 && !loaded.includes(config.llmModel)) {
      console.warn(
        `[llm] LLM_MODEL mismatch: config wants "${config.llmModel}" but mlx-lm has ` +
          `[${loaded.join(", ")}] loaded. Enrichment will hot-swap models and thrash the GPU — ` +
          `fix LLM_MODEL or the com.openbrain.llm plist.`,
      );
    }
  } catch {
    // mlx-lm not up yet (KeepAlive services race at boot) — enrichment has its
    // own retries; nothing to do here.
  }
})();
