import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateSignalHeat,
  compareConversationEditorialValue,
  compareEditorialValue,
  compareExposureEditorialValue,
  compareExploreEditorialValue,
  compareSignalHeat,
  DYNAMIC_FEED_MAX_EXPOSURE_HOURS,
  EXPLORE_FEED_MAX_EXPOSURE_HOURS,
  EXPLORE_EDITORIAL_FLOOR,
  ADAPTIVE_FEED_POLICIES,
  exposureDecayPenalty,
  exposureEditorialScore,
  formatExposureAge,
  conversationExposureDecayPenalty,
  conversationExposureEditorialScore,
  meetsExploreEditorialFloor,
  selectAdaptiveFeedItems,
} from "../app/signal-heat.ts";

const publishedAt = "2026-07-01T12:00:00.000Z";

test("requires an 80-point editorial score before Explore can be shown", () => {
  assert.equal(EXPLORE_EDITORIAL_FLOOR, 80);
  assert.equal(meetsExploreEditorialFloor({ valueScore: 79 }), false);
  assert.equal(meetsExploreEditorialFloor({ valueScore: 80 }), true);
  assert.equal(meetsExploreEditorialFloor({ score: 88 }), true);
});

test("retires a dynamic signal through heat decay instead of a list limit", () => {
  const signal = {
    score: 88,
    feedBatchAt: publishedAt,
    publishedAt,
    sourceCount: 1,
    evidence: [{ publishedAt }],
  };
  const fresh = calculateSignalHeat(signal, {
    now: publishedAt,
    profile: "dynamic",
  });
  const old = calculateSignalHeat(signal, {
    now: "2026-07-11T12:00:00.000Z",
    profile: "dynamic",
  });

  assert.equal(fresh.visible, true);
  assert.ok(fresh.score > old.score);
  assert.equal(old.visible, false);
  assert.equal(old.stage, "dormant");
});

test("dynamic feed releases every story after 48 hours", () => {
  const signal = {
    score: 99,
    feedBatchAt: "2026-07-08T12:00:00.000Z",
    sourceCount: 6,
    sources: ["Official", "SEC", "Media"],
    evidence: [
      { publishedAt: "2026-07-08T12:00:00.000Z" },
      { publishedAt: "2026-07-08T12:00:00.000Z" },
    ],
  };
  const inside = calculateSignalHeat(signal, {
    now: "2026-07-10T12:00:00.000Z",
    profile: "dynamic",
  });
  const outside = calculateSignalHeat(signal, {
    now: "2026-07-10T12:01:00.000Z",
    profile: "dynamic",
  });

  assert.equal(DYNAMIC_FEED_MAX_EXPOSURE_HOURS, 48);
  assert.equal(inside.visible, true);
  assert.equal(outside.visible, false);
  assert.ok(outside.score >= 38);
});

test("legacy permanent metadata cannot bypass heat retirement", () => {
  const old = calculateSignalHeat(
    {
      permanent: true,
      score: 92,
      feedBatchAt: publishedAt,
      publishedAt,
    },
    {
      now: "2026-07-21T12:00:00.000Z",
      profile: "dynamic",
    },
  );

  assert.equal(old.visible, false);
});

test("a newly system-published material update reheats an existing event", () => {
  const stale = calculateSignalHeat(
    {
      score: 86,
      feedBatchAt: publishedAt,
      publishedAt,
      sourceCount: 1,
      evidence: [{ publishedAt }],
    },
    {
      now: "2026-07-08T12:00:00.000Z",
      profile: "dynamic",
    },
  );
  const updated = calculateSignalHeat(
    {
      score: 86,
      feedBatchAt: "2026-07-08T11:30:00.000Z",
      publishedAt,
      sourceCount: 2,
      evidence: [
        { publishedAt },
        { publishedAt: "2026-07-08T11:30:00.000Z" },
      ],
      updates: [{ addedAt: "2026-07-08T11:30:00.000Z" }],
    },
    {
      now: "2026-07-08T12:00:00.000Z",
      profile: "dynamic",
    },
  );

  assert.ok(updated.score > stale.score);
  assert.equal(updated.visible, true);
});

test("material macro events and Explore theses decay more slowly", () => {
  const base = {
    score: 90,
    feedBatchAt: publishedAt,
    publishedAt,
    sourceCount: 2,
    sources: ["Fed", "Blog"],
    evidence: [{ publishedAt }, { publishedAt }],
  };
  const ordinary = calculateSignalHeat(
    { ...base, category: "AI 工具" },
    {
      now: "2026-07-06T12:00:00.000Z",
      profile: "dynamic",
    },
  );
  const macro = calculateSignalHeat(
    { ...base, category: "宏观与美联储" },
    {
      now: "2026-07-06T12:00:00.000Z",
      profile: "dynamic",
    },
  );
  const explore = calculateSignalHeat(base, {
    now: "2026-07-06T12:00:00.000Z",
    profile: "explore",
  });

  assert.ok(macro.halfLifeHours > ordinary.halfLifeHours);
  assert.ok(macro.score > ordinary.score);
  assert.ok(explore.score > macro.score);
});

test("heat ordering is independent from collection size", () => {
  const hot = calculateSignalHeat(
    { score: 95, feedBatchAt: "2026-07-10T11:00:00.000Z" },
    { now: "2026-07-10T12:00:00.000Z", profile: "dynamic" },
  );
  const cooling = calculateSignalHeat(
    { score: 70, feedBatchAt: "2026-07-08T12:00:00.000Z" },
    { now: "2026-07-10T12:00:00.000Z", profile: "dynamic" },
  );

  assert.ok(compareSignalHeat(hot, cooling) < 0);
  assert.deepEqual(
    [cooling, hot].sort(compareSignalHeat).map((item) => item.score),
    [hot.score, cooling.score],
  );
});

test("editorial value outranks recency heat", () => {
  const highValue = {
    score: 95,
    heat: calculateSignalHeat(
      { score: 95, feedBatchAt: "2026-07-08T12:00:00.000Z" },
      { now: "2026-07-10T12:00:00.000Z", profile: "dynamic" },
    ),
  };
  const merelyNew = {
    score: 83,
    heat: calculateSignalHeat(
      { score: 83, feedBatchAt: "2026-07-10T11:55:00.000Z" },
      { now: "2026-07-10T12:00:00.000Z", profile: "dynamic" },
    ),
  };

  assert.ok(merelyNew.heat.score > highValue.heat.score);
  assert.deepEqual(
    [merelyNew, highValue]
      .sort(compareEditorialValue)
      .map((item) => item.score),
    [95, 83],
  );
});

test("Explore freshness surfaces strong new theses without displacing major old ones", () => {
  const now = "2026-07-10T12:00:00.000Z";
  const majorOld = {
    valueScore: 92,
    heat: calculateSignalHeat(
      { valueScore: 92, feedBatchAt: "2026-07-01T12:00:00.000Z" },
      { now, profile: "explore" },
    ),
  };
  const strongOld = {
    valueScore: 88,
    heat: calculateSignalHeat(
      { valueScore: 88, feedBatchAt: "2026-07-01T12:00:00.000Z" },
      { now, profile: "explore" },
    ),
  };
  const strongNew = {
    valueScore: 84,
    heat: calculateSignalHeat(
      { valueScore: 84, feedBatchAt: "2026-07-10T10:00:00.000Z" },
      { now, profile: "explore" },
    ),
  };
  const merelyNew = {
    valueScore: 80,
    heat: calculateSignalHeat(
      { valueScore: 80, feedBatchAt: "2026-07-10T10:00:00.000Z" },
      { now, profile: "explore" },
    ),
  };

  assert.deepEqual(
    [merelyNew, strongOld, strongNew, majorOld]
      .sort(compareExploreEditorialValue)
      .map((item) => item.valueScore),
    [92, 84, 88, 80],
  );
});

test("system exposure freshness continuously decays after a two-hour window", () => {
  const now = "2026-07-10T12:00:00.000Z";
  const oldImportant = {
    score: 95,
    heat: calculateSignalHeat(
      { score: 95, feedBatchAt: "2026-07-03T12:00:00.000Z" },
      { now, profile: "dynamic" },
    ),
  };
  const newStrong = {
    score: 83,
    heat: calculateSignalHeat(
      { score: 83, feedBatchAt: "2026-07-10T11:30:00.000Z" },
      { now, profile: "dynamic" },
    ),
  };
  assert.deepEqual(
    [oldImportant, newStrong]
      .sort(compareExposureEditorialValue)
      .map((item) => item.score),
    [83, 95],
  );
  assert.ok(
    exposureEditorialScore(newStrong) >
      exposureEditorialScore(oldImportant),
  );

  const outsideWindow = {
    score: 86,
    heat: calculateSignalHeat(
      { score: 86, feedBatchAt: "2026-07-08T10:59:00.000Z" },
      { now, profile: "dynamic" },
    ),
  };
  assert.ok(outsideWindow.heat.ageHours > 48);
  assert.equal(exposureDecayPenalty(2), 0);
  assert.equal(exposureDecayPenalty(3), 1.5);
  assert.equal(exposureDecayPenalty(8), 9);
  assert.equal(exposureDecayPenalty(24), 33);
  assert.equal(exposureDecayPenalty(outsideWindow.heat.ageHours), 40);
  assert.equal(
    exposureEditorialScore(outsideWindow),
    46,
  );
});

test("formats the live system exposure age instead of stale copy", () => {
  assert.equal(formatExposureAge(0.1, "zh"), "刚刚");
  assert.equal(formatExposureAge(0.5, "zh"), "30 分钟前");
  assert.equal(formatExposureAge(22.8, "zh"), "22 小时前");
  assert.equal(formatExposureAge(25, "zh"), "1 天前");
  assert.equal(formatExposureAge(22.8, "en"), "22h ago");
});

test("conversations use a slower weekly exposure rhythm", () => {
  const now = "2026-07-10T12:00:00.000Z";
  const newConversation = {
    valueScore: 84,
    heat: calculateSignalHeat(
      { valueScore: 84, feedBatchAt: "2026-07-10T11:00:00.000Z" },
      { now, profile: "conversation" },
    ),
  };
  const oldConversation = {
    valueScore: 94,
    heat: calculateSignalHeat(
      { valueScore: 94, feedBatchAt: "2026-07-03T12:00:00.000Z" },
      { now, profile: "conversation" },
    ),
  };

  assert.equal(conversationExposureDecayPenalty(24), 0);
  assert.equal(conversationExposureDecayPenalty(48), 4);
  assert.equal(conversationExposureDecayPenalty(7 * 24), 24);
  assert.equal(conversationExposureDecayPenalty(30 * 24), 28);
  assert.equal(conversationExposureEditorialScore(newConversation), 84);
  assert.equal(conversationExposureEditorialScore(oldConversation), 70);
  assert.deepEqual(
    [oldConversation, newConversation]
      .sort(compareConversationEditorialValue)
      .map((item) => item.valueScore),
    [84, 94],
  );
});

test("Explore leaves the page after 72 hours while conversations remain", () => {
  const now = "2026-07-10T12:00:00.000Z";
  const input = {
    valueScore: 92,
    feedBatchAt: "2026-07-07T11:59:00.000Z",
  };

  const explore = calculateSignalHeat(input, {
    now,
    profile: "explore",
  });
  const conversation = calculateSignalHeat(input, {
    now,
    profile: "conversation",
  });

  assert.equal(EXPLORE_FEED_MAX_EXPOSURE_HOURS, 72);
  assert.ok(explore.ageHours > 72);
  assert.equal(explore.visible, false);
  assert.equal(conversation.visible, true);
});

test("Explore never pads the page with expired inventory", () => {
  const fresh = {
    id: "fresh-explore",
    valueScore: 82,
    heat: {
      score: 70,
      stage: "hot",
      visible: true,
      ageHours: 12,
      halfLifeHours: 100,
      lastActivityAt: "2026-07-10T00:00:00.000Z",
    },
  };
  const expired = {
    id: "expired-explore",
    valueScore: 99,
    heat: {
      score: 80,
      stage: "hot",
      visible: false,
      ageHours: 73,
      halfLifeHours: 100,
      lastActivityAt: "2026-07-07T11:00:00.000Z",
    },
  };

  assert.deepEqual(
    selectAdaptiveFeedItems([expired, fresh], "explore").map(
      (item) => item.id,
    ),
    ["fresh-explore"],
  );
  assert.equal(ADAPTIVE_FEED_POLICIES.explore.minimumItems, 1);
  assert.deepEqual(
    ADAPTIVE_FEED_POLICIES.explore.exposureWindowsHours,
    [72],
  );
});

test("adaptive inventory backfills without lowering quality or outranking fresh items", () => {
  const fresh = Array.from({ length: 6 }, (_, index) => ({
    id: `fresh-${index}`,
    valueScore: 82 + index,
    heat: {
      score: 70,
      stage: "hot",
      visible: true,
      ageHours: index + 1,
      halfLifeHours: 100,
      lastActivityAt: "2026-07-10T11:00:00.000Z",
    },
  }));
  const expired = Array.from({ length: 8 }, (_, index) => ({
    id: `expired-${index}`,
    valueScore: 99 - index,
    heat: {
      score: 68,
      stage: "warm",
      visible: false,
      ageHours: 49 + index,
      halfLifeHours: 100,
      lastActivityAt: "2026-07-08T11:00:00.000Z",
    },
  }));

  const selected = selectAdaptiveFeedItems(
    [...expired].reverse().concat([...fresh].reverse()),
    "dynamic",
  );

  assert.equal(ADAPTIVE_FEED_POLICIES.dynamic.minimumItems, 10);
  assert.equal(selected.length, 10);
  assert.deepEqual(
    selected.slice(0, fresh.length).map((item) => item.id),
    [...fresh]
      .sort(compareExposureEditorialValue)
      .map((item) => item.id),
  );
  const selectedBackfill = selected.slice(fresh.length);
  assert.ok(selectedBackfill.every((item) => item.heat.ageHours > 48));
  assert.deepEqual(
    selectedBackfill.map((item) => item.valueScore),
    [...selectedBackfill]
      .map((item) => item.valueScore)
      .sort((left, right) => right - left),
  );
});

test("a system-published update restarts the exposure decay clock", () => {
  const now = "2026-07-10T12:00:00.000Z";
  const updated = {
    score: 84,
    heat: calculateSignalHeat(
      {
        score: 84,
        feedBatchAt: "2026-07-10T11:00:00.000Z",
        updatedAt: "2026-07-10T11:00:00.000Z",
      },
      { now, profile: "dynamic" },
    ),
  };
  const stale = {
    score: 90,
    heat: calculateSignalHeat(
      { score: 90, feedBatchAt: "2026-07-01T10:00:00.000Z" },
      { now, profile: "dynamic" },
    ),
  };

  assert.ok(updated.heat.ageHours <= 1);
  assert.deepEqual(
    [stale, updated]
      .sort(compareExposureEditorialValue)
      .map((item) => item.score),
    [84, 90],
  );
});
