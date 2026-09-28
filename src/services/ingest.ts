import { db } from "../db/client.js";
import { memories } from "../db/schema.js";
import { eq, and, isNull } from "drizzle-orm";
import { scrapeUrl, storableText } from "./scrape.js";
import { isYouTubeUrl, fetchYouTubeTranscript } from "./youtube.js";
import { storeMemory } from "../tools/StoreMemory.js";

export interface IngestResult {
  status: "created" | "duplicate";
  id: string;
  title: string;
}

export async function ingestUrl(
  targetUrl: string,
  opts: {
    /** ISO date the content was originally published (e.g. RSS pubDate). */
    sourceDate?: string;
  } = {},
): Promise<IngestResult> {
  // A URL maps deterministically to one source, so dedup on (source, source_id)
  // to match the partial unique index and avoid re-scraping known URLs.
  const source = isYouTubeUrl(targetUrl) ? "youtube" : "web";

  const existing = await db
    .select({ id: memories.id, summary: memories.summary })
    .from(memories)
    .where(
      and(
        eq(memories.source, source),
        eq(memories.sourceId, targetUrl),
        isNull(memories.deletedAt),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    return { status: "duplicate", id: existing[0].id, title: existing[0].summary ?? targetUrl };
  }

  if (source === "youtube") {
    const yt = await fetchYouTubeTranscript(targetUrl);
    const result = await storeMemory(
      {
        content: yt.transcript,
        source: "youtube",
        sourceId: targetUrl,
        memoryType: "fact",
        sourceDate: yt.uploadDate ?? opts.sourceDate,
      },
      { createdBy: "import" },
    );
    return { status: "created", id: result.id, title: yt.title };
  }

  const scraped = await scrapeUrl(targetUrl);
  const result = await storeMemory(
    {
      content: storableText(scraped),
      source: "web",
      sourceId: targetUrl,
      memoryType: "fact",
      sourceDate: opts.sourceDate,
    },
    { createdBy: "import" },
  );
  return { status: "created", id: result.id, title: scraped.title };
}
