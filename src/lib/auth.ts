import { config } from "./config.js";

/**
 * Request trust model. The system is intentionally open to every device on the
 * tailnet (and the local LAN) — the bearer token only guards against traffic
 * from outside those networks. What this module fixes is the old logic's two
 * holes:
 *
 *  1. X-Forwarded-For was trusted unconditionally, so ANY client could spoof
 *     `X-Forwarded-For: 127.0.0.1` and be treated as local. XFF is now only
 *     consulted when the socket peer is actually loopback — i.e. the request
 *     came through the local `tailscale serve` proxy, the one legitimate
 *     writer of that header here.
 *  2. The check existed only on /mcp. The same gate now fronts the /api/*
 *     routes and the UI server.
 */

/** Strip the IPv6-mapped-IPv4 prefix and lowercase. */
function normalizeIp(ip: string): string {
  const lower = ip.trim().toLowerCase();
  return lower.startsWith("::ffff:") ? lower.slice(7) : lower;
}

function isLoopback(ip: string): boolean {
  return ip === "::1" || ip.startsWith("127.");
}

/** Trusted networks: loopback, Tailscale CGNAT + ULA, RFC1918 LAN, link-local. */
export function isTrustedIp(rawIp: string | undefined | null): boolean {
  if (!rawIp) return false;
  const ip = normalizeIp(rawIp);
  if (isLoopback(ip)) return true;

  // IPv6: Tailscale addresses live in fd7a:115c:a1e0::/48, inside the fc00::/7
  // unique-local block; fe80::/10 is link-local.
  if (ip.includes(":")) {
    return ip.startsWith("fd") || ip.startsWith("fc") || ip.startsWith("fe80:");
  }

  const octets = ip.split(".").map(Number);
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
    return false;
  }
  const [a, b] = octets;
  if (a === 100 && b >= 64 && b <= 127) return true; // Tailscale CGNAT 100.64.0.0/10
  if (a === 10) return true; // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 169 && b === 254) return true; // link-local
  return false;
}

/**
 * Effective client IP. X-Forwarded-For is honored ONLY when the socket peer is
 * loopback (a local reverse proxy like `tailscale serve`); a remote client
 * sending its own XFF header is ignored — that was the spoofable hole.
 */
export function clientIp(req: Request, socketIp: string | undefined | null): string | undefined {
  if (socketIp && isLoopback(normalizeIp(socketIp))) {
    const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return forwarded;
  }
  return socketIp ?? undefined;
}

/**
 * Gate for state-touching routes. Trusted networks pass; anything else needs
 * the bearer token. With AUTH_TOKEN unset, everything passes (current
 * single-box posture).
 */
export function isAuthorizedRequest(req: Request, socketIp: string | undefined | null): boolean {
  if (!config.authToken) return true;
  if (isTrustedIp(clientIp(req, socketIp))) return true;
  return req.headers.get("authorization") === `Bearer ${config.authToken}`;
}
