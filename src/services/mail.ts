import { db } from "../db/client.js";
import { emailHtmlToMarkdown, topicLabels } from "./extract.js";
import { memories, type sources } from "../db/schema.js";
import { eq, and, isNull } from "drizzle-orm";
import { storeMemory } from "../tools/StoreMemory.js";
import { ingestUrl } from "./ingest.js";

type SourceRow = typeof sources.$inferSelect;

interface MailConfig {
  account?: string;
  query?: string;
  maxMessages?: number;
  followLinks?: boolean; // if true, extract article URLs from body and ingest each one
}

// URLs to skip when following links — unsubscribe, tracking, social, image CDNs, etc.
const SKIP_URL_PATTERNS = [
  /unsubscribe/i,
  /manage[-_]?pref/i,
  /email[-_]?settings/i,
  /\/track\//i,
  /\/open\//i,
  /\/beacon\//i,
  /\/click\//i,
  /\/redirect\//i,
  /twitter\.com\//i,
  /x\.com\//i,
  /linkedin\.com\/company/i,
  /facebook\.com\//i,
  /instagram\.com\//i,
  /\.(png|jpg|jpeg|gif|svg|webp)(\?|$)/i,
  /mailto:/i,
];

function extractLinks(text: string): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
  // Match http/https URLs — stop at whitespace, angle brackets, quotes, parens
  const re = /https?:\/\/[^\s<>"')\]]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    let url = m[0].replace(/[.,;:!?]+$/, ""); // strip trailing punctuation
    try { url = new URL(url).href; } catch { continue; }
    if (seen.has(url)) continue;
    if (SKIP_URL_PATTERNS.some((p) => p.test(url))) continue;
    seen.add(url);
    results.push(url);
  }
  return results;
}

interface SearchResult {
  nextPageToken?: string;
  threads: { id: string; date: string; from: string; subject: string; labels: string[] }[];
}

interface PayloadHeader {
  name: string;
  value: string;
}

interface Payload {
  mimeType: string;
  headers?: PayloadHeader[];
  body?: { data?: string; size?: number };
  parts?: Payload[];
}

interface FullMessage {
  message: {
    id: string;
    threadId: string;
    internalDate: string;
    labelIds?: string[];
    snippet?: string;
    payload: Payload;
  };
}

const GOG_BIN = process.env.GOG_PATH ?? "gog";
const DEFAULT_QUERY = "newer_than:1d -in:spam -in:trash";
const DEFAULT_MAX = 25;

async function runGog<T>(args: string[]): Promise<T> {
  const proc = Bun.spawn([GOG_BIN, ...args], { stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`gog ${args.join(" ")} exited with ${code}: ${stderr.slice(0, 400)}`);
  }
  const stdout = await new Response(proc.stdout).text();
  try {
    return JSON.parse(stdout) as T;
  } catch (err) {
    throw new Error(`gog returned non-JSON: ${stdout.slice(0, 200)}: ${err}`);
  }
}

function decodeBase64Url(data: string): string {
  // Gmail returns URL-safe base64 without padding.
  return Buffer.from(data, "base64url").toString("utf-8");
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Body as markdown for storage: the HTML part through main-content
 * extraction (Readability), else plain text. */
function extractBodyMarkdown(payload: Payload): string {
  const html = findPart(payload, "text/html");
  if (html?.body?.data) {
    const markdown = emailHtmlToMarkdown(decodeBase64Url(html.body.data));
    if (markdown.trim()) return markdown;
  }
  return extractBody(payload);
}

function findPart(payload: Payload, mimeType: string): Payload | undefined {
  if (payload.mimeType === mimeType && payload.body?.data) return payload;
  for (const part of payload.parts ?? []) {
    const found = findPart(part, mimeType);
    if (found) return found;
  }
  return undefined;
}

/** Legacy flattened text (hrefs dropped). Still used for followLinks so link
 * discovery doesn't start picking up every tracking link in a newsletter. */
function extractBody(payload: Payload): string {
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  if (payload.mimeType === "text/html" && payload.body?.data) {
    return stripHtml(decodeBase64Url(payload.body.data));
  }
  if (payload.parts) {
    const plain = payload.parts.find((p) => p.mimeType === "text/plain");
    if (plain) {
      const text = extractBody(plain);
      if (text) return text;
    }
    const html = payload.parts.find((p) => p.mimeType === "text/html");
    if (html) {
      const text = extractBody(html);
      if (text) return text;
    }
    for (const part of payload.parts) {
      const text = extractBody(part);
      if (text) return text;
    }
  }
  return "";
}

function getHeader(headers: PayloadHeader[] | undefined, name: string): string {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

async function alreadyIngested(sourceId: string): Promise<boolean> {
  const rows = await db
    .select({ id: memories.id })
    .from(memories)
    .where(and(eq(memories.source, "mail"), eq(memories.sourceId, sourceId), isNull(memories.deletedAt)))
    .limit(1);
  return rows.length > 0;
}

export async function syncMailSource(source: SourceRow): Promise<{ ingested: number; duplicates: number }> {
  const cfg = (source.config ?? {}) as MailConfig;
  const account = cfg.account;
  if (!account) throw new Error(`mail source ${source.id} missing config.account`);

  const query = cfg.query ?? DEFAULT_QUERY;
  const max = cfg.maxMessages ?? DEFAULT_MAX;

  const search = await runGog<SearchResult>([
    "gmail",
    "search",
    query,
    "--account",
    account,
    "--json",
    "--max",
    String(max),
  ]);

  let ingested = 0;
  let duplicates = 0;

  for (const thread of search.threads ?? []) {
    if (await alreadyIngested(thread.id)) {
      duplicates++;
      continue;
    }
    try {
      const full = await runGog<FullMessage>([
        "gmail",
        "get",
        thread.id,
        "--account",
        account,
        "--format",
        "full",
        "--json",
      ]);

      const msg = full.message;
      const subject = getHeader(msg.payload.headers, "Subject") || thread.subject || "(no subject)";
      const from = getHeader(msg.payload.headers, "From") || thread.from || "(unknown)";
      const date = getHeader(msg.payload.headers, "Date") || thread.date;
      const body = extractBodyMarkdown(msg.payload) || msg.snippet || "(empty body)";

      // Gmail system labels (UNREAD, INBOX, CATEGORY_*) are mailbox state, not
      // content: kept out of the text and the tags.
      const content = `# ${subject}\n\nFrom: ${from}\nDate: ${date}\nAccount: ${account}\n\n---\n\n${body}`;

      // internalDate is Gmail's ms-epoch receipt time; fall back to the Date
      // header. Either way the memory carries when the mail arrived, not when
      // the poll happened to run.
      const internalMs = Number(msg.internalDate);
      const receivedAt = Number.isFinite(internalMs) && internalMs > 0
        ? new Date(internalMs).toISOString()
        : !Number.isNaN(Date.parse(date))
          ? new Date(date).toISOString()
          : undefined;

      await storeMemory(
        {
          content,
          source: "mail",
          sourceId: msg.id,
          memoryType: "fact",
          tags: topicLabels(msg.labelIds),
          sourceDate: receivedAt,
        },
        { createdBy: "import" },
      );
      ingested++;

      // If followLinks is enabled, extract and ingest each linked article
      if (cfg.followLinks) {
        const links = extractLinks(extractBody(msg.payload));
        for (const link of links) {
          try {
            const r = await ingestUrl(link);
            if (r.status === "created") ingested++;
            else duplicates++;
          } catch (err) {
            console.warn(`[mail] followLinks: failed to ingest ${link}: ${err instanceof Error ? err.message : err}`);
          }
        }
      }
    } catch (err) {
      console.warn(
        `[mail] failed to ingest ${thread.id}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  return { ingested, duplicates };
}
