import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLiveFeed,
} from "../scripts/build-live-feed.mjs";
import {
  assertLiveLocalizationComplete,
  isLiveLocalizationCoolingDown,
  liveDeduplicationInputSignature,
  liveDeduplicationVersion,
  liveModelCooldownMinutes,
  mergeLiveTitleTranslations,
  normalizeDuplicateClusters,
  shouldDeferLiveLocalization,
} from "../scripts/localize-live-feed.mjs";

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
    sourceId: 131,
    sourceName: "OpenAI",
    sourcePublisher: "OpenAI",
    sourceKind: "Blog",
    accessMethod: "public-feed",
    publicContentPolicy: "headline-source-link-only",
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
  assert.equal(
    feed.items[0].publicContentPolicy,
    "headline-source-link-only",
  );
  assert.equal("summary" in feed.items[0], false);
});

test("keeps items without public access provenance out of Live", () => {
  const feed = buildLiveFeed(
    snapshot([
      item({
        id: "unproven",
        sourceId: 999_999,
        sourceName: "Unknown Publisher",
        sourcePublisher: "Unknown Publisher",
        accessMethod: undefined,
      }),
    ]),
  );

  assert.deepEqual(feed.items, []);
});

test("removes access and gift tokens from public Live links", () => {
  const feed = buildLiveFeed(
    snapshot([
      item({
        url:
          "https://example.com/ai-model?unlocked_article_code=secret&view_token=secret&utm_source=test",
      }),
    ]),
  );

  assert.equal(feed.items[0].url, "https://example.com/ai-model");
});

test("keeps A-level discovery wording private until an original source appears", () => {
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

  assert.deepEqual(feed.items, []);
});

test("uses the original-source headline when a cluster URL is corroborated", () => {
  const feed = buildLiveFeed(
    snapshot([
      item({
        id: "cluster",
        sourceId: 226,
        sourceName: "Techmeme",
        sourcePublisher: "Techmeme",
        title:
          "Techmeme's long editorial rewrite of an AI launch (Jane Doe/Example News)",
        url: "https://example.com/astra?utm_source=techmeme",
        discoveryOnly: true,
        discoveryLevel: "A",
      }),
      item({
        id: "original",
        sourceId: 999,
        sourceName: "Example News",
        sourcePublisher: "Example News",
        title: "OpenAI launches Astra for scientific reasoning",
        url: "https://example.com/astra",
      }),
    ]),
  );

  assert.equal(feed.items.length, 1);
  assert.equal(feed.items[0].sourceName, "Example News");
  assert.equal(
    feed.items[0].title,
    "OpenAI launches Astra for scientific reasoning",
  );
  assert.equal(feed.items[0].url, "https://example.com/astra");
  assert.equal(feed.items[0].discoveredThroughCluster, true);
  assert.equal(feed.items[0].prominence, "lead");
  assert.doesNotMatch(JSON.stringify(feed), /Techmeme/);
});

test("allows an A-level cluster only after an original post is grounded", () => {
  const feed = buildLiveFeed(
    snapshot([
      item({
        id: "cluster",
        sourceId: 226,
        sourceName: "Techmeme",
        sourcePublisher: "Techmeme",
        title: "Aggregator interpretation of a Karpathy post",
        url: "https://x.com/karpathy/status/2083749667410727319",
        discoveryOnly: true,
        discoveryLevel: "A",
      }),
      item({
        id: "original-post",
        sourceId: 26,
        sourceName: "Andrej Karpathy",
        sourcePublisher: "Andrej Karpathy",
        title: "We're starting to leave the territory where you'd test an LLM",
        summary: "Original post text about an LLM creating larger worlds.",
        url: "https://x.com/karpathy/status/2083749667410727319",
        groundedFromDiscovery: true,
      }),
    ]),
  );

  assert.equal(feed.items.length, 1);
  assert.equal(feed.items[0].sourceName, "Andrej Karpathy");
  assert.match(feed.items[0].title, /^We're starting/);
  assert.doesNotMatch(JSON.stringify(feed), /Aggregator interpretation/);
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

test("admits official model-feed updates without requiring an AI keyword", () => {
  const feed = buildLiveFeed(
    snapshot([
      item({
        id: "minimax-h3",
        sourceId: 212,
        sourceName: "MiniMax — Hugging Face Models",
        sourcePublisher: "MiniMax",
        title: "MiniMax-H3 model update",
        url: "https://huggingface.co/MiniMaxAI/MiniMax-H3",
        summary:
          "task: image-text-to-video · tags: diffusers, text-to-video",
      }),
    ]),
  );

  assert.deepEqual(feed.items.map((entry) => entry.id), ["minimax-h3"]);
});

test("trusted media analysis enters Live without model judgment", () => {
  const feed = buildLiveFeed(
    snapshot([
      item({
        id: "wsj-analysis",
        sourceId: 900226,
        sourceName: "The Wall Street Journal",
        sourcePublisher: "The Wall Street Journal",
        title:
          "The Race to Build an American Alternative to Cheap AI From China",
        url: "https://www.wsj.com/tech/ai/american-open-weight-models",
        summary:
          "A reported look at the US open-weight AI model ecosystem.",
      }),
      item({
        id: "independent-explainer",
        sourceId: 80,
        sourceName: "Independent Blog",
        sourcePublisher: "Independent Blog",
        title: "Single Forward Pass Evals on three AI models",
        url: "https://example.com/model-evals",
        summary: "A personal model benchmark explanation.",
      }),
    ]),
  );

  assert.deepEqual(feed.items.map((entry) => entry.id), ["wsj-analysis"]);
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
      sourceName: "MiniMax",
      sourcePublisher: "MiniMax",
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
    duplicates: [],
  });

  assert.equal(
    localized.items[0].title,
    "OpenAI launches a new agent model API",
  );
  assert.equal(
    localized.items[0].titleZh,
    "OpenAI 发布新的 Agent 模型 API",
  );
});

test("Live localization preserves every distinct deterministic selection", () => {
  const items = [
    item(),
    item({
      id: "reported-analysis",
      sourceName: "The Wall Street Journal",
      title: "The race to build an American open-weight AI ecosystem",
      url: "https://wsj.com/tech/ai/open-weight-ecosystem",
    }),
  ];
  const localized = mergeLiveTitleTranslations(
    items,
    {
      items: [
        {
          id: "item-1",
          titleZh: "OpenAI 发布新的 Agent 模型 API",
        },
        {
          id: "reported-analysis",
          titleZh: "美国开放权重 AI 生态竞赛",
        },
      ],
      duplicates: [],
    },
  );

  assert.equal(localized.items.length, 2);
  assert.equal(localized.items[0].title, items[0].title);
  assert.equal(localized.items[0].url, items[0].url);
  assert.equal(localized.items[1].title, items[1].title);
  assert.equal(localized.items[1].url, items[1].url);
  assert.equal(
    localized.items[1].titleZh,
    "美国开放权重 AI 生态竞赛",
  );
});

test("Live localization requires exact ids and complete translations", () => {
  assert.throws(
    () =>
      mergeLiveTitleTranslations(
        [item()],
        {
          items: [
            {
              id: "wrong-id",
              titleZh: "翻译",
            },
          ],
          duplicates: [],
        },
      ),
    /does not match retained item/,
  );
  assert.throws(
    () =>
      mergeLiveTitleTranslations(
        [item()],
        {
          items: [
            {
              id: "item-1",
              titleZh: "",
            },
          ],
          duplicates: [],
        },
      ),
    /does not match retained item/,
  );
});

test("Live localization rejects dangling surname attribution in Chinese", () => {
  const source = item({
    title: "SpaceX Has a Bit of an 'Identity Crisis,' Zhu Says",
  });

  assert.throws(
    () =>
      mergeLiveTitleTranslations([source], {
        items: [
          {
            id: source.id,
            titleZh: "朱说，SpaceX有点“身份危机”",
          },
        ],
        duplicates: [],
      }),
    /dangling surname attribution/,
  );
  assert.equal(
    mergeLiveTitleTranslations([source], {
      items: [
        {
          id: source.id,
          titleZh: "SpaceX被指正面临一场“身份危机”",
        },
      ],
      duplicates: [],
    }).items[0].titleZh,
    "SpaceX被指正面临一场“身份危机”",
  );
  assert.throws(
    () =>
      mergeLiveTitleTranslations([source], {
        items: [
          {
            id: source.id,
            titleZh: "SpaceX正经历一场“身份危机”",
          },
        ],
        duplicates: [],
      }),
    /dropped a material attribution/,
  );
});

test("Live localization preserves a named institution attribution", () => {
  const source = item({
    title: "India Less Exposed to AI Job Risks Than Others, Goldman Says",
  });

  assert.equal(
    mergeLiveTitleTranslations([source], {
      items: [
        {
          id: source.id,
          titleZh: "高盛称，印度面临的AI就业风险低于其他国家",
        },
      ],
      duplicates: [],
    }).items[0].titleZh,
    "高盛称，印度面临的AI就业风险低于其他国家",
  );
});

test("Luna may remove same-event reports while preserving distinct Meta news", () => {
  const items = [
    item({
      id: "meta-wsj",
      sourceName: "The Wall Street Journal",
      title: "Meta Releases Coding Agent to Compete with OpenAI",
      url: "https://wsj.com/meta-code-agent",
    }),
    item({
      id: "meta-techcrunch",
      sourceName: "TechCrunch",
      title: "Meta launches Muse Code for large code bases",
      url: "https://techcrunch.com/meta-muse-code",
    }),
    item({
      id: "meta-engadget",
      sourceName: "Engadget",
      title: "Meta introduces Muse Code, its take on a coding agent",
      url: "https://engadget.com/meta-muse-code",
    }),
    item({
      id: "meta-security",
      sourceName: "The Information",
      title: "A Meta AI model hacked another company during testing",
      url: "https://theinformation.com/meta-security-test",
    }),
    item({
      id: "salesforce",
      sourceName: "The Information",
      title: "Salesforce engineering chief steps down",
      url: "https://theinformation.com/salesforce-chief",
    }),
    item({
      id: "quantum",
      sourceName: "Bloomberg",
      title: "PsiQuantum CEO discusses quantum computing progress",
      url: "https://bloomberg.com/psiquantum",
    }),
    item({
      id: "spyware",
      sourceName: "Bloomberg",
      title: "A spyware tool operates in 13 countries",
      url: "https://bloomberg.com/spyware",
    }),
  ];
  const localized = mergeLiveTitleTranslations(items, {
    items: [
      { id: "spyware", titleZh: "一款间谍软件在13个国家运行" },
      {
        id: "meta-security",
        titleZh: "Meta人工智能模型被指在测试中入侵另一家公司",
      },
      { id: "meta-wsj", titleZh: "Meta发布Muse Code编程代理" },
      { id: "quantum", titleZh: "PsiQuantum首席执行官谈量子计算进展" },
      { id: "salesforce", titleZh: "Salesforce工程负责人离任" },
    ],
    duplicates: [
      { id: "meta-techcrunch", duplicateOf: "meta-wsj" },
      { id: "meta-engadget", duplicateOf: "meta-wsj" },
    ],
  });

  assert.deepEqual(
    localized.items.map((entry) => entry.id),
    [
      "meta-wsj",
      "meta-security",
      "salesforce",
      "quantum",
      "spyware",
    ],
  );
  assert.deepEqual(localized.duplicateClusters, [
    {
      keptId: "meta-wsj",
      duplicateIds: ["meta-techcrunch", "meta-engadget"],
    },
  ]);
});

test("nested duplicate clusters resolve to the final retained report", () => {
  assert.deepEqual(
    normalizeDuplicateClusters([
      { keptId: "older", duplicateIds: ["old-duplicate"] },
      { keptId: "new-official", duplicateIds: ["older"] },
    ]),
    [
      {
        keptId: "new-official",
        duplicateIds: ["old-duplicate", "older"],
      },
    ],
  );
});

test("Live localization calls use a two-hour cooldown", () => {
  assert.equal(liveModelCooldownMinutes, 120);
  const feed = { localizedAt: "2026-08-02T20:00:00.000Z" };
  assert.equal(
    isLiveLocalizationCoolingDown(
      feed,
      Date.parse("2026-08-02T21:59:59.000Z"),
    ),
    true,
  );
  assert.equal(
    isLiveLocalizationCoolingDown(
      feed,
      Date.parse("2026-08-02T22:00:00.000Z"),
    ),
    false,
  );
  assert.equal(
    shouldDeferLiveLocalization(feed, {
      required: false,
      now: Date.parse("2026-08-02T21:00:00.000Z"),
    }),
    true,
  );
  assert.equal(
    shouldDeferLiveLocalization(feed, {
      required: true,
      now: Date.parse("2026-08-02T21:00:00.000Z"),
    }),
    false,
  );
});

test("untranslated Live items remain public without model approval", () => {
  const feed = buildLiveFeed(
    snapshot([
      item(),
      item({
        id: "new-company-item",
        sourceId: 197,
        sourceName: "Anthropic",
        sourcePublisher: "Anthropic",
        title: "Anthropic launches a new Claude API",
        url: "https://anthropic.com/news/new-claude-api",
      }),
    ]),
  );

  assert.deepEqual(
    feed.items.map((entry) => entry.id),
    ["item-1", "new-company-item"],
  );
  assert.ok(feed.items.every((entry) => !entry.titleZh));
});

test("required Live publication rejects untranslated titles", () => {
  assert.throws(
    () =>
      assertLiveLocalizationComplete({
        items: [item({ titleZh: undefined })],
        pendingItemCount: 1,
      }),
    /localization is incomplete/,
  );
  assert.doesNotThrow(() => {
    const items = [
      item({ titleZh: "OpenAI 发布新的 Agent 模型 API" }),
    ];
    assertLiveLocalizationComplete({
      items,
      pendingItemCount: 0,
      deduplicationVersion: liveDeduplicationVersion,
      deduplicationInputSignature:
        liveDeduplicationInputSignature(items),
      deduplicationPending: false,
    });
  });
});
