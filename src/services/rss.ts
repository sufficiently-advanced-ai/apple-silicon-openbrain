import { XMLParser } from "fast-xml-parser";
import { ingestUrl } from "./ingest.js";
import type { sources } from "../db/schema.js";

type SourceRow = typeof sources.$inferSelect;

interface RssConfig {
  feedUrl?: string;
  url?: string;
  followLinks?: boolean;
}

interface FeedItem {
  link: string;
  title?: string;
  /** ISO publication date, when the feed provides one. */
  publishedAt?: string;
}

/** Parse a feed date field into ISO, or undefined when absent/unparseable. */
function feedDate(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // Convert single-element arrays into actual arrays so we can iterate uniformly.
  isArray: (name) => ["item", "entry"].includes(name),
  // Simon Willison's feed has >1000 entity expansions; raise the default cap.
  processEntities: {
    maxTotalExpansions: 5000,
  },
});

function extractItems(feed: unknown): FeedItem[] {
  const root = (feed as { rss?: unknown; feed?: unknown }) ?? {};

  // RSS 2.0: <rss><channel><item>...</item></channel></rss>
  const rssChannel = (root.rss as { channel?: { item?: unknown[] } } | undefined)?.channel;
  if (rssChannel?.item) {
    return rssChannel.item
      .map((raw): FeedItem | null => {
        const i = raw as { link?: string | { "@_href"?: string }; title?: string; pubDate?: string };
        const link = typeof i.link === "string" ? i.link : i.link?.["@_href"];
        if (!link) return null;
        return { link, title: i.title, publishedAt: feedDate(i.pubDate) };
      })
      .filter((x): x is FeedItem => x !== null);
  }

  // Atom: <feed><entry>...</entry></feed>
  const atomEntries = (root.feed as { entry?: unknown[] } | undefined)?.entry;
  if (atomEntries) {
    return atomEntries
      .map((raw): FeedItem | null => {
        const e = raw as {
          link?: unknown;
          title?: string | { "#text"?: string };
          published?: string;
          updated?: string;
        };
        // Atom <link> can be a string, an object with @_href, or an array of either.
        const links = Array.isArray(e.link) ? e.link : [e.link];
        const linkObj = links.find((l): l is string | { "@_href"?: string; "@_rel"?: string } => l != null);
        const href =
          typeof linkObj === "string"
            ? linkObj
            : (linkObj as { "@_href"?: string; "@_rel"?: string } | undefined)?.["@_href"];
        if (!href) return null;
        const title = typeof e.title === "string" ? e.title : e.title?.["#text"];
        return { link: href, title, publishedAt: feedDate(e.published ?? e.updated) };
      })
      .filter((x): x is FeedItem => x !== null);
  }

  return [];
}

export async function fetchAndParseFeed(feedUrl: string): Promise<FeedItem[]> {
  const res = await fetch(feedUrl, {
    headers: { "user-agent": "openbrain-rss/1.0 (+https://github.com/sajennings79/apple-silicon-openbrain)" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`feed fetch failed: ${res.status} ${res.statusText}`);
  }
  const xml = await res.text();
  const parsed = parser.parse(xml);
  return extractItems(parsed);
}

export async function syncRssSource(source: SourceRow): Promise<{ ingested: number; duplicates: number }> {
  const cfg = (source.config ?? {}) as RssConfig;
  const feedUrl = cfg.feedUrl ?? cfg.url;
  if (!feedUrl) throw new Error(`source ${source.id} missing config.feedUrl`);

  const items = await fetchAndParseFeed(feedUrl);

  let ingested = 0;
  let duplicates = 0;
  for (const item of items) {
    try {
      const result = await ingestUrl(item.link, { sourceDate: item.publishedAt });
      if (result.status === "created") ingested++;
      else duplicates++;
    } catch (err) {
      // Don't let one bad item kill the whole batch — log and continue.
      console.warn(`[rss] failed to ingest ${item.link}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return { ingested, duplicates };
}
