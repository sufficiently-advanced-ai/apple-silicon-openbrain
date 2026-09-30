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

/**
 * Feed elements holding a full post or video body. We never read these (see
 * extractItems), but their escaped markup is ~99% of every entity reference in a
 * typical feed: across the live source set, <summary> and <media:description>
 * account for 5691 of 5700 expansions while the fields we do read account for 9.
 *
 * Entity processing is gated per-tag *before* the expansion counter is
 * incremented, so skipping these keeps the budget proportional to the fields we
 * actually use rather than to how much people wrote this week.
 */
const CONTENT_TAGS = new Set([
  "summary",
  "content",
  "content:encoded",
  "description",
  "media:description", // YouTube feeds put the whole video description here
  "itunes:summary",
  "itunes:subtitle",
  "dc:description",
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // Convert single-element arrays into actual arrays so we can iterate uniformly.
  isArray: (name) => ["item", "entry"].includes(name),
  // Feed titles routinely carry numeric refs for curly quotes and accents
  // (&#8217;, &#233;); without this they reach memory as literal "&#8217;".
  htmlEntities: true,
  processEntities: {
    // Decode entities everywhere except the bodies we discard. Raising the cap
    // instead is a treadmill: it was already bumped 1000 -> 5000 and the feed
    // outgrew it again.
    tagFilter: (tagName) => !CONTENT_TAGS.has(tagName),
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

/** Parse feed XML into items. Split from the fetch so it is testable offline. */
export function parseFeed(xml: string): FeedItem[] {
  return extractItems(parser.parse(xml));
}

export async function fetchAndParseFeed(feedUrl: string): Promise<FeedItem[]> {
  const res = await fetch(feedUrl, {
    headers: { "user-agent": "openbrain-rss/1.0 (+https://github.com/sajennings79/apple-silicon-openbrain)" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`feed fetch failed: ${res.status} ${res.statusText}`);
  }
  return parseFeed(await res.text());
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
