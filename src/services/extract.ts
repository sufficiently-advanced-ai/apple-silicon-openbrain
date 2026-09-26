/**
 * Main-content extraction: raw HTML -> clean markdown.
 *
 * Boilerplate (navigation, share bars, cookie banners, repo chrome, email
 * footers) is removed on the DOM, where text/link density and block structure
 * are still visible — the standard pattern (Firefox Reader View's Readability).
 * Once a page has been flattened to markdown those signals are gone, which is
 * why downstream line-level cleanup can only ever be a safety net.
 */
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";

export interface Extracted {
  title: string;
  markdown: string;
  byline?: string;
  publishedTime?: string;
}

/** Below this, Readability probably picked the wrong block — callers fall back. */
export const MIN_EXTRACTED_CHARS = 400;
/** Whole-body fallback only for pages that are mostly prose: minimal
 * hand-written pages (text directly in <body>) where Readability finds no
 * container to score, and which have little chrome to begin with. */
const FALLBACK_MIN_CHARS = 1500;
const FALLBACK_MAX_LINK_RATIO = 0.25;

/** Share of the visible text that sits inside links. An index/archive page
 * is mostly links; an article is mostly prose. */
export function linkTextRatio(markdown: string): number {
  const links = [...markdown.matchAll(/\[([^\]]*)\]\([^)]*\)/g)];
  const linkChars = links.reduce((n, m) => n + m[1].length, 0);
  const visible = markdown.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ").trim().length;
  return visible ? linkChars / visible : 0;
}
const MAX_ARTICLE_LINK_RATIO = 0.5;

function proseBodyFallback(document: Document): string | null {
  const body = document.body;
  if (!body) return null;
  for (const el of Array.from(body.querySelectorAll("nav, header, footer, aside, script, style, form"))) el.remove();
  const text = (body.textContent ?? "").replace(/\s+/g, " ").trim();
  if (text.length < FALLBACK_MIN_CHARS) return null;
  const linkText = Array.from(body.querySelectorAll("a"))
    .map((a) => (a.textContent ?? "").replace(/\s+/g, " ").trim().length)
    .reduce((x, y) => x + y, 0);
  if (linkText / text.length > FALLBACK_MAX_LINK_RATIO) return null;
  const markdown = htmlToMarkdown(body.innerHTML);
  return markdown.length >= MIN_EXTRACTED_CHARS ? markdown : null;
}

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});
// Images, media and embedded chrome carry no text worth keeping. Images get an
// explicit empty rule: turndown's built-in image rule outranks remove().
turndown.remove(["picture", "video", "audio", "iframe", "script", "style", "noscript", "form", "button"]);
turndown.addRule("dropImages", { filter: "img", replacement: () => "" });
// svg is not an HTML tag name in turndown's types, so it needs a filter function.
turndown.addRule("dropSvg", { filter: (node) => node.nodeName.toLowerCase() === "svg", replacement: () => "" });

const ZERO_WIDTH = new RegExp("[\\u200b\\u200c\\u200d\\u2060\\ufeff\\u034f\\u00ad]", "g");
// Links left empty once their image is gone (badges, logos).
const EMPTY_LINK = /\[\s*\]\([^)]*\)/g;

// Invisible preheader text and tracking pixels common in newsletter HTML.
const HIDDEN = /display\s*:\s*none|visibility\s*:\s*hidden|max-height\s*:\s*0|mso-hide\s*:\s*all/i;

/** HTML5 lets a page omit <head>/<body> (minimalist blogs do). linkedom then
 * leaves an empty <body> with the content as its siblings under <html>, and
 * Readability finds nothing (or crashes). Move stray content into <body>. */
function normalizeBody(document: Document): void {
  const root = document.documentElement;
  const body = document.body;
  if (!root || !body || (body.textContent ?? "").trim()) return;
  for (const node of Array.from(root.childNodes)) {
    const name = node.nodeName.toLowerCase();
    if (name === "head" || name === "body") continue;
    if (["title", "meta", "link", "style", "script", "base"].includes(name)) {
      document.head?.appendChild(node);
    } else {
      body.appendChild(node);
    }
  }
}

function parse(html: string): Document {
  const document = parseHTML(html).document as unknown as Document;
  normalizeBody(document);
  return document;
}

function stripHidden(document: Document): void {
  for (const el of Array.from(document.querySelectorAll("[style]"))) {
    if (HIDDEN.test(el.getAttribute("style") ?? "")) el.remove();
  }
}

export function htmlToMarkdown(html: string): string {
  return tidy(turndown.turndown(html));
}

/** Collapse whitespace and drop zero-width/entity residue. */
export function tidy(markdown: string): string {
  return markdown
    .replace(ZERO_WIDTH, "")
    .replace(EMPTY_LINK, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Extract the main content of a page. Returns null when Readability finds no
 * article or the result is implausibly short, so the caller can fall back.
 */
export function extractMainContent(html: string, url?: string): Extracted | null {
  if (!html || !html.trim()) return null;
  try {
    const document = parse(html);
    stripHidden(document);
    // Readability resolves relative links against the document URL.
    if (url) {
      const base = document.createElement("base");
      base.setAttribute("href", url);
      document.head?.appendChild(base);
    }
    // Readability mutates the document; keep a pristine copy for the fallback.
    const pristine = parse(html);
    let article: ReturnType<Readability["parse"]> = null;
    try {
      article = new Readability(document, { charThreshold: 200 }).parse();
    } catch (err) {
      console.warn(`[extract] Readability failed${url ? ` for ${url}` : ""}, trying prose fallback: ${err}`);
    }
    const markdown = article?.content ? htmlToMarkdown(article.content) : "";
    if (article && markdown.length >= MIN_EXTRACTED_CHARS) {
      if (linkTextRatio(markdown) > MAX_ARTICLE_LINK_RATIO) return null; // an index page, not an article
      return {
        title: (article.title ?? "").trim(),
        markdown,
        byline: article.byline?.trim() || undefined,
        publishedTime: article.publishedTime?.trim() || undefined,
      };
    }
    stripHidden(pristine);
    const fallback = proseBodyFallback(pristine);
    if (!fallback) return null;
    return { title: (pristine.title ?? "").trim(), markdown: fallback };
  } catch (err) {
    console.warn(`[extract] Readability failed${url ? ` for ${url}` : ""}: ${err}`);
    return null;
  }
}

// Email footers start at the first of these (only searched in the last third).
const FOOTER =
  /^\s*(unsubscribe\b|.*\bto unsubscribe\b|you(?:'|’)re receiving this (?:email|message)|you are receiving this (?:email|message)|manage (?:your )?(?:email )?(?:preferences|subscription)|update your (?:email )?preferences|this email was sent to\b)/i;

/** Newsletter/email HTML -> markdown: main content when Readability finds it,
 * else the whole body converted; footer trimmed either way. */
export function emailHtmlToMarkdown(html: string): string {
  const main = extractMainContent(html);
  let markdown: string;
  if (main) {
    markdown = main.markdown;
  } else {
    const document = parse(html);
    stripHidden(document);
    markdown = htmlToMarkdown(document.body?.innerHTML ?? html);
  }
  const lines = markdown.split("\n");
  for (let i = Math.floor((lines.length * 2) / 3); i < lines.length; i++) {
    if (FOOTER.test(lines[i])) {
      return tidy(lines.slice(0, i).join("\n"));
    }
  }
  return markdown;
}

// Gmail system labels are mailbox state, not topics.
const GMAIL_SYSTEM_LABEL = /^(UNREAD|INBOX|IMPORTANT|STARRED|SENT|DRAFT|SPAM|TRASH|CHAT|CATEGORY_[A-Z_]+|Label_\d+)$/;

export function topicLabels(labelIds: string[] | undefined): string[] {
  return (labelIds ?? []).filter((l) => !GMAIL_SYSTEM_LABEL.test(l));
}
