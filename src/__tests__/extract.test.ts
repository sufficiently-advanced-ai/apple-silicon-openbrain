import { describe, expect, test } from "bun:test";
import { emailHtmlToMarkdown, extractMainContent, topicLabels } from "../services/extract.js";

const para = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    `<p>Paragraph ${i + 1} of the article discusses how agents moved into operations, with concrete numbers from three deployments and what each team learned about review gates.</p>`,
  ).join("\n");

const PAGE = `<!doctype html><html><head><title>Agents in Ops | Example Blog</title></head><body>
<a href="#main">Skip to content</a>
<nav><ul><li><a href="/">Home</a></li><li><a href="/blog">Blog</a></li><li><a href="/about">About</a></li></ul></nav>
<div class="share"><a href="https://x.com/share">Share on X</a> <a href="https://facebook.com/share">Facebook</a></div>
<main id="main"><article><h1>Agents in Ops</h1>
<img src="/hero.png" alt="hero"><a href="https://ci.example.com"><img src="https://img.shields.io/badge.svg" alt="CI"></a>
${para(6)}
<pre><code>const x = 1;</code></pre>
</article></main>
<footer><p>© 2026 Example Inc. <a href="/privacy">Privacy</a> <a href="/cookies">Cookie settings</a></p></footer>
</body></html>`;

describe("extractMainContent", () => {
  test("keeps the article and drops navigation, share bars, footer and images", () => {
    const ex = extractMainContent(PAGE, "https://example.com/blog/agents");
    expect(ex).not.toBeNull();
    const md = ex!.markdown;
    expect(md).toContain("Paragraph 1 of the article");
    expect(md).toContain("Paragraph 6 of the article");
    expect(md).toContain("```");
    for (const chrome of ["Skip to content", "Share on X", "Cookie settings", "hero.png", "shields.io", "About"]) {
      expect(md).not.toContain(chrome);
    }
    expect(md).not.toMatch(/\[\s*\]\(/); // no empty links left by removed badges
  });

  test("returns null when there is no plausible article, so callers fall back", () => {
    expect(extractMainContent("<html><body><nav><a href='/'>Home</a></nav></body></html>")).toBeNull();
    expect(extractMainContent("")).toBeNull();
  });
});

describe("emailHtmlToMarkdown", () => {
  const NEWSLETTER = `<html><body>
<div style="display:none;max-height:0">Preheader text you never see &zwnj;&zwnj;&zwnj;</div>
<table><tr><td><a href="https://example.substack.com/p/post">View this post on the web</a></td></tr></table>
<table><tr><td><h1>Weekly issue</h1>${para(5)}</td></tr></table>
<table><tr><td>${para(1)}</td></tr></table>
<p>You're receiving this email because you subscribed to Example.</p>
<p><a href="https://example.substack.com/unsubscribe">Unsubscribe</a></p>
<p>123 Market Street, San Francisco, CA</p>
</body></html>`;

  test("main content as markdown, hidden preheader and footer removed", () => {
    const md = emailHtmlToMarkdown(NEWSLETTER);
    expect(md).toContain("Paragraph 1 of the article");
    expect(md).not.toContain("Preheader text");
    expect(md).not.toContain("‌");
    expect(md).not.toContain("Unsubscribe");
    expect(md).not.toContain("Market Street");
  });
});

describe("topicLabels", () => {
  test("drops Gmail system labels, keeps user topics", () => {
    expect(topicLabels(["UNREAD", "INBOX", "CATEGORY_UPDATES", "IMPORTANT", "Label_42", "ai-news"])).toEqual(["ai-news"]);
    expect(topicLabels(undefined)).toEqual([]);
  });
});

describe("prose fallback", () => {
  test("minimal page with text directly in <body> is extracted", () => {
    const body = Array.from({ length: 12 }, (_, i) => `<p>Paragraph ${i} of a hand-written essay about bug blindness and why people stop seeing defects they walk past every day.</p>`).join("");
    const html = `<html><head><title>Bug blind</title></head><body><a href="/">home</a>${body}</body></html>`;
    const ex = extractMainContent(html, "https://danluu.com/bug-blind/");
    expect(ex).not.toBeNull();
    expect(ex!.markdown).toContain("Paragraph 11 of a hand-written essay");
  });

  test("link-heavy pages never take the fallback", () => {
    const links = Array.from({ length: 80 }, (_, i) => `<a href="/p/${i}">Post number ${i} in the archive list</a><br>`).join("");
    expect(extractMainContent(`<html><body>${links}</body></html>`)).toBeNull();
  });
});

test("pages that omit the optional <head>/<body> tags still extract", () => {
  const paras = Array.from({ length: 12 }, (_, i) => `<p>Paragraph ${i} of an essay published without optional tags, which HTML5 allows and some minimalist blogs use.`).join("\n");
  const html = `<!DOCTYPE html><html lang=en><meta charset=utf-8><title>Bug blindness</title><style>p{}</style><a href=/>home</a>\n${paras}`;
  const ex = extractMainContent(html, "https://danluu.com/bug-blind/");
  expect(ex).not.toBeNull();
  expect(ex!.markdown).toContain("Paragraph 11 of an essay");
  expect(ex!.markdown).not.toContain("p{}");
});
