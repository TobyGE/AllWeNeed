import assert from "node:assert/strict";
import test from "node:test";
import {
  createBaselineState,
  hydrateExistingUpdates,
  hydrateFeedStories,
  mergeFeedStories,
  nextState,
  selectIncrementalItems,
  validateFeedCoverage,
} from "../scripts/append-feed-updates.mjs";

function article(prefix) {
  return {
    lead: `${prefix} lead`,
    sections: [
      { heading: `${prefix} one`, body: `${prefix} body one` },
      { heading: `${prefix} two`, body: `${prefix} body two` },
      { heading: `${prefix} three`, body: `${prefix} body three` },
    ],
    outlook: `${prefix} outlook`,
  };
}

test("selects unseen items inside the continuous cursor window", () => {
  const previousSnapshot = {
    generatedAt: "2026-07-29T12:00:00.000Z",
    items: [{ url: "https://example.com/already-seen" }],
  };
  const scannedSnapshot = {
    generatedAt: "2026-07-29T14:00:00.000Z",
    items: [
      {
        url: "https://example.com/already-seen",
        title: "Existing",
        publishedAt: "2026-07-29T13:30:00.000Z",
      },
      {
        url: "https://example.com/new",
        title: "Federal Reserve issues FOMC statement",
        summary: "Monetary policy decision",
        sourceName: "Federal Reserve — Monetary Policy",
        sourcePublisher: "Federal Reserve",
        sourceKind: "Fed",
        publishedAt: "2026-07-29T13:00:00.000Z",
      },
      {
        url: "https://example.com/old",
        title: "Old item",
        sourceName: "Old source",
        sourceKind: "Blog",
        publishedAt: "2026-07-27T00:00:00.000Z",
      },
    ],
  };

  const selected = selectIncrementalItems({
    scannedSnapshot,
    previousSnapshot,
    state: null,
  });
  assert.equal(selected.length, 1);
  assert.equal(selected[0].url, "https://example.com/new");
  assert.equal(selected[0].ref, "N1");
});

test("baselines a newly connected source instead of backfilling its history", () => {
  const selected = selectIncrementalItems({
    previousSnapshot: {
      generatedAt: "2026-07-29T12:00:00.000Z",
      items: [
        {
          sourceId: 1,
          url: "https://example.com/source-one/seen",
        },
      ],
    },
    scannedSnapshot: {
      generatedAt: "2026-07-29T14:00:00.000Z",
      items: [
        {
          sourceId: 1,
          url: "https://example.com/source-one/new",
          title: "New item from an initialized source",
          sourceName: "Source one",
          sourceKind: "Blog",
          publishedAt: "2026-07-29T13:00:00.000Z",
        },
        {
          sourceId: 2,
          url: "https://example.com/source-two/history",
          title: "Historical item from a newly connected source",
          sourceName: "Source two",
          sourceKind: "Blog",
          publishedAt: "2026-07-01T13:00:00.000Z",
        },
      ],
    },
    state: null,
  });

  assert.equal(selected.length, 1);
  assert.equal(selected[0].url, "https://example.com/source-one/new");
});

test("creates a baseline from every currently visible item and connected source", () => {
  const baseline = createBaselineState({
    generatedAt: "2026-07-29T14:00:00.000Z",
    statuses: [
      { sourceId: 1, status: "ok" },
      { sourceId: 2, status: "needs_auth" },
    ],
    items: [
      { sourceId: 1, url: "https://example.com/one" },
      { sourceId: 1, url: "https://example.com/two" },
    ],
  });

  assert.deepEqual(baseline.initializedSourceIds, ["1"]);
  assert.equal(baseline.windowStartAt, "2026-07-29T14:00:00.000Z");
  assert.deepEqual(baseline.processedUrls, [
    "https://example.com/one",
    "https://example.com/two",
  ]);
});

test("keeps the cursor window open until every eligible batch participates", () => {
  const previousSnapshot = {
    generatedAt: "2026-07-29T12:00:00.000Z",
    items: [
      {
        sourceId: 1,
        url: "https://example.com/seen",
      },
    ],
  };
  const scannedSnapshot = {
    generatedAt: "2026-07-29T14:00:00.000Z",
    statuses: [{ sourceId: 1, status: "ok" }],
    items: Array.from({ length: 50 }, (_, index) => ({
      sourceId: 1,
      sourceName: "Example",
      sourceKind: "Blog",
      title: `New item ${index}`,
      summary: "New",
      url: `https://example.com/new-${index}`,
      publishedAt: "2026-07-29T13:00:00.000Z",
    })),
  };
  const initialState = {
    lastScanAt: previousSnapshot.generatedAt,
    windowStartAt: previousSnapshot.generatedAt,
    initializedSourceIds: ["1"],
    processedUrls: ["https://example.com/seen"],
  };
  const firstBatch = selectIncrementalItems({
    scannedSnapshot,
    previousSnapshot,
    state: initialState,
  });
  const afterFirst = nextState({
    state: initialState,
    previousSnapshot,
    candidates: firstBatch,
    scannedSnapshot,
  });
  const secondBatch = selectIncrementalItems({
    scannedSnapshot,
    previousSnapshot,
    state: afterFirst,
  });

  assert.equal(firstBatch.length, 24);
  assert.equal(secondBatch.length, 24);
  assert.equal(afterFirst.windowStartAt, previousSnapshot.generatedAt);

  const afterSecond = nextState({
    state: afterFirst,
    previousSnapshot,
    candidates: secondBatch,
    scannedSnapshot,
  });
  const thirdBatch = selectIncrementalItems({
    scannedSnapshot,
    previousSnapshot,
    state: afterSecond,
  });
  const afterThird = nextState({
    state: afterSecond,
    previousSnapshot,
    candidates: thirdBatch,
    scannedSnapshot,
  });

  assert.equal(thirdBatch.length, 2);
  assert.equal(afterThird.windowStartAt, scannedSnapshot.generatedAt);
});

test("includes a single-source feed story without changing an old article", () => {
  const oldSignal = {
    id: 1,
    title: "旧新闻",
    evidence: [],
  };
  const radar = {
    generatedAt: "2026-07-29T12:00:00.000Z",
    signals: [oldSignal],
    translations: {
      zh: { signals: [{ title: "旧新闻" }] },
      en: { signals: [{ title: "Old story" }] },
    },
  };
  const candidates = [
    {
      ref: "N1",
      id: "fed-1",
      sourceId: 162,
      sourceName: "Federal Reserve — Monetary Policy",
      sourcePublisher: "Federal Reserve",
      sourceKind: "Fed",
      title: "Federal Reserve issues FOMC statement",
      summary: "Official policy statement",
      url: "https://federalreserve.gov/fomc",
      publishedAt: "2026-07-29T18:00:00.000Z",
      fetchedAt: "2026-07-29T19:00:00.000Z",
    },
  ];
  const raw = {
    feedStories: [
      {
        bucket: "dynamic",
        priority: 95,
        signal: {
          category: "宏观",
          eyebrow: "必须知道",
          title: "FOMC 发布最新政策声明",
          summary: "Federal Reserve 发布正式政策声明。",
          why: "政策措辞会影响利率预期。",
          impact: "市场可能重新评估利率路径。",
          shiftFrom: "等待政策信号",
          shiftTo: "正式声明落地",
          crossValidation: "该结论来自 Federal Reserve 正式文件。",
          article: article("中文"),
          evidence: [{ ref: "N1", role: "主张", takeaway: "正式声明发布。" }],
          score: 96,
        },
        translation: {
          category: "Macro",
          eyebrow: "Must know",
          title: "FOMC releases its latest policy statement",
          summary: "The Federal Reserve issued its official policy statement.",
          why: "Its language can reshape rate expectations.",
          impact: "Markets may reassess the expected rate path.",
          shiftFrom: "Awaiting policy signal",
          shiftTo: "Official statement released",
          crossValidation: "The conclusion rests on the official Fed release.",
          article: article("English"),
          evidence: [{ role: "Claim", takeaway: "The statement was released." }],
        },
      },
    ],
    ignored: [],
  };

  const coverage = validateFeedCoverage(raw, candidates);
  assert.deepEqual(coverage, {
    storyItemCount: 1,
    updateItemCount: 0,
    ignoredItemCount: 0,
  });

  const hydratedStories = hydrateFeedStories({
    raw,
    candidates,
    radar,
    generatedAt: "2026-07-29T19:00:00.000Z",
  });
  assert.equal(hydratedStories.length, 1);
  assert.equal(hydratedStories[0].signal.editorialBucket, "dynamic");
  assert.equal(hydratedStories[0].signal.validationType, "单一来源");
  assert.equal(
    hydratedStories[0].signal.publishedAt,
    "2026-07-29T18:00:00.000Z",
  );

  const merged = mergeFeedStories({
    radar,
    hydratedStories,
    scannedSnapshot: {
      generatedAt: "2026-07-29T19:00:00.000Z",
      items: candidates,
    },
  });
  assert.equal(merged.signals.length, 2);
  assert.equal(merged.signals[0].title, "FOMC 发布最新政策声明");
  assert.deepEqual(merged.signals[1], oldSignal);
  assert.equal(
    merged.translations.en.signals[0].title,
    raw.feedStories[0].translation.title,
  );
  assert.equal(merged.translations.en.signals[1].title, "Old story");
});

test("requires every newly fetched ref to be included or explicitly ignored", () => {
  const candidates = [
    { ref: "N1", url: "https://example.com/one" },
    { ref: "N2", url: "https://example.com/two" },
  ];
  assert.throws(
    () =>
      validateFeedCoverage(
        {
          feedStories: [
            { signal: { evidence: [{ ref: "N1" }] } },
          ],
          ignored: [],
        },
        candidates,
      ),
    /N2/,
  );
  assert.deepEqual(
    validateFeedCoverage(
      {
        feedStories: [
          { signal: { evidence: [{ ref: "N1" }] } },
        ],
        ignored: [{ ref: "N2", reason: "完全重复" }],
      },
      candidates,
    ),
    { storyItemCount: 1, updateItemCount: 0, ignoredItemCount: 1 },
  );
});

test("appends new evidence and progress to an existing story without rewriting it", () => {
  const oldArticle = article("original");
  const radar = {
    generatedAt: "2026-07-29T12:00:00.000Z",
    signals: [
      {
        id: 7,
        title: "既有事件",
        article: oldArticle,
        score: 60,
        evidence: [],
        references: [],
        sources: [],
        sourceNames: [],
        sourceCount: 0,
      },
    ],
    translations: {
      zh: {
        signals: [{ title: "既有事件", article: oldArticle, evidence: [] }],
      },
      en: {
        signals: [
          { title: "Existing event", article: oldArticle, evidence: [] },
        ],
      },
    },
  };
  const candidates = [
    {
      ref: "N1",
      sourceName: "Example Blog",
      sourcePublisher: "Example Blog",
      sourceKind: "Blog",
      title: "A follow-up",
      summary: "New evidence",
      url: "https://example.com/follow-up",
      publishedAt: "2026-07-29T20:00:00.000Z",
    },
  ];
  const raw = {
    feedStories: [],
    existingUpdates: [
      {
        existingSignalId: 7,
        priority: 72,
        update: {
          title: "出现新的佐证",
          summary: "Example Blog 补充了新的公开证据。",
          evidence: [
            { ref: "N1", role: "最新进展", takeaway: "公开了新的证据。" },
          ],
        },
        translation: {
          title: "New supporting evidence",
          summary: "Example Blog added new public evidence.",
          evidence: [
            { role: "Update", takeaway: "It published new evidence." },
          ],
        },
      },
    ],
    ignored: [],
  };

  const hydratedUpdates = hydrateExistingUpdates({
    raw,
    candidates,
    radar,
    generatedAt: "2026-07-29T21:00:00.000Z",
  });
  const merged = mergeFeedStories({
    radar,
    hydratedStories: [],
    hydratedUpdates,
    scannedSnapshot: {
      generatedAt: "2026-07-29T21:00:00.000Z",
      items: candidates,
    },
  });

  assert.deepEqual(merged.signals[0].article, oldArticle);
  assert.equal(merged.signals[0].updates[0].title, "出现新的佐证");
  assert.equal(merged.signals[0].evidence[0].url, candidates[0].url);
  assert.equal(
    merged.translations.en.signals[0].updates[0].title,
    "New supporting evidence",
  );
  assert.equal(merged.incremental.lastUpdatedCount, 1);
});
