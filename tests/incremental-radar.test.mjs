import assert from "node:assert/strict";
import test from "node:test";
import {
  auditIncrementalItems,
  assignUniqueResearchRefs,
  assertEditorialArticleQuality,
  assertUniqueCandidateRefs,
  applyEditorialPublicationBar,
  assertSnapshotHealth,
  createBaselineState,
  hydrateEditorialResearchCandidates,
  hydrateConversationItems,
  hydrateGroundingCandidates,
  hydrateExistingUpdates,
  hydrateFeedStories,
  hasDirectRadarScope,
  hasFreshDynamicEvidence,
  mergeFeedStories,
  mergeConversationItems,
  nextState,
  normalizeFeedCoverageRefs,
  qualifiesDynamicMateriality,
  qualifiesExploreMateriality,
  selectEditorialResearchItems,
  selectIncrementalItems,
  validateConversationCoverage,
  validateEditorialResearchCoverage,
  validateFeedCoverage,
  withoutDeferredResearchCandidates,
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

test("allows a bounded first-connect lookback for a new conversation source", () => {
  const scannedSnapshot = {
    generatedAt: "2026-07-31T14:00:00.000Z",
    items: [
      {
        sourceId: 222,
        url: "https://example.com/podcast/149",
        title: "Episode 149",
        sourceName: "Technology Conversations",
        sourceKind: "Podcast",
        conversationSource: true,
        initialLookbackHours: 48,
        publishedAt: "2026-07-30T23:30:00.000Z",
      },
      {
        sourceId: 222,
        url: "https://example.com/podcast/148",
        title: "Episode 148",
        sourceName: "Technology Conversations",
        sourceKind: "Podcast",
        conversationSource: true,
        initialLookbackHours: 48,
        publishedAt: "2026-07-20T23:30:00.000Z",
      },
    ],
  };
  const previousSnapshot = {
    generatedAt: "2026-07-31T13:00:00.000Z",
    items: [],
  };

  const selected = selectIncrementalItems({
    scannedSnapshot,
    previousSnapshot,
    state: {
      lastScanAt: "2026-07-31T13:00:00.000Z",
      windowStartAt: "2026-07-31T13:00:00.000Z",
      initializedSourceIds: [],
      processedKeys: [],
    },
  });

  assert.deepEqual(selected.map((item) => item.url), [
    "https://example.com/podcast/149",
  ]);

  const advanced = nextState({
    state: {
      lastScanAt: "2026-07-31T13:00:00.000Z",
      windowStartAt: "2026-07-31T13:00:00.000Z",
      initializedSourceIds: [],
      processedKeys: [],
    },
    previousSnapshot,
    candidates: selected,
    scannedSnapshot: {
      ...scannedSnapshot,
      statuses: [{ sourceId: 222, status: "ok" }],
    },
  });
  assert.equal(
    advanced.processedKeys.includes("https://example.com/podcast/149"),
    true,
  );
  assert.equal(
    advanced.processedKeys.includes("https://example.com/podcast/148"),
    true,
  );
});

test("reserves a separate candidate lane for new conversations", () => {
  const regularItems = Array.from({ length: 12 }, (_, index) => ({
    sourceId: index + 1,
    url: `https://example.com/news/${index}`,
    title: `Official AI release ${index}`,
    summary: "A material new AI product announcement",
    sourceName: `Company ${index}`,
    sourceKind: "Blog",
    publishedAt: "2026-07-31T13:50:00.000Z",
    firstSeenAt: "2026-07-31T13:55:00.000Z",
  }));
  const conversation = {
    sourceId: 222,
    url: "https://example.com/podcast/149",
    title: "A deep conversation about AI for AI",
    summary: "A long-form discussion with a researcher",
    sourceName: "Technology Conversations",
    sourceKind: "Podcast",
    conversationSource: true,
    publishedAt: "2026-07-31T13:40:00.000Z",
    firstSeenAt: "2026-07-31T13:56:00.000Z",
  };

  const selected = selectIncrementalItems({
    scannedSnapshot: {
      generatedAt: "2026-07-31T14:00:00.000Z",
      items: [...regularItems, conversation],
    },
    previousSnapshot: {
      generatedAt: "2026-07-31T13:00:00.000Z",
      items: [],
    },
    state: {
      lastScanAt: "2026-07-31T13:00:00.000Z",
      windowStartAt: "2026-07-31T13:00:00.000Z",
      initializedSourceIds: [
        ...regularItems.map((item) => String(item.sourceId)),
        "222",
      ],
      processedKeys: [],
    },
  });

  assert.equal(selected.filter((item) => !item.conversationSource).length, 8);
  assert.equal(
    selected.some((item) => item.url === conversation.url),
    true,
  );
});

test("accounts for every new conversation and hydrates a bilingual briefing", () => {
  const candidates = [
    {
      ref: "N1",
      sourceId: 222,
      sourceName: "张小珺Jùn｜商业访谈录",
      sourceKind: "Podcast",
      title: "149. 和清华刘子鸣聊 AI for AI",
      url: "https://example.com/podcast/149",
      publishedAt: "2026-07-30T23:30:00.000Z",
      durationMinutes: 101,
    },
    {
      ref: "N2",
      sourceId: 222,
      sourceName: "张小珺Jùn｜商业访谈录",
      sourceKind: "Podcast",
      title: "A short promotional clip",
      url: "https://example.com/podcast/clip",
      publishedAt: "2026-07-31T00:00:00.000Z",
    },
  ];
  const raw = {
    conversations: [
      {
        ref: "N1",
        guest: "刘子鸣",
        categoryZh: "AI 研究",
        categoryEn: "AI research",
        titleZh: "AI 开始介入 AI 的研究过程",
        titleEn: "AI begins to reshape AI research itself",
        dekZh: "对谈讨论 AI for AI 如何改变研究流程与机制解释。",
        dekEn:
          "The conversation examines how AI for AI changes research workflows and mechanistic explanation.",
        whyListenZh: "它把资本热潮放回研究方法变化中理解。",
        whyListenEn:
          "It places the capital cycle inside a deeper change in research methods.",
        takeawaysZh: ["研究自动化", "机制解释", "资本周期"],
        takeawaysEn: [
          "Research automation",
          "Mechanistic explanation",
          "Capital cycles",
        ],
        counterpointZh: "节目观点仍需用后续研究产出检验。",
        counterpointEn:
          "The thesis still needs to be tested against future research output.",
        articleZh: article("中文对谈"),
        articleEn: article("English conversation"),
      },
    ],
    ignored: [{ ref: "N2", reason: "归档：只是短宣传切片" }],
  };

  assert.deepEqual(validateConversationCoverage(raw, candidates), {
    included: 1,
    ignored: 1,
  });
  const hydrated = hydrateConversationItems({
    raw,
    candidates,
    conversations: { items: [] },
    generatedAt: "2026-07-31T14:00:00.000Z",
  });
  assert.equal(hydrated.length, 1);
  assert.equal(hydrated[0].durationMinutes, 101);
  assert.equal(hydrated[0].sourceKind, "Podcast");
  assert.equal(hydrated[0].feedBatchAt, "2026-07-31T14:00:00.000Z");
  assert.equal(hydrated[0].takeawaysZh.length, 3);

  const merged = mergeConversationItems({
    conversations: {
      generatedAt: "2026-07-24T00:00:00.000Z",
      items: [
        {
          id: "old",
          titleZh: "既有对谈",
          url: "https://example.com/podcast/old",
        },
      ],
    },
    newItems: hydrated,
    generatedAt: "2026-07-31T14:00:00.000Z",
    model: "gpt-test",
  });
  assert.deepEqual(
    merged.items.map((item) => item.url),
    [
      "https://example.com/podcast/149",
      "https://example.com/podcast/old",
    ],
  );
  assert.equal(
    merged.items[1].feedBatchAt,
    "2026-07-24T00:00:00.000Z",
  );
  assert.equal(merged.model, "gpt-test");
});

test("rejects an unaccounted or multiply assigned conversation candidate", () => {
  const candidates = [{ ref: "N1" }, { ref: "N2" }];
  assert.throws(
    () =>
      validateConversationCoverage(
        {
          conversations: [{ ref: "N1" }],
          ignored: [],
        },
        candidates,
      ),
    /did not account/,
  );
  assert.throws(
    () =>
      validateConversationCoverage(
        {
          conversations: [{ ref: "N1" }],
          ignored: [
            { ref: "N1", reason: "duplicate" },
            { ref: "N2", reason: "weak" },
          ],
        },
        candidates,
      ),
    /assigned twice/,
  );
});

test("selects a late-arriving URL by first discovery time instead of stale publisher metadata", () => {
  const previousSnapshot = {
    generatedAt: "2026-07-31T13:00:00.000Z",
    items: [
      {
        sourceId: 214,
        url: "https://example.com/seed/seen",
      },
    ],
  };
  const scannedSnapshot = {
    generatedAt: "2026-07-31T14:20:00.000Z",
    statuses: [{ sourceId: 214, status: "ok" }],
    items: [
      {
        sourceId: 214,
        url: "https://example.com/seedance-2-5",
        title: "Introducing Seedance 2.5",
        summary: "A new video creation model",
        sourceName: "ByteDance Seed Blog",
        sourceKind: "Blog",
        publishedAt: "2026-07-31T04:01:20.000Z",
        firstSeenAt: "2026-07-31T14:18:13.755Z",
      },
    ],
  };
  const state = {
    lastScanAt: "2026-07-31T13:00:00.000Z",
    windowStartAt: "2026-07-31T13:00:00.000Z",
    initializedSourceIds: ["214"],
    processedKeys: ["https://example.com/seed/seen"],
  };

  const selected = selectIncrementalItems({
    scannedSnapshot,
    previousSnapshot,
    state,
  });

  assert.equal(selected.length, 1);
  assert.equal(selected[0].url, "https://example.com/seedance-2-5");

  const advanced = nextState({
    state,
    previousSnapshot,
    candidates: [],
    scannedSnapshot,
  });
  assert.equal(advanced.windowStartAt, state.windowStartAt);
});

test("freshness gate excludes stale discoveries but preserves deferred research", () => {
  const stale = {
    sourceId: 214,
    url: "https://example.com/stale-release",
    title: "OpenAI releases an old API",
    sourceName: "OpenAI Blog",
    sourcePublisher: "OpenAI",
    sourceKind: "Blog",
    publishedAt: "2026-07-01T04:01:20.000Z",
    firstSeenAt: "2026-07-31T14:18:13.755Z",
  };
  const options = {
    scannedSnapshot: {
      generatedAt: "2026-07-31T14:20:00.000Z",
      items: [stale],
    },
    previousSnapshot: {
      generatedAt: "2026-07-31T13:00:00.000Z",
      items: [{ sourceId: 214, url: "https://example.com/seen" }],
    },
    state: {
      lastScanAt: "2026-07-31T13:00:00.000Z",
      initializedSourceIds: ["214"],
      processedKeys: [],
    },
  };

  const rejected = auditIncrementalItems(options);
  assert.equal(rejected.eligible.length, 0);
  assert.equal(
    rejected.excluded.some(
      (entry) => entry.reason === "outside_freshness_window",
    ),
    true,
  );

  const deferred = auditIncrementalItems({
    ...options,
    state: {
      ...options.state,
      deferredKeys: [stale.url],
    },
  });
  assert.equal(deferred.eligible.length, 1);
  assert.equal(deferred.eligible[0].deferredResearch, true);
});

test("does not revive an old unseen URL when its first discovery is outside the overlap window", () => {
  const previousSnapshot = {
    generatedAt: "2026-07-31T13:00:00.000Z",
    items: [{ sourceId: 214, url: "https://example.com/seed/seen" }],
  };
  const scannedSnapshot = {
    generatedAt: "2026-07-31T14:20:00.000Z",
    statuses: [{ sourceId: 214, status: "ok" }],
    items: [
      {
        sourceId: 214,
        url: "https://example.com/seedance-old",
        title: "Old release",
        sourceName: "ByteDance Seed Blog",
        sourceKind: "Blog",
        publishedAt: "2026-06-01T04:01:20.000Z",
        firstSeenAt: "2026-07-30T06:00:00.000Z",
      },
    ],
  };

  const selected = selectIncrementalItems({
    scannedSnapshot,
    previousSnapshot,
    state: {
      lastScanAt: "2026-07-31T13:00:00.000Z",
      windowStartAt: "2026-07-31T13:00:00.000Z",
      initializedSourceIds: ["214"],
      processedKeys: ["https://example.com/seed/seen"],
    },
  });

  assert.equal(selected.length, 0);
});

test("prioritizes an official product release over a full batch of fresh commentary", () => {
  const previousSnapshot = {
    generatedAt: "2026-07-31T13:00:00.000Z",
    items: [{ sourceId: 214, url: "https://example.com/seed/seen" }],
  };
  const commentary = Array.from({ length: 8 }, (_, index) => ({
    sourceId: 50 + index,
    url: `https://example.com/commentary-${index}`,
    title: `A fresh opinion about software ${index}`,
    summary: "A personal observation without a product announcement",
    sourceName: `Commentary ${index}`,
    sourceKind: "Blog",
    publishedAt: "2026-07-31T14:15:00.000Z",
    firstSeenAt: "2026-07-31T14:18:00.000Z",
  }));
  const scannedSnapshot = {
    generatedAt: "2026-07-31T14:20:00.000Z",
    items: [
      ...commentary,
      {
        sourceId: 214,
        url: "https://example.com/seedance-2-5",
        title: "Introducing Seedance 2.5",
        summary: "One-take creation with multimodal references",
        sourceName: "ByteDance Seed Blog",
        sourceKind: "Blog",
        publishedAt: "2026-07-31T04:01:20.000Z",
        firstSeenAt: "2026-07-31T14:18:13.755Z",
      },
    ],
  };

  const selected = selectIncrementalItems({
    scannedSnapshot,
    previousSnapshot,
    state: {
      lastScanAt: "2026-07-31T13:00:00.000Z",
      windowStartAt: "2026-07-31T13:00:00.000Z",
      initializedSourceIds: [
        "214",
        ...commentary.map((item) => String(item.sourceId)),
      ],
      processedKeys: ["https://example.com/seed/seen"],
    },
  });

  assert.equal(selected.length, 8);
  assert.equal(
    selected.some((item) => item.url === "https://example.com/seedance-2-5"),
    true,
  );
  const fastOnly = selectIncrementalItems({
    scannedSnapshot,
    previousSnapshot,
    state: {
      lastScanAt: "2026-07-31T13:00:00.000Z",
      windowStartAt: "2026-07-31T13:00:00.000Z",
      initializedSourceIds: [
        "214",
        ...commentary.map((item) => String(item.sourceId)),
      ],
      processedKeys: ["https://example.com/seed/seen"],
    },
    lanes: ["fast"],
  });
  assert.deepEqual(
    fastOnly.map((item) => item.url),
    ["https://example.com/seedance-2-5"],
  );
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

test("stops before advancing the cursor when source health collapses", () => {
  assert.doesNotThrow(() =>
    assertSnapshotHealth(
      { successfulSources: 155, failedSources: 0 },
      { successfulSources: 154 },
    ),
  );
  assert.throws(
    () =>
      assertSnapshotHealth(
        { successfulSources: 31, failedSources: 124 },
        { successfulSources: 154 },
      ),
    /Source health degraded/,
  );
});

test("requires direct Radar scope and fresh evidence for dynamic stories", () => {
  const wanhuaEvidence = [
    {
      sourceName: "万华化学集团股份有限公司",
      title: "2026年半年度业绩预增公告",
      summary: "归母净利润同比增长，磷酸铁锂进入客户批量供货。",
      publishedAt: "2026-07-06T00:00:00.000Z",
    },
  ];
  const nvidiaEvidence = [
    {
      sourceName: "NVIDIA",
      title: "NVIDIA launches a new inference GPU",
      summary: "The semiconductor platform targets AI data centers.",
      publishedAt: "2026-07-29T18:00:00.000Z",
    },
  ];

  assert.equal(hasDirectRadarScope(wanhuaEvidence), false);
  assert.equal(hasDirectRadarScope(nvidiaEvidence), true);
  assert.equal(
    hasFreshDynamicEvidence(
      wanhuaEvidence,
      "2026-07-30T04:00:00.000Z",
    ),
    false,
  );
  assert.equal(
    hasFreshDynamicEvidence(
      nvidiaEvidence,
      "2026-07-30T04:00:00.000Z",
    ),
    true,
  );
});

test("reserves dynamic for material signals with an editorial score of 82+", () => {
  assert.equal(
    qualifiesDynamicMateriality({
      bucket: "dynamic",
      materiality: "substantive",
      valueScore: 81,
    }),
    false,
  );
  assert.equal(
    qualifiesDynamicMateriality({
      bucket: "dynamic",
      materiality: "minor",
      valueScore: 95,
    }),
    false,
  );
  assert.equal(
    qualifiesDynamicMateriality({
      bucket: "dynamic",
      materiality: "material",
      valueScore: 92,
    }),
    true,
  );
});

test("keeps Explore as a scarce editorial layer with an 80-point hard floor", () => {
  assert.equal(
    qualifiesExploreMateriality({
      bucket: "explore",
      materiality: "substantive",
      changedVariable: "代理记忆开始转化为可复用知识",
      valueScore: 79,
    }),
    false,
  );
  assert.equal(
    qualifiesExploreMateriality({
      bucket: "explore",
      materiality: "minor",
      changedVariable: "新增一个小功能入口",
      valueScore: 95,
    }),
    false,
  );
  assert.equal(
    qualifiesExploreMateriality({
      bucket: "explore",
      materiality: "substantive",
      changedVariable: "代理记忆开始转化为可复用知识",
      valueScore: 84,
    }),
    true,
  );
});

test("archives model-selected stories that miss both publication bars", () => {
  const raw = applyEditorialPublicationBar({
    feedStories: [
      {
        bucket: "explore",
        materiality: "minor",
        changedVariable: "新增普通设置项",
        valueScore: 91,
        signal: {
          evidence: [{ ref: "N1" }, { ref: "N2" }],
        },
      },
      {
        bucket: "explore",
        materiality: "substantive",
        changedVariable: "推理成本改变模型路由选择",
        valueScore: 86,
        signal: {
          evidence: [{ ref: "N3" }],
        },
      },
    ],
    ignored: [{ ref: "N4", reason: "归档：完全重复" }],
  });

  assert.equal(raw.feedStories.length, 1);
  assert.deepEqual(
    raw.ignored.map(({ ref, reason }) => [ref, reason]),
    [
      ["N4", "归档：完全重复"],
      ["N1", "归档：未达到 Explore 编辑门槛"],
      ["N2", "归档：未达到 Explore 编辑门槛"],
    ],
  );
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
  const batchSizes = [];
  let currentState = initialState;
  for (let index = 0; index < 7; index += 1) {
    const batch = selectIncrementalItems({
      scannedSnapshot,
      previousSnapshot,
      state: currentState,
    });
    batchSizes.push(batch.length);
    currentState = nextState({
      state: currentState,
      previousSnapshot,
      candidates: batch,
      scannedSnapshot,
    });
    if (index < 6) {
      assert.equal(currentState.windowStartAt, previousSnapshot.generatedAt);
    }
  }

  assert.deepEqual(batchSizes, [8, 8, 8, 8, 8, 8, 2]);
  assert.equal(currentState.windowStartAt, scannedSnapshot.generatedAt);
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
        valueScore: 95,
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
  assert.equal(
    merged.signals[0].feedBatchAt,
    "2026-07-29T19:00:00.000Z",
  );
  assert.equal(merged.signals[0].score, 95);
  assert.deepEqual(merged.signals[1], oldSignal);
  assert.equal(
    merged.translations.en.signals[0].title,
    raw.feedStories[0].translation.title,
  );
  assert.equal(merged.translations.en.signals[1].title, "Old story");
});

test("rejects a new story when its evidence already belongs to an existing event", () => {
  const candidates = [
    {
      ref: "N1",
      id: "official-follow-up",
      sourceId: 197,
      sourceName: "Official Newsroom",
      sourcePublisher: "Official Publisher",
      sourceKind: "Blog",
      title: "Investigating three real-world incidents",
      summary: "The official follow-up confirms the same three incidents.",
      url: "https://example.com/official-follow-up",
      publishedAt: "2026-07-30T23:00:00.000Z",
      fetchedAt: "2026-07-31T01:00:00.000Z",
    },
  ];
  const raw = {
    feedStories: [
      {
        bucket: "dynamic",
        valueScore: 91,
        signal: {
          category: "Agents",
          eyebrow: "风险预警",
          title: "官方确认三起真实系统访问",
          summary: "官方复盘确认三起事件。",
          why: "这是重要的一手确认。",
          impact: "评估平台需要收紧隔离。",
          shiftFrom: "第三方转述",
          shiftTo: "官方确认",
          crossValidation: "官方一手来源。",
          article: article("中文"),
          evidence: [{ ref: "N1", role: "主张", takeaway: "官方确认。" }],
        },
        translation: {
          category: "Agents",
          eyebrow: "Risk alert",
          title: "Official review confirms three real-system accesses",
          summary: "The official review confirms the three incidents.",
          why: "It is a material primary-source confirmation.",
          impact: "Evaluators need tighter containment.",
          shiftFrom: "Third-party reporting",
          shiftTo: "Official confirmation",
          crossValidation: "Official primary source.",
          article: article("English"),
          evidence: [{ role: "Claim", takeaway: "Official confirmation." }],
        },
      },
    ],
  };
  const radar = {
    signals: [
      {
        id: 1,
        title: "已有事件",
        evidence: [
          {
            title: "Investigating three real-world incidents",
            url: "https://example.com/third-party-copy",
          },
        ],
      },
    ],
  };

  assert.throws(
    () =>
      hydrateFeedStories({
        raw,
        candidates,
        radar,
        generatedAt: "2026-07-31T01:00:00.000Z",
      }),
    /return it as an existingUpdate instead/,
  );
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

test("normalizes combined model refs without weakening strict coverage", () => {
  const candidates = [
    { ref: "N5", url: "https://example.com/source" },
    {
      ref: "R1",
      url: "https://example.com/research",
      researchedFrom: "N5",
    },
  ];
  const normalized = normalizeFeedCoverageRefs(
    {
      feedStories: [
        {
          signal: {
            evidence: [
              {
                ref: "N5/R1",
                role: "主张",
                takeaway: "原始来源与补充 research 支持同一判断。",
              },
            ],
          },
        },
      ],
      existingUpdates: [],
      ignored: [],
    },
    candidates,
  );

  assert.deepEqual(
    normalized.feedStories[0].signal.evidence.map((item) => item.ref),
    ["N5", "R1"],
  );
  assert.deepEqual(validateFeedCoverage(normalized, candidates), {
    storyItemCount: 2,
    updateItemCount: 0,
    ignoredItemCount: 0,
  });
});

test("normalizes colon-separated refs from fallback models", () => {
  const candidates = [
    { ref: "N1", url: "https://example.com/source" },
    {
      ref: "R1",
      url: "https://example.com/research",
      researchedFrom: "N1",
    },
  ];
  const normalized = normalizeFeedCoverageRefs(
    {
      feedStories: [],
      existingUpdates: [
        {
          update: {
            evidence: [{ ref: "N1:R1", takeaway: "同一证据链。" }],
          },
        },
      ],
      ignored: [],
    },
    candidates,
  );

  assert.deepEqual(
    normalized.existingUpdates[0].update.evidence.map((item) => item.ref),
    ["N1", "R1"],
  );
  assert.deepEqual(validateFeedCoverage(normalized, candidates), {
    storyItemCount: 0,
    updateItemCount: 2,
    ignoredItemCount: 0,
  });
});

test("repairs a research ref by carrying its parent into the same evidence set", () => {
  const candidates = [
    { ref: "N8", url: "https://example.com/source" },
    {
      ref: "R1",
      url: "https://example.com/research",
      researchedFrom: "N8",
    },
  ];
  const normalized = normalizeFeedCoverageRefs(
    {
      feedStories: [],
      existingUpdates: [
        {
          update: {
            evidence: [{ ref: "R1", takeaway: "Grounded update." }],
          },
        },
      ],
      ignored: [{ ref: "N8", reason: "归档：模型误分配" }],
    },
    candidates,
  );

  assert.deepEqual(
    normalized.existingUpdates[0].update.evidence.map((item) => item.ref),
    ["R1", "N8"],
  );
  assert.deepEqual(normalized.ignored, []);
  assert.deepEqual(validateFeedCoverage(normalized, candidates), {
    storyItemCount: 0,
    updateItemCount: 2,
    ignoredItemCount: 0,
  });
});

test("rejects combined refs from unrelated research lineages", () => {
  const candidates = [
    { ref: "N5", url: "https://example.com/source" },
    {
      ref: "R1",
      url: "https://example.com/research",
      researchedFrom: "N8",
    },
    { ref: "N8", url: "https://example.com/other-source" },
  ];
  const normalized = normalizeFeedCoverageRefs(
    {
      feedStories: [
        { signal: { evidence: [{ ref: "N5/R1" }] } },
      ],
      existingUpdates: [],
      ignored: [{ ref: "N8", reason: "归档：旧事件" }],
    },
    candidates,
  );

  assert.equal(normalized.feedStories[0].signal.evidence[0].ref, "N5/R1");
  assert.throws(
    () => validateFeedCoverage(normalized, candidates),
    /without its parent N8|unknown source ref N5\/R1/,
  );
});

test("rejects published research evidence without its parent source", () => {
  const candidates = [
    { ref: "N1", url: "https://example.com/one" },
    { ref: "N8", url: "https://example.com/eight" },
    {
      ref: "R1",
      url: "https://example.com/research",
      researchedFrom: "N8",
    },
  ];

  assert.throws(
    () =>
      validateFeedCoverage(
        {
          feedStories: [
            { signal: { evidence: [{ ref: "N1" }, { ref: "R1" }] } },
          ],
          existingUpdates: [],
          ignored: [{ ref: "N8", reason: "归档：旧事件" }],
        },
        candidates,
      ),
    /research ref R1 without its parent N8/,
  );
});

test("does not guess unknown or malformed model refs", () => {
  const candidates = [{ ref: "N1", url: "https://example.com/one" }];
  const normalized = normalizeFeedCoverageRefs(
    {
      feedStories: [],
      existingUpdates: [],
      ignored: [{ ref: "N1/R9", reason: "归档：不相关" }],
    },
    candidates,
  );

  assert.equal(normalized.ignored[0].ref, "N1/R9");
  assert.throws(
    () => validateFeedCoverage(normalized, candidates),
    /unknown source ref N1\/R9/,
  );
});

test("never permits an anonymous discovery ref as public evidence", () => {
  const candidates = [
    {
      ref: "N1",
      url: "https://private.example/discovery",
      discoveryOnly: true,
    },
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
    /cannot be used as public evidence/,
  );
});

test("rejects private discovery names leaked into public copy", () => {
  const candidates = [
    {
      ref: "G1",
      sourceName: "Samsung Electronics",
      sourcePublisher: "Samsung Electronics",
      sourceKind: "IR",
      title: "Official results",
      summary: "Official results",
      url: "https://www.samsung.com/global/ir/results",
      publishedAt: "2026-07-30T00:00:00.000Z",
    },
  ];
  const radar = {
    signals: [],
    translations: { zh: { signals: [] }, en: { signals: [] } },
  };
  assert.throws(
    () =>
      hydrateFeedStories({
        candidates,
        radar,
        generatedAt: "2026-07-30T00:20:00.000Z",
        raw: {
          feedStories: [
            {
              bucket: "dynamic",
              valueScore: 80,
              signal: {
                title: "财联社称公司发布财报",
                evidence: [{ ref: "G1" }],
              },
            },
          ],
        },
      }),
    /exposes a private discovery source/,
  );
});

test("hydrates external grounding while rejecting the private wire domain", () => {
  const discoveryItems = [
    {
      ref: "N1",
      id: "178-wire-1",
      sourceId: 178,
      publishedAt: "2026-07-30T00:00:00.000Z",
    },
  ];
  const grounded = hydrateGroundingCandidates({
    discoveryItems,
    generatedAt: "2026-07-30T00:20:00.000Z",
    raw: {
      results: [
        {
          ref: "N1",
          status: "grounded",
          claim: "Samsung reported quarterly earnings.",
          notes: "",
          sources: [
            {
              title: "2Q 2026 Earnings Release",
              url: "https://www.samsung.com/global/ir/earnings",
              publisher: "Samsung Electronics",
              publishedAt: "2026-07-30T00:00:00.000Z",
              sourceKind: "IR",
              summary: "The official release reports the quarter's results.",
            },
            {
              title: "Private wire copy",
              url: "https://api3.cls.cn/share/article/1",
              publisher: "Wire",
              sourceKind: "Media",
              summary: "A duplicate alert.",
            },
          ],
        },
      ],
    },
  });

  assert.equal(grounded.length, 1);
  assert.equal(grounded[0].ref, "G1");
  assert.equal(grounded[0].sourceName, "Samsung Electronics");
  assert.equal(grounded[0].sourceKind, "IR");
  assert.equal(grounded[0].groundedFrom, "N1");
});

test("selects material events for editorial web research", () => {
  const selected = selectEditorialResearchItems([
    {
      ref: "N1",
      sourceKind: "SEC",
      title: "Company reports quarterly earnings",
      summary: "Revenue and guidance were disclosed.",
      publishedAt: "2026-07-30T00:00:00.000Z",
    },
    {
      ref: "N2",
      sourceKind: "Blog",
      title: "A personal keyboard layout",
      summary: "Notes from one developer.",
      publishedAt: "2026-07-30T00:00:00.000Z",
    },
    {
      ref: "N3",
      sourceKind: "Wire",
      title: "Private earnings lead",
      discoveryOnly: true,
      publishedAt: "2026-07-30T00:00:00.000Z",
    },
    {
      ref: "G1",
      sourceKind: "Official",
      title: "Grounded official release",
      groundedFrom: "N3",
      publishedAt: "2026-07-30T00:00:00.000Z",
    },
  ]);

  assert.deepEqual(selected.map((item) => item.ref), ["N1"]);
});

test("requires every editorial research item to complete before publication", () => {
  const researchItems = [
    { ref: "N1", url: "https://example.com/one" },
    { ref: "N2", url: "https://example.com/two" },
  ];
  assert.deepEqual(
    validateEditorialResearchCoverage(
      {
        results: [
          {
            ref: "N1",
            status: "no_additional_sources",
            sources: [],
          },
          {
            ref: "N2",
            status: "researched",
            sources: [{ url: "https://example.com/source" }],
          },
        ],
      },
      researchItems,
    ),
    ["N1", "N2"],
  );
  assert.throws(
    () =>
      validateEditorialResearchCoverage(
        {
          results: [
            {
              ref: "N1",
              status: "no_additional_sources",
              sources: [],
            },
          ],
        },
        researchItems,
      ),
    /did not account for source refs: N2/,
  );
  assert.throws(
    () =>
      validateEditorialResearchCoverage(
        {
          results: [
            {
              ref: "N1",
              status: "researched",
              sources: [],
            },
            {
              ref: "N2",
              status: "no_additional_sources",
              sources: [],
            },
          ],
        },
        researchItems,
      ),
    /returned no sources/,
  );
});

test("defers failed research without consuming its URL or derived evidence", () => {
  const originalCandidates = [
    {
      ref: "N1",
      sourceId: 1,
      url: "https://example.com/completed",
      publishedAt: "2026-07-31T20:30:00.000Z",
    },
    {
      ref: "N2",
      sourceId: 1,
      url: "https://example.com/deferred",
      publishedAt: "2026-07-31T20:31:00.000Z",
    },
  ];
  const analysisCandidates = [
    ...originalCandidates,
    {
      ref: "G1",
      groundedFrom: "N2",
      url: "https://official.example/deferred-evidence",
    },
    {
      ref: "R1",
      researchedFrom: "N1",
      url: "https://official.example/completed-evidence",
    },
  ];

  assert.deepEqual(
    withoutDeferredResearchCandidates(analysisCandidates, ["N2"]).map(
      (item) => item.ref,
    ),
    ["N1", "R1"],
  );

  const processedCandidates = withoutDeferredResearchCandidates(
    originalCandidates,
    ["N2"],
  );
  const next = nextState({
    state: {
      lastScanAt: "2026-07-31T20:00:00.000Z",
      windowStartAt: "2026-07-31T20:00:00.000Z",
      initializedSourceIds: ["1"],
      processedUrls: [],
      processedKeys: [],
    },
    previousSnapshot: {
      generatedAt: "2026-07-31T20:00:00.000Z",
      items: [],
    },
    candidates: processedCandidates,
    deferredCandidates: originalCandidates.filter(
      (item) => item.ref === "N2",
    ),
    scannedSnapshot: {
      generatedAt: "2026-07-31T22:00:00.000Z",
      statuses: [{ sourceId: 1, status: "ok" }],
      items: originalCandidates,
    },
  });
  assert.ok(next.processedUrls.includes("https://example.com/completed"));
  assert.ok(!next.processedUrls.includes("https://example.com/deferred"));
  assert.ok(next.deferredKeys.includes("https://example.com/deferred"));
  assert.equal(next.windowStartAt, "2026-07-31T20:00:00.000Z");

  const retry = selectIncrementalItems({
    state: next,
    previousSnapshot: {
      generatedAt: "2026-07-31T22:00:00.000Z",
      items: originalCandidates,
    },
    scannedSnapshot: {
      generatedAt: "2026-08-10T22:00:00.000Z",
      statuses: [{ sourceId: 1, status: "ok" }],
      items: originalCandidates,
    },
  });
  assert.equal(retry[0].url, "https://example.com/deferred");
});

test("hydrates citeable editorial research and deduplicates original URLs", () => {
  const researchItems = [
    {
      ref: "N1",
      id: "item-1",
      sourceId: 170,
      url: "https://company.example/results",
      publishedAt: "2026-07-30T00:00:00.000Z",
    },
  ];
  const researched = hydrateEditorialResearchCandidates({
    researchItems,
    generatedAt: "2026-07-30T00:20:00.000Z",
    raw: {
      results: [
        {
          ref: "N1",
          status: "researched",
          centralClaim: "Revenue grew while guidance increased.",
          comparisons: "Consensus was supplied by a named provider.",
          unresolved: "",
          sources: [
            {
              title: "Quarterly results",
              url: "https://company.example/results",
              publisher: "Company",
              sourceKind: "IR",
              role: "Primary",
              summary: "The release reports actual results.",
            },
            {
              title: "Analyst expectations",
              url: "https://media.example/consensus",
              publisher: "Independent Media",
              sourceKind: "Media",
              role: "Consensus",
              summary: "The report names the consensus provider and estimate.",
            },
          ],
        },
      ],
    },
  });

  assert.equal(researched.length, 1);
  assert.equal(researched[0].ref, "R1");
  assert.equal(researched[0].researchedFrom, "N1");
  assert.equal(researched[0].researchRole, "Consensus");
});

test("assigns globally unique refs after parallel research chunks are merged", () => {
  const merged = assignUniqueResearchRefs([
    { ref: "R1", url: "https://example.com/one", researchedFrom: "N1" },
    { ref: "R1", url: "https://example.com/two", researchedFrom: "N2" },
    { ref: "R2", url: "https://example.com/three", researchedFrom: "N2" },
  ]);

  assert.deepEqual(
    merged.map((item) => [item.ref, item.researchedFrom]),
    [
      ["R1", "N1"],
      ["R2", "N2"],
      ["R3", "N2"],
    ],
  );
  assert.doesNotThrow(() => assertUniqueCandidateRefs(merged));
  assert.throws(
    () =>
      assertUniqueCandidateRefs([
        { ref: "N1" },
        { ref: "R1" },
        { ref: "R1" },
      ]),
    /globally unique: R1/,
  );
});

test("rejects research-process disclaimers from article copy", () => {
  assert.throws(
    () =>
      assertEditorialArticleQuality(
        {
          lead: "Meta公布季度业绩。",
          sections: [
            {
              heading: "结果",
              body: "由于没有引入分析师一致预期，这里不作beat或miss判断。",
            },
          ],
          outlook: "关注下一季指引。",
        },
        "test",
      ),
    /research limitation/,
  );
  assert.doesNotThrow(() =>
    assertEditorialArticleQuality(
      {
        lead: "Meta营收增长，但利润率下降成为本季核心变化。",
        sections: [
          {
            heading: "经营杠杆转向",
            body: "广告量价增长与基础设施投入共同改变利润结构。",
          },
        ],
        outlook: "下一季重点验证广告增长能否覆盖折旧与基础设施投入。",
      },
      "test",
    ),
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
        valueScore: 72,
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
  assert.equal(
    merged.signals[0].feedBatchAt,
    "2026-07-29T21:00:00.000Z",
  );
  assert.equal(merged.signals[0].score, 72);
  assert.equal(merged.signals[0].evidence[0].url, candidates[0].url);
  assert.equal(
    merged.translations.en.signals[0].updates[0].title,
    "New supporting evidence",
  );
  assert.equal(merged.incremental.lastUpdatedCount, 1);
});

test("corroboration adds evidence without resetting exposure or editorial value", () => {
  const oldArticle = article("original");
  const originalExposure = "2026-07-28T12:00:00.000Z";
  const radar = {
    generatedAt: originalExposure,
    signals: [
      {
        id: 7,
        title: "既有事件",
        article: oldArticle,
        score: 84,
        feedBatchAt: originalExposure,
        updatedAt: "2026-07-28T10:00:00.000Z",
        evidence: [],
        references: [],
        sources: [],
        sourceNames: [],
        sourceCount: 0,
      },
    ],
    translations: {
      zh: { signals: [{ title: "既有事件", article: oldArticle, evidence: [] }] },
      en: {
        signals: [
          { title: "Existing event", article: oldArticle, evidence: [] },
        ],
      },
    },
  };
  const evidence = {
    ref: "N1",
    sourceName: "Example Blog",
    sourcePublisher: "Example Blog",
    sourceKind: "Blog",
    title: "A corroborating source",
    summary: "Confirms an existing claim",
    url: "https://example.com/corroboration",
    publishedAt: "2026-07-29T20:00:00.000Z",
  };
  const hydratedUpdates = hydrateExistingUpdates({
    raw: {
      feedStories: [],
      existingUpdates: [
        {
          existingSignalId: 7,
          valueScore: 96,
          changeType: "corroboration",
          thesisImpact: "Confirms the existing thesis.",
          update: {
            title: "补充佐证",
            summary: "新增来源确认原有事实。",
            evidence: [
              { ref: "N1", role: "佐证", takeaway: "确认原有事实。" },
            ],
          },
          translation: {
            title: "Additional corroboration",
            summary: "A new source confirms the existing fact.",
            evidence: [{ role: "Evidence", takeaway: "Confirms the fact." }],
          },
        },
      ],
      ignored: [],
    },
    candidates: [evidence],
    radar,
    generatedAt: "2026-07-29T21:00:00.000Z",
  });
  const merged = mergeFeedStories({
    radar,
    hydratedStories: [],
    hydratedUpdates,
    scannedSnapshot: {
      generatedAt: "2026-07-29T21:00:00.000Z",
      items: [evidence],
    },
  });

  assert.equal(merged.signals[0].feedBatchAt, originalExposure);
  assert.equal(merged.signals[0].updatedAt, "2026-07-28T10:00:00.000Z");
  assert.equal(merged.signals[0].score, 84);
  assert.equal(merged.signals[0].evidence[0].url, evidence.url);
  assert.equal(merged.signals[0].updates[0].changeType, "corroboration");
});
