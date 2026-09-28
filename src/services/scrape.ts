import { config } from "../lib/config.js";
import { extractMainContent, type Extracted } from "./extract.js";

const FIRECRAWL_API = "https://api.firecrawl.dev/v1";

export interface ScrapeResult {
  title: string;
  /** Firecrawl's full-page markdown, navigation included. Landing-page link
   * discovery (sourceSync) depends on it, so it is never replaced. */
  markdown: string;
  /** Main content extracted from the rendered HTML (Readability), or null
   * when extraction found no plausible article. What gets stored. */
  article: Extracted | null;
  url: string;
  source: "firecrawl";
}

/** The text to store for a scraped page: the extracted article when there is
 * one, else Firecrawl's markdown. */
export function storableText(scraped: ScrapeResult): string {
  return scraped.article?.markdown ?? scraped.markdown;
}

export async function scrapeUrl(url: string): Promise<ScrapeResult> {
  if (!config.firecrawlApiKey) {
    throw new Error("FIRECRAWL_API_KEY is not set");
  }

  const res = await fetch(`${FIRECRAWL_API}/scrape`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.firecrawlApiKey}`,
    },
    // rawHtml is the JS-rendered page; main-content extraction runs on it
    // locally. Same credit cost as markdown alone.
    body: JSON.stringify({ url, formats: ["markdown", "rawHtml"] }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Firecrawl HTTP ${res.status}: ${body}`);
  }

  const data = (await res.json()) as {
    success: boolean;
    data?: {
      markdown?: string;
      rawHtml?: string;
      metadata?: { title?: string; sourceURL?: string };
    };
    error?: string;
  };

  if (!data.success) {
    throw new Error(`Firecrawl scrape failed: ${data.error ?? "unknown error"}`);
  }

  const finalUrl = data.data?.metadata?.sourceURL ?? url;
  const article = extractMainContent(data.data?.rawHtml ?? "", finalUrl);
  const result: ScrapeResult = {
    title: article?.title || data.data?.metadata?.title || url,
    markdown: data.data?.markdown ?? "",
    article,
    url: finalUrl,
    source: "firecrawl",
  };
  console.log(
    `[scrape] Firecrawl succeeded for ${url} (${result.markdown.length} chars page, ` +
      `${article ? `${article.markdown.length} chars article` : "no article extracted"})`,
  );
  return result;
}
