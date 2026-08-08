import assert from "node:assert/strict";
import test from "node:test";

import { sourceCatalog } from "../app/source-catalog.ts";
import { parseFeed } from "../scripts/fetch-sources.mjs";

test("filters a company-wide RSS feed to configured AI paths", () => {
  const source = {
    id: 10002,
    name: "Google AI",
    publisher: "Google LLC",
    url: "https://blog.google/innovation-and-ai/technology/ai/",
    feedUrl: "https://blog.google/rss/",
    feedLanguage: "en",
    feedPathPrefixes: [
      "/innovation-and-ai/models-and-research/",
      "/products-and-platforms/products/gemini/",
    ],
  };
  const xml = `
    <rss><channel>
      <item>
        <title>Introducing Gemini Robotics ER 2</title>
        <link>https://blog.google/innovation-and-ai/models-and-research/google-deepmind/gemini-robotics-er-2/</link>
        <pubDate>Thu, 30 Jul 2026 15:00:00 +0000</pubDate>
        <description>Official robotics model release.</description>
      </item>
      <item>
        <title>Experience Street View in Kosovo</title>
        <link>https://blog.google/products-and-platforms/products/maps/google-street-view-kosovo/</link>
        <pubDate>Fri, 31 Jul 2026 08:00:00 +0000</pubDate>
        <description>Maps update.</description>
      </item>
    </channel></rss>
  `;

  const items = parseFeed(xml, source, source.feedUrl);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Introducing Gemini Robotics ER 2");
});

test("connects the corrected public Google and NVIDIA feeds", () => {
  const names = new Set(sourceCatalog.map((source) => source.name));
  assert.equal(names.has("Google AI"), true);
  assert.equal(names.has("NVIDIA Technical Blog"), true);
  assert.equal(names.has("NVIDIA Newsroom"), true);

  const google = sourceCatalog.find((source) => source.name === "Google AI");
  assert.equal(google.feedUrl, "https://blog.google/rss/");
  assert.ok(google.feedPathPrefixes.length >= 3);

  const nvidiaTechnical = sourceCatalog.find(
    (source) => source.name === "NVIDIA Technical Blog",
  );
  assert.equal(
    nvidiaTechnical.feedUrl,
    "https://developer.nvidia.com/blog/feed",
  );

  const nvidiaNewsroom = sourceCatalog.find(
    (source) => source.name === "NVIDIA Newsroom",
  );
  assert.equal(
    nvidiaNewsroom.feedUrl,
    "https://nvidianews.nvidia.com/releases.xml",
  );
});

test("drops YouTube Shorts without hiding the following full episode", () => {
  const source = {
    id: 224,
    name: "The Diary Of A CEO",
    url: "https://www.youtube.com/channel/UCGq-a57w-aPwyi3pW7XLiHw",
  };
  const xml = `
    <feed>
      <entry>
        <title>A clipped teaser</title>
        <link href="https://www.youtube.com/shorts/short-one" />
        <published>2026-08-01T14:00:00Z</published>
      </entry>
      <entry>
        <title>The complete interview</title>
        <link href="https://www.youtube.com/watch?v=full-episode" />
        <published>2026-08-01T13:00:00Z</published>
      </entry>
    </feed>
  `;

  const items = parseFeed(
    xml,
    source,
    "https://www.youtube.com/feeds/videos.xml?channel_id=test",
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "The complete interview");
});

test("keeps aggregators private and removes Product Hunt from collection", () => {
  const hackerNews = sourceCatalog.find(
    (source) => source.name === "Hacker News",
  );
  assert.equal(hackerNews.discoveryOnly, true);
  const reddit = sourceCatalog.find(
    (source) => source.name === "Reddit — AI & Core Tech",
  );
  assert.equal(reddit.discoveryOnly, true);
  assert.equal(reddit.discoveryLevel, "B");
  assert.equal(reddit.publicContentPolicy, "exclude");
  assert.match(reddit.feedUrl, /\/top\/\.rss\?t=day&limit=50$/);
  assert.equal(
    sourceCatalog.some((source) => source.name === "Product Hunt"),
    false,
  );
});
