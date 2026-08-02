import assert from "node:assert/strict";
import test from "node:test";

import {
  extractTechmemeOriginalUrl,
  parseTechmemeFeed,
} from "../scripts/fetch-sources.mjs";
import {
  publicSourceCatalog,
  sourceCatalog,
} from "../app/source-catalog.ts";

const source = {
  id: 226,
  name: "Techmeme",
  publisher: "Techmeme",
  url: "https://www.techmeme.com/",
  feedUrl: "https://www.techmeme.com/feed.xml",
  feedFormat: "techmeme-rss",
  discoveryOnly: true,
  discoveryLevel: "A",
};

test("extracts the original report instead of the Techmeme permalink", () => {
  const xml = `
    <rss><channel><item>
      <title>Amazon launches a new AI service (Jane Doe/Example News)</title>
      <link>https://www.techmeme.com/260802/p1#a260802p1</link>
      <description><![CDATA[
        <a href="https://example.com/story?utm_source=techmeme&accessToken=gift-token">
          <img src="https://www.techmeme.com/260802/i1.jpg">
        </a>
        <a href="https://www.techmeme.com/260802/p1#a260802p1">Permalink</a>
        Jane Doe / <a href="https://example.com/">Example News</a>:
        <b><a href="https://example.com/story?utm_source=techmeme&accessToken=gift-token">
          Amazon launches a new AI service
        </a></b> &mdash; &ldquo;Available now&rdquo;
      ]]></description>
      <pubDate>Sun, 02 Aug 2026 18:50:01 -0400</pubDate>
    </item></channel></rss>
  `;

  const [item] = parseTechmemeFeed(xml, source, source.feedUrl);
  assert.equal(item.url, "https://example.com/story");
  assert.equal(item.publishedAt, "2026-08-02T22:50:01.000Z");
  assert.equal(item.sourceName, "Techmeme");
  assert.doesNotMatch(item.url, /techmeme\.com/);
  assert.match(item.summary, /— “Available now”/);
  assert.doesNotMatch(item.summary, /&(?:mdash|ldquo|rdquo);/);
});

test("prefers a social post over the preceding profile link", () => {
  const block = `
    <description><![CDATA[
      Andrej Karpathy / <a href="https://x.com/karpathy">@karpathy</a>:
      <b><a href="https://x.com/karpathy/status/2083749667410727319">
        LLMs are moving from generating artifacts to creating worlds
      </a></b>
    ]]></description>
  `;

  assert.equal(
    extractTechmemeOriginalUrl(block, source.feedUrl),
    "https://x.com/karpathy/status/2083749667410727319",
  );
});

test("never falls back to a Techmeme page when no original URL exists", () => {
  const xml = `
    <rss><channel><item>
      <title>Unresolved headline</title>
      <link>https://www.techmeme.com/260802/p2#a260802p2</link>
      <description><![CDATA[
        <a href="https://www.techmeme.com/260802/p2#a260802p2">Permalink</a>
      ]]></description>
    </item></channel></rss>
  `;

  assert.deepEqual(parseTechmemeFeed(xml, source, source.feedUrl), []);
});

test("registers Techmeme as a private high-priority discovery source", () => {
  const techmeme = sourceCatalog.find((item) => item.id === 226);
  assert.equal(techmeme?.feedFormat, "techmeme-rss");
  assert.equal(techmeme?.discoveryOnly, true);
  assert.equal(techmeme?.discoveryLevel, "A");
  assert.equal(publicSourceCatalog.some((item) => item.id === 226), false);
});
