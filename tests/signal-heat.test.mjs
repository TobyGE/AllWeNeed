import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateSignalHeat,
  compareEditorialValue,
  compareSignalHeat,
} from "../app/signal-heat.ts";

const publishedAt = "2026-07-01T12:00:00.000Z";

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

test("new evidence reheats an existing event", () => {
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
      feedBatchAt: publishedAt,
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
