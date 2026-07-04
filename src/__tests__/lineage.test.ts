import { test, expect } from "bun:test";
import { extractRefs, normalizeUrl } from "../services/lineage.js";

// Pure detection logic — no DB. The deterministic back-reference extraction is
// what turns a source→enrichment pair (which read as duplicates) into lineage.

test("normalizeUrl strips scheme, www, query, fragment, trailing slash", () => {
  expect(normalizeUrl("https://www.Example.com/Foo/?utm=1#frag")).toBe("example.com/foo");
  expect(normalizeUrl("http://example.com/a/b/")).toBe("example.com/a/b");
  expect(normalizeUrl("https://example.com/path).")).toBe("example.com/path");
});

test("extractRefs pulls the YouTube video id from a watch URL (the obsidian-note case)", () => {
  const note = `## Theo's vendor comparison\n\nblah blah\n\nVideo: https://www.youtube.com/watch?v=JMYspR42HFM`;
  expect(extractRefs(note)).toEqual(["JMYspR42HFM"]);
});

test("extractRefs handles youtu.be, embed, and shorts forms", () => {
  expect(extractRefs("see https://youtu.be/JMYspR42HFM")).toEqual(["JMYspR42HFM"]);
  expect(extractRefs("https://www.youtube.com/embed/JMYspR42HFM x")).toEqual(["JMYspR42HFM"]);
  expect(extractRefs("https://youtube.com/shorts/JMYspR42HFM")).toEqual(["JMYspR42HFM"]);
});

test("extractRefs does NOT emit a generic youtube.com/watch needle (would match everything)", () => {
  const refs = extractRefs("https://www.youtube.com/watch?v=JMYspR42HFM");
  expect(refs).toEqual(["JMYspR42HFM"]);
  expect(refs).not.toContain("youtube.com/watch");
});

test("extractRefs keeps article URLs as host+path needles but drops bare hosts", () => {
  expect(extractRefs("ref https://example.com/blog/post-123 here")).toEqual(["example.com/blog/post-123"]);
  // bare host (no path) is too generic to be a lineage needle
  expect(extractRefs("just https://example.com mentioned")).toEqual([]);
});

test("extractRefs returns nothing for content with no back-references", () => {
  expect(extractRefs("a plain note with no links at all")).toEqual([]);
  expect(extractRefs("")).toEqual([]);
});
