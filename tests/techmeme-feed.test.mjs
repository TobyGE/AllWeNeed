import assert from "node:assert/strict";
import test from "node:test";

import {
  extractTechmemeOriginalUrl,
  groundDiscoveryOriginals,
  originalFromPublicPageMetadata,
  originalTitleFromPublisherUrl,
  parseTechmemeFeed,
  parseXOriginalOembed,
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

test("registers The Information official Atom with its compatible transport", () => {
  const source = sourceCatalog.find((item) => item.id === 236);
  assert.equal(source?.feedUrl, "https://www.theinformation.com/feed");
  assert.equal(source?.feedTransport, "curl");
});

test("extracts original X post copy from the official oEmbed response", () => {
  const original = parseXOriginalOembed({
    author_name: "Andrej Karpathy",
    html: `
      <blockquote>
        <p>We&#39;re starting to leave the territory where you&#39;d test an LLM by creating a single artifact. This is the original post text. <a href="https://t.co/example">pic.twitter.com/example</a></p>
      </blockquote>
    `,
  });

  assert.equal(original.authorName, "Andrej Karpathy");
  assert.match(original.originalText, /^We're starting to leave/);
  assert.doesNotMatch(original.originalText, /Techmeme/);
  assert.doesNotMatch(original.originalText, /t\.co/);
});

test("derives a publisher-authored WSJ headline from its stable article URL", () => {
  assert.deepEqual(
    originalTitleFromPublisherUrl(
      "https://www.wsj.com/tech/ai/the-race-to-build-an-american-alternative-to-cheap-ai-from-china-2e99a28a",
    ),
    {
      title:
        "The Race to Build an American Alternative to Cheap AI From China",
      publisher: "The Wall Street Journal",
      sourceId: 900226,
    },
  );
});

test("grounds a discovered X post through the official oEmbed endpoint", async () => {
  const [grounded] = await groundDiscoveryOriginals(
    [
      {
        id: "cluster-x",
        sourceId: 226,
        sourceName: "Techmeme",
        title: "Aggregator rewrite that must stay private",
        url: "https://x.com/karpathy/status/2083749667410727319",
        publishedAt: "2026-08-02T22:00:00.000Z",
        discoveryOnly: true,
        discoveryLevel: "A",
      },
    ],
    {
      cachedItems: [],
      fetcher: async () => ({
        text: JSON.stringify({
          author_name: "Andrej Karpathy",
          html: "<blockquote><p>The original post says LLMs can now create much larger worlds.</p></blockquote>",
        }),
      }),
    },
  );

  assert.equal(grounded.sourceId, 26);
  assert.equal(grounded.sourceName, "Andrej Karpathy");
  assert.equal(
    grounded.title,
    "The original post says LLMs can now create much larger worlds.",
  );
  assert.equal(grounded.originalTitleMethod, "official-oembed");
  assert.doesNotMatch(JSON.stringify(grounded), /Aggregator rewrite/);
});

test("does not synthesize another original when a direct feed already has it", async () => {
  const discovery = {
    id: "cluster",
    sourceId: 226,
    sourceName: "Techmeme",
    title: "Private aggregation wording",
    url: "https://www.theinformation.com/articles/original-story",
    publishedAt: "2026-08-02T22:00:00.000Z",
    discoveryOnly: true,
    discoveryLevel: "A",
  };
  const direct = {
    id: "direct",
    sourceId: 236,
    sourceName: "The Information",
    title: "Original Story",
    url: discovery.url,
    publishedAt: "2026-08-02T21:30:00.000Z",
  };
  const grounded = await groundDiscoveryOriginals([discovery, direct], {
    cachedItems: [],
    fetcher: async () => {
      throw new Error("no network call expected");
    },
  });

  assert.deepEqual(grounded, []);
});

test("uses a publisher's public metadata instead of aggregation copy", () => {
  const original = originalFromPublicPageMetadata(
    {
      url: "https://www.scientificamerican.com/article/ai-proof/",
      publishedAt: "2026-08-03T02:50:01.000Z",
    },
    `
      <html><head>
        <meta property="og:title" content="AI helped produce two cryptography proofs"/>
        <meta property="og:description" content="Two teams used AI while working on the same problem."/>
        <script type="application/ld+json">
          {"datePublished":"2026-07-31T12:00:00-04:00"}
        </script>
      </head></html>
    `,
    "Scientific American",
  );

  assert.equal(
    original.title,
    "AI helped produce two cryptography proofs",
  );
  assert.equal(original.sourceName, "Scientific American");
  assert.equal(original.publishedAt, "2026-07-31T16:00:00.000Z");
  assert.equal(original.originalTitleMethod, "public-page-metadata");
});

test("grounds a Techmeme lead to Nikkei's original page metadata", async () => {
  const [grounded] = await groundDiscoveryOriginals(
    [
      {
        id: "techmeme-nikkei",
        sourceId: 226,
        sourceName: "Techmeme",
        title: "Aggregator wording that must remain private",
        url: "https://asia.nikkei.com/business/technology/artificial-intelligence/central-asia-data-centers",
        publishedAt: "2026-08-03T04:10:00.000Z",
        discoveryOnly: true,
        discoveryLevel: "A",
      },
    ],
    {
      cachedItems: [],
      fetcher: async () => ({
        text: `
          <html><head>
            <meta property="og:title" content="Starting gun for Central Asia data center race triggered"/>
            <meta property="og:description" content="Nvidia-supported campuses are taking shape."/>
            <meta name="date" content="2026-08-03T10:53:07.000+09:00"/>
          </head></html>
        `,
      }),
    },
  );

  assert.equal(grounded.sourceId, 900221);
  assert.equal(grounded.sourceName, "Nikkei Asia");
  assert.equal(
    grounded.title,
    "Starting gun for Central Asia data center race triggered",
  );
  assert.equal(grounded.publishedAt, "2026-08-03T01:53:07.000Z");
  assert.equal(grounded.groundedFromDiscovery, true);
  assert.equal(grounded.originalTitleMethod, "public-page-metadata");
  assert.doesNotMatch(JSON.stringify(grounded), /Aggregator wording/);
});

test("reuses configured publisher identity when grounding Bloomberg metadata", async () => {
  const [grounded] = await groundDiscoveryOriginals(
    [
      {
        id: "techmeme-bloomberg",
        sourceId: 226,
        sourceName: "Techmeme",
        title: "Private cluster copy",
        url: "https://www.bloomberg.com/news/articles/2026-08-03/example",
        publishedAt: "2026-08-03T03:40:00.000Z",
        discoveryOnly: true,
        discoveryLevel: "A",
      },
    ],
    {
      cachedItems: [],
      fetcher: async () => ({
        text: `
          <html><head>
            <meta property="og:title" content="Alibaba Releases New Open AI Model"/>
            <meta property="article:published_time" content="2026-08-03T03:35:00.000Z"/>
          </head></html>
        `,
      }),
    },
  );

  assert.equal(grounded.sourceId, 233);
  assert.equal(grounded.sourceName, "Bloomberg");
  assert.equal(grounded.title, "Alibaba Releases New Open AI Model");
});

test("rejects bot-block pages as original metadata", () => {
  assert.equal(
    originalFromPublicPageMetadata(
      {
        url: "https://www.reuters.com/example",
        publishedAt: "2026-08-03T02:50:01.000Z",
      },
      "<title>Just a moment...</title>",
      "Reuters",
    ),
    null,
  );
});
