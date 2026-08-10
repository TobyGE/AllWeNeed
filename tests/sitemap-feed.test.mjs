import assert from "node:assert/strict";
import test from "node:test";

import {
  extractPageMetadata,
  parseSitemapXml,
  shouldReuseHtmlListingCache,
} from "../scripts/fetch-sources.mjs";

const source = {
  id: 197,
  name: "Anthropic Newsroom",
  publisher: "Anthropic",
  url: "https://www.anthropic.com/news",
  feedUrl: "https://www.anthropic.com/sitemap.xml",
  feedFormat: "sitemap-xml",
  feedPathPrefixes: ["/news/"],
};

test("keeps sitemap lastmod separate from article publication time", () => {
  const [item] = parseSitemapXml(
    `<urlset><url>
      <loc>https://www.anthropic.com/news/claude-sonnet-5</loc>
      <lastmod>2026-08-10T19:00:15Z</lastmod>
    </url></urlset>`,
    source,
    source.feedUrl,
  );

  assert.equal(item.publishedAt, null);
  assert.equal(item.modifiedAt, "2026-08-10T19:00:15.000Z");
});

test("extracts Anthropic's escaped publishedOn field from Next.js data", () => {
  const metadata = extractPageMetadata(`
    <title>Introducing Claude Sonnet 5</title>
    <script>self.__next_f.push([1,"{\\\"publishedOn\\\":\\\"2026-06-30T18:00:00.000Z\\\"}"])</script>
  `);

  assert.equal(metadata.title, "Introducing Claude Sonnet 5");
  assert.equal(metadata.publishedAt, "2026-06-30T18:00:00.000Z");
});

test("does not reuse legacy sitemap cache without publication provenance", () => {
  const legacyCached = {
    title: "Introducing Claude Sonnet 5",
    summary: "Our most agentic Sonnet yet.",
    publishedAt: "2026-08-10T19:00:15.000Z",
  };
  assert.equal(shouldReuseHtmlListingCache(legacyCached, source), false);
  assert.equal(
    shouldReuseHtmlListingCache(
      { ...legacyCached, publishedAtSource: "page-metadata" },
      source,
    ),
    true,
  );
});
