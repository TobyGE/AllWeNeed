import assert from "node:assert/strict";
import test from "node:test";

import { buildLiveFeed } from "../scripts/build-live-feed.mjs";
import { mergeLiveTitleTranslations } from "../scripts/localize-live-feed.mjs";

const generatedAt = "2026-08-02T20:00:00.000Z";

function snapshot(items) {
  return {
    generatedAt,
    successfulSources: 190,
    failedSources: 1,
    needsAuthSources: 5,
    items,
  };
}

function item(overrides = {}) {
  return {
    id: "item-1",
    sourceId: 1,
    sourceName: "OpenAI",
    sourcePublisher: "OpenAI",
    sourceKind: "Blog",
    title: "OpenAI launches a new agent model API",
    url: "https://openai.com/index/agent-model",
    publishedAt: "2026-08-02T19:40:00.000Z",
    summary: "The API is available now.",
    fetchedAt: generatedAt,
    ...overrides,
  };
}

test("builds a strict 6-hour live window without stale padding", () => {
  const feed = buildLiveFeed(
    snapshot([
      item(),
      item({
        id: "old",
        title: "Old AI model release",
        url: "https://openai.com/index/old-model",
        publishedAt: "2026-08-02T13:59:00.000Z",
      }),
    ]),
  );

  assert.equal(feed.windowHours, 6);
  assert.deepEqual(feed.items.map((entry) => entry.id), ["item-1"]);
  assert.equal(feed.items[0].prominence, "lead");
});

test("turns an A-level cluster discovery into a public original-source item", () => {
  const feed = buildLiveFeed(
    snapshot([
      item({
        id: "cluster",
        sourceId: 226,
        sourceName: "Techmeme",
        sourcePublisher: "Techmeme",
        title:
          "OpenAI previews AI model Astra for scientific reasoning (Jane Doe/Example News)",
        url: "https://example.com/astra?utm_source=techmeme",
        discoveryOnly: true,
        discoveryLevel: "A",
      }),
    ]),
  );

  assert.equal(feed.items.length, 1);
  assert.equal(feed.items[0].sourceName, "Example News");
  assert.equal(
    feed.items[0].title,
    "OpenAI previews AI model Astra for scientific reasoning",
  );
  assert.equal(feed.items[0].url, "https://example.com/astra");
  assert.equal(feed.items[0].discoveredThroughCluster, true);
  assert.equal(feed.items[0].prominence, "lead");
  assert.doesNotMatch(JSON.stringify(feed), /Techmeme/);
});

test("keeps low-signal essays and long conversations out of Live", () => {
  const feed = buildLiveFeed(
    snapshot([
      item({
        id: "alarm",
        sourceId: 47,
        sourceName: "Personal Blog",
        sourcePublisher: "Personal Blog",
        title: "Some reasons why my phone alarm is good",
        url: "https://example.com/alarm",
        summary: "A personal workflow essay.",
      }),
      item({
        id: "podcast",
        sourceId: 10,
        sourceName: "Product Podcast",
        sourcePublisher: "Product Podcast",
        sourceKind: "YouTube",
        title: "A two-hour conversation about AI product management",
        url: "https://youtube.com/watch?v=podcast",
        durationMinutes: 120,
      }),
    ]),
  );

  assert.deepEqual(feed.items, []);
});

test("admits core-tech reporting from trusted high-frequency news feeds", () => {
  const feed = buildLiveFeed(
    snapshot([
      item({
        id: "trusted-news",
        sourceId: 227,
        sourceName: "The Verge",
        sourcePublisher: "The Verge",
        title: "Anthropic faces new questions over Claude security",
        url: "https://www.theverge.com/ai/anthropic-claude-security",
        summary: "A reported account of the company response.",
      }),
    ]),
  );

  assert.deepEqual(feed.items.map((entry) => entry.id), ["trusted-news"]);
});

test("does not treat a generic crypto or market headline as core tech", () => {
  const feed = buildLiveFeed(
    snapshot([
      item({
        id: "market-news",
        sourceId: 233,
        sourceName: "Bloomberg Technology",
        sourcePublisher: "Bloomberg",
        title: "Crypto trading revenue rises as retail speculation returns",
        url: "https://www.bloomberg.com/markets/crypto-trading-revenue",
        summary: "Quarterly revenue increased as trading volumes grew.",
      }),
    ]),
  );

  assert.deepEqual(feed.items, []);
});

test("prevents one prolific direct source from flooding the river", () => {
  const items = Array.from({ length: 5 }, (_, index) =>
    item({
      id: `model-${index}`,
      title: `AI model release ${index}`,
      url: `https://example.com/model-${index}`,
      sourceId: 90,
      sourceName: "Model Lab Blog",
      sourcePublisher: "Model Lab Blog",
      publishedAt: `2026-08-02T19:${String(50 - index).padStart(2, "0")}:00.000Z`,
    }),
  );
  const feed = buildLiveFeed(snapshot(items));

  assert.equal(feed.items.length, 3);
});

test("keeps the public Live surface between freshness and a ten-item ceiling", () => {
  const feed = buildLiveFeed(
    snapshot(
      Array.from({ length: 12 }, (_, index) =>
        item({
          id: `fresh-${index}`,
          sourceId: 1_000 + index,
          sourceName: `OpenAI News ${index}`,
          title: `AI model release ${index}`,
          url: `https://example.com/ai-model-${index}`,
          publishedAt: `2026-08-02T19:${String(59 - index).padStart(2, "0")}:00.000Z`,
        }),
      ),
    ),
  );

  assert.equal(feed.items.length, 10);
});

test("merges cached Chinese titles without changing the original headline", () => {
  const items = [item()];
  const localized = mergeLiveTitleTranslations(items, {
    items: [
      {
        id: "item-1",
        titleZh: "OpenAI 发布新的 Agent 模型 API",
      },
    ],
  });

  assert.equal(localized[0].title, "OpenAI launches a new agent model API");
  assert.equal(localized[0].titleZh, "OpenAI 发布新的 Agent 模型 API");
});
