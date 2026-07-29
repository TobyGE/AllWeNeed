import assert from "node:assert/strict";
import test from "node:test";
import {
  hydrateMajorEvents,
  mergeMajorEvents,
  selectIncrementalItems,
} from "../scripts/append-major-events.mjs";

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

test("selects only unseen items published near the last scan", () => {
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

test("prepends a new official event without changing an old article", () => {
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
    majorEvents: [
      {
        importance: 95,
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
  };

  const hydratedEvents = hydrateMajorEvents({
    raw,
    candidates,
    radar,
    generatedAt: "2026-07-29T19:00:00.000Z",
  });
  assert.equal(hydratedEvents.length, 1);
  assert.equal(hydratedEvents[0].signal.validationType, "单一来源");

  const merged = mergeMajorEvents({
    radar,
    hydratedEvents,
    scannedSnapshot: {
      generatedAt: "2026-07-29T19:00:00.000Z",
      items: candidates,
    },
  });
  assert.equal(merged.signals.length, 2);
  assert.equal(merged.signals[0].title, "FOMC 发布最新政策声明");
  assert.deepEqual(merged.signals[1], oldSignal);
  assert.equal(merged.translations.en.signals[0].title, raw.majorEvents[0].translation.title);
  assert.equal(merged.translations.en.signals[1].title, "Old story");
});
