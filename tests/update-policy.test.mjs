import assert from "node:assert/strict";
import test from "node:test";
import {
  buildUpdatePlan,
  candidateUpdateLane,
  candidateFreshnessDecision,
  freshnessWindowsHours,
  globalModelCooldownMinutes,
  isFastLaneCandidate,
  updateIntervalsMinutes,
} from "../scripts/update-policy.mjs";

const now = "2026-08-01T12:00:00.000Z";

function item(overrides = {}) {
  return {
    sourceId: 1,
    sourceName: "Example",
    sourcePublisher: "Example",
    sourceKind: "Blog",
    title: "A thoughtful essay",
    summary: "An argument about software",
    url: `https://example.com/${Math.random()}`,
    firstSeenAt: "2026-08-01T11:30:00.000Z",
    publishedAt: "2026-08-01T11:00:00.000Z",
    ...overrides,
  };
}

test("official material events enter the immediate fast lane", () => {
  const release = item({
    sourceName: "OpenAI Blog",
    sourcePublisher: "OpenAI",
    title: "OpenAI releases a new model API with lower pricing",
  });
  assert.equal(isFastLaneCandidate(release, now), true);
  assert.equal(candidateUpdateLane(release, now), "fast");

  const plan = buildUpdatePlan({
    candidates: [release],
    now,
    fallbackLastCycleAt: "2026-08-01T09:55:00.000Z",
  });
  assert.deepEqual(plan.dueLanes, ["fast"]);
  assert.equal(plan.shouldRunFullCycle, true);
});

test("an unofficial opinion never enters fast lane from keywords alone", () => {
  const commentary = item({
    title: "Why a future model launch could change pricing",
  });
  assert.equal(isFastLaneCandidate(commentary), false);
  assert.equal(candidateUpdateLane(commentary), "explore");
});

test("a named frontier model on its official publisher enters fast lane", () => {
  const modelRelease = item({
    sourceName: "OpenAI Blog",
    sourcePublisher: "OpenAI",
    title: "How GPT-5.6 fuses frontier intelligence with efficiency",
  });
  assert.equal(candidateUpdateLane(modelRelease, now), "fast");
});

test("standard events are batched for four hours", () => {
  const update = item({
    title: "Cloud infrastructure changelog update",
    firstSeenAt: "2026-08-01T07:59:00.000Z",
  });
  const plan = buildUpdatePlan({
    candidates: [update],
    now,
    scheduleState: {
      laneProcessedAt: { standard: "2026-08-01T07:30:00.000Z" },
    },
  });
  assert.equal(candidateUpdateLane(update), "standard");
  assert.deepEqual(plan.dueLanes, ["standard"]);
  assert.equal(updateIntervalsMinutes.standard, 240);
});

test("Explore is batched for twelve hours", () => {
  const essay = item();
  const queued = buildUpdatePlan({
    candidates: [essay],
    now,
    scheduleState: {
      laneProcessedAt: { explore: "2026-08-01T10:00:00.000Z" },
    },
  });
  assert.deepEqual(queued.dueLanes, []);
  assert.equal(queued.nextDueAt, "2026-08-01T22:00:00.000Z");

  const due = buildUpdatePlan({
    candidates: [
      item({ firstSeenAt: "2026-07-31T23:59:00.000Z" }),
    ],
    now,
    scheduleState: {
      laneProcessedAt: { explore: "2026-08-01T10:00:00.000Z" },
    },
  });
  assert.deepEqual(due.dueLanes, ["explore"]);
});

test("conversations use a daily lane", () => {
  const conversation = item({
    sourceKind: "Podcast",
    conversationSource: true,
    title: "A long interview with an AI researcher",
  });
  assert.equal(candidateUpdateLane(conversation), "conversation");
  const plan = buildUpdatePlan({
    candidates: [conversation],
    now,
    scheduleState: {
      laneProcessedAt: {
        conversation: "2026-07-31T11:59:00.000Z",
      },
    },
  });
  assert.deepEqual(plan.dueLanes, ["conversation"]);
  assert.equal(updateIntervalsMinutes.conversation, 1_440);
});

test("a global two-hour cooldown prevents adjacent lanes from calling the model", () => {
  const release = item({
    sourceName: "OpenAI Blog",
    sourcePublisher: "OpenAI",
    title: "OpenAI releases a new model API",
  });
  const plan = buildUpdatePlan({
    candidates: [release],
    now,
    scheduleState: {
      lastFullCycleAt: "2026-08-01T11:00:01.000Z",
    },
  });
  assert.equal(globalModelCooldownMinutes, 120);
  assert.deepEqual(plan.dueLanes, []);
  assert.equal(plan.shouldRunFullCycle, false);
  assert.equal(plan.nextDueAt, "2026-08-01T13:00:01.000Z");
  assert.match(plan.reason, /global model cooldown/);
});

test("an empty poll never starts the expensive cycle", () => {
  const plan = buildUpdatePlan({
    candidates: [],
    now,
    fallbackLastCycleAt: "2026-08-01T10:00:00.000Z",
  });
  assert.equal(plan.shouldRunFullCycle, false);
  assert.equal(plan.reason, "No unseen candidates");
});

test("stale official releases are rejected before they can enter fast lane", () => {
  const stale = item({
    sourceName: "OpenAI Blog",
    sourcePublisher: "OpenAI",
    title: "OpenAI releases a model API",
    publishedAt: "2026-07-20T11:00:00.000Z",
  });
  assert.equal(isFastLaneCandidate(stale, now), false);
  const decision = candidateFreshnessDecision(stale, now);
  assert.equal(decision.eligible, false);
  assert.equal(decision.reason, "outside_freshness_window");
  assert.equal(freshnessWindowsHours.standard, 168);
});

test("items without a publisher timestamp do not enter the model queue", () => {
  const undated = item({ publishedAt: null });
  const decision = candidateFreshnessDecision(undated, now);
  assert.equal(decision.eligible, false);
  assert.equal(decision.reason, "missing_publisher_timestamp");
});
