import { describe, expect, test } from "bun:test";
import { parseFeed } from "../services/rss.js";

/**
 * A post body of escaped HTML, like every real blog feed carries. Each &lt;/&gt;
 * is an entity expansion charged against fast-xml-parser's per-document budget,
 * so a feed's expansion count tracks how much its authors wrote -- not anything
 * we read. 3000 tags puts this well past the 5000 cap on its own.
 */
const body = (tags: number) =>
  Array.from({ length: tags }, (_, i) => `&lt;p&gt;Paragraph ${i + 1} with a &amp; in it.&lt;/p&gt;`).join("");

const atom = (entries: number, tagsPerBody: number) =>
  `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom">
${Array.from({ length: entries }, (_, i) => `<entry>
  <title>Post ${i + 1} on agents &amp; ops</title>
  <link href="https://example.test/post-${i + 1}?a=1&amp;b=2" rel="alternate"/>
  <published>2026-09-${String(i + 1).padStart(2, "0")}T12:00:00Z</published>
  <updated>2026-09-${String(i + 1).padStart(2, "0")}T12:30:00Z</updated>
  <summary type="html">${body(tagsPerBody)}</summary>
</entry>`).join("\n")}
</feed>`;

const rss = (entries: number, tagsPerBody: number) =>
  `<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel>
${Array.from({ length: entries }, (_, i) => `<item>
  <title>Item ${i + 1} on agents &amp; ops</title>
  <link>https://example.test/item-${i + 1}?a=1&amp;b=2</link>
  <pubDate>Tue, 0${(i % 9) + 1} Sep 2026 12:00:00 GMT</pubDate>
  <description>${body(tagsPerBody)}</description>
</item>`).join("\n")}
</channel></rss>`;

describe("parseFeed entity budget", () => {
  // Regression: the cap was raised 1000 -> 5000 and the feed outgrew it again
  // (production error: "Entity expansion limit exceeded: 5100 > 5000"). Post
  // bodies must not be charged to the budget at all, or this recurs forever.
  test("parses a feed whose bodies hold far more entities than the expansion cap", () => {
    const items = parseFeed(atom(30, 3000));
    expect(items).toHaveLength(30);
    expect(items[0].link).toBe("https://example.test/post-1?a=1&b=2");
    expect(items[0].title).toBe("Post 1 on agents & ops");
    expect(items[0].publishedAt).toBe("2026-09-01T12:00:00.000Z");
  });

  test("applies to RSS <description> bodies too, not just Atom <summary>", () => {
    const items = parseFeed(rss(30, 3000));
    expect(items).toHaveLength(30);
    expect(items[0].link).toBe("https://example.test/item-1?a=1&b=2");
    expect(items[0].title).toBe("Item 1 on agents & ops");
    expect(items[0].publishedAt).toBeDefined();
  });

  test("skips YouTube <media:description> bodies, which are not read either", () => {
    const yt = `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
${Array.from({ length: 15 }, (_, i) => `<entry>
  <title>Video ${i + 1}</title>
  <link rel="alternate" href="https://www.youtube.com/watch?v=vid${i + 1}"/>
  <published>2026-09-01T12:00:00Z</published>
  <media:group><media:description>${body(500)}</media:description></media:group>
</entry>`).join("")}
</feed>`;
    const items = parseFeed(yt);
    expect(items).toHaveLength(15);
    expect(items[0].link).toBe("https://www.youtube.com/watch?v=vid1");
  });

  test("still rejects an entity bomb in a field we actually read", () => {
    const bomb = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>${"&lt;".repeat(6000)}</title>
      <link href="https://example.test/x"/><updated>2026-09-01T00:00:00Z</updated></entry></feed>`;
    expect(() => parseFeed(bomb)).toThrow(/Entity expansion limit exceeded/);
  });
});

describe("parseFeed entity decoding", () => {
  const one = (title: string) =>
    parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>${title}</title>
      <link href="https://example.test/p?a=1&amp;b=2"/><updated>2026-09-01T00:00:00Z</updated></entry></feed>`)[0];

  test("decodes the standard XML entities in titles", () => {
    expect(one("Tom &amp; Jerry &lt;3 &quot;quoted&quot;").title).toBe('Tom & Jerry <3 "quoted"');
  });

  // Without htmlEntities these reach memory as the literal text "&#8217;".
  test("decodes numeric character references in titles", () => {
    expect(one("caf&#233; &#8217;quoted&#8217; &#8212; done").title).toBe("café ’quoted’ — done");
  });

  test("decodes the symbol entities htmlEntities covers", () => {
    expect(one("Price: 5&euro; / 4&pound; &copy;2026 &nbsp;x").title).toBe("Price: 5€ / 4£ ©2026  x");
  });

  // Boundary, so nobody assumes more coverage than exists: fast-xml-parser's
  // htmlEntities table is numeric refs plus a short symbol list, NOT the full
  // HTML named set. Feeds emitting bare &rsquo;/&mdash; (invalid XML without a
  // DTD declaring them) keep the literal text. No live feed title does today --
  // they emit raw UTF-8 punctuation -- so this documents rather than endorses.
  test("leaves undeclared named entities untouched", () => {
    expect(one("Simon&rsquo;s post &mdash; done").title).toBe("Simon&rsquo;s post &mdash; done");
  });

  test("decodes entities in link attributes so query strings survive", () => {
    expect(one("x").link).toBe("https://example.test/p?a=1&b=2");
  });
});
