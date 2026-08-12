import assert from "node:assert/strict";
import test from "node:test";

import { sourceCatalog } from "../app/source-catalog.ts";
import {
  parseFeed,
  parseYouTubeWatchMetadata,
} from "../scripts/fetch-sources.mjs";

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

  const paulGraham = sourceCatalog.find(
    (source) => source.name === "Paul Graham",
  );
  assert.equal(
    paulGraham.feedUrl,
    "http://www.aaronsw.com/2002/feeds/pgessays.rss",
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

test("preserves an embedded YouTube alias from a canonical podcast item", () => {
  const source = {
    id: 20,
    name: "Dwarkesh Podcast",
    url: "https://www.youtube.com/channel/UCXl4i9dYBrFOabk0xGmbkRA",
    feedUrl: "https://example.com/podcast.rss",
    conversationSource: true,
    feedSummaryLimit: 8_000,
  };
  const xml = `
    <rss><channel><item>
      <title>Ryan Greenblatt interview</title>
      <link>https://www.dwarkesh.com/p/ryan-greenblatt</link>
      <pubDate>Tue, 11 Aug 2026 16:31:23 GMT</pubDate>
      <description><![CDATA[
        <p>Long-form interview notes.</p>
        <p>Watch on <a href="https://youtu.be/-RXD4bTuFTo">YouTube</a>.</p>
      ]]></description>
    </item></channel></rss>
  `;

  const [item] = parseFeed(xml, source, source.feedUrl);
  assert.equal(item.url, "https://www.dwarkesh.com/p/ryan-greenblatt");
  assert.equal(item.videoId, "-RXD4bTuFTo");
  assert.equal(
    item.videoUrl,
    "https://www.youtube.com/watch?v=-RXD4bTuFTo",
  );
  assert.deepEqual(item.alternateUrls, [item.videoUrl]);
});

test("extracts public descriptions and duration from a YouTube conversation page", () => {
  const html = `
    <html><head><meta name="description" content="Short fallback"></head>
    <script>var ytInitialPlayerResponse = ${JSON.stringify({
      videoDetails: {
        shortDescription:
          "A detailed public interview description with guests, topics, and a full timeline.",
        lengthSeconds: "6386",
      },
      microformat: {
        playerMicroformatRenderer: { publishDate: "2026-08-04" },
      },
    })};</script>
  `;
  const metadata = parseYouTubeWatchMetadata(html);
  assert.match(metadata.summary, /detailed public interview description/);
  assert.equal(metadata.durationMinutes, 106);
  assert.equal(metadata.publishedAt, "2026-08-04T00:00:00.000Z");
});

test("falls back to a public enclosure when a podcast GUID is not a URL", () => {
  const source = {
    id: 224,
    name: "The Diary Of A CEO",
    url: "https://www.youtube.com/channel/UCGq-a57w-aPwyi3pW7XLiHw",
    conversationSource: true,
  };
  const xml = `
    <rss><channel><item>
      <title>A complete interview</title>
      <guid>flightcast:01K2EXAMPLE</guid>
      <pubDate>Sat, 08 Aug 2026 10:00:00 +0000</pubDate>
      <description>Full official shownotes and guest details.</description>
      <itunes:duration>5400</itunes:duration>
      <enclosure url="https://episode.flightcast.com/01K2EXAMPLE.mp3" type="audio/mpeg" />
    </item></channel></rss>
  `;

  const items = parseFeed(xml, source, "https://rss2.flightcast.com/show");
  assert.equal(items.length, 1);
  assert.equal(
    items[0].url,
    "https://episode.flightcast.com/01K2EXAMPLE.mp3",
  );
  assert.equal(items[0].durationMinutes, 90);
});

test("core conversation sources prefer official podcast RSS with full shownotes", () => {
  const expectedFeeds = new Map([
    ["Lex Fridman Podcast", "https://lexfridman.com/feed/podcast/"],
    ["Decoder", "https://feeds.megaphone.fm/recodedecode"],
    [
      "All-In Podcast",
      "https://rss.libsyn.com/shows/254861/destinations/1928300.xml",
    ],
    ["Lenny's Podcast", "https://api.substack.com/feed/podcast/10845.rss"],
    [
      "This Week in Startups",
      "https://rss.libsyn.com/shows/624860/destinations/5500155.xml",
    ],
    ["Acquired", "https://feeds.transistor.fm/acquired"],
    [
      "The Twenty Minute VC (20VC)",
      "https://rss.libsyn.com/shows/61840/destinations/240976.xml",
    ],
    ["No Priors", "https://feeds.megaphone.fm/nopriors"],
    ["Dwarkesh Podcast", "https://apple.dwarkesh-podcast.workers.dev/feed.rss"],
    ["Latent Space", "https://api.substack.com/feed/podcast/1084089.rss"],
    ["Cognitive Revolution", "https://feeds.megaphone.fm/RINTP3108857801"],
    ["硅谷101播客", "https://feeds.fireside.fm/sv101/rss"],
    ["The Diary Of A CEO", "https://rss2.flightcast.com/xmsftuzjjykcmqwolaqn6mdn"],
    ["AI + a16z", "https://feeds.simplecast.com/Hb_IuXOo"],
    ["ChinaTalk Podcast", "https://feeds.megaphone.fm/CHTAL4990341033"],
    ["Hard Fork", "https://feeds.simplecast.com/6HKOhNgS"],
    ["Possible", "https://feeds.megaphone.fm/possible"],
    [
      "Eye On A.I.",
      "https://rss.libsyn.com/shows/123267/destinations/727317.xml",
    ],
    [
      "The MAD Podcast with Matt Turck",
      "https://anchor.fm/s/f2ee4948/podcast/rss",
    ],
    ["Training Data", "https://feeds.megaphone.fm/trainingdata"],
    ["The TWIML AI Podcast", "https://feeds.megaphone.fm/MLN2155636147"],
    [
      "Practical AI",
      "https://feeds.transistor.fm/practical-ai-machine-learning-data-science-llm",
    ],
    ["十字路口Crossing", "https://feed.xyzfm.space/68fyjknth9hj"],
    ["晚点聊 LateTalk", "https://feeds.fireside.fm/latetalk/rss"],
    ["开始连接 LinkStart", "https://feed.xyzfm.space/q9a6lueucj6a"],
    ["乱翻书", "https://feed.xyzfm.space/yxuruh3f9mc4"],
  ]);
  for (const [name, feedUrl] of expectedFeeds) {
    const source = sourceCatalog.find((item) => item.name === name);
    assert.equal(source?.feedUrl, feedUrl, `${name} uses its official RSS`);
    assert.equal(source?.feedSummaryLimit, 8_000);
    assert.equal(source?.conversationSource, true);
  }
  const conversations = sourceCatalog.filter((item) => item.conversationSource);
  assert.equal(conversations.length, 31);
  assert.equal(conversations.filter((item) => item.feedUrl).length, 28);
  assert.deepEqual(
    conversations.filter((item) => !item.feedUrl).map((item) => item.name),
    [
      "SAIR Foundation",
      "Silicon Valley Vector 硅谷坐标",
      "Predictive History",
    ],
  );
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
