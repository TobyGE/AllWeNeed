import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assertApprovedModelUsage,
  assertApprovedProductionModel,
  modelRoutes,
  writingModelsForItems,
} from "../scripts/model-routing.mjs";

test("routes each workload to the intended GPT-5.6 tier", () => {
  assert.deepEqual([...modelRoutes.fullAnalysis], [
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.6-sol",
  ]);
  assert.deepEqual([...modelRoutes.standardWriting], [
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.6-sol",
  ]);
  assert.deepEqual([...modelRoutes.criticalWriting], [
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.6-sol",
  ]);
  assert.deepEqual([...modelRoutes.grounding], [
    "gpt-5.6-luna",
    "gpt-5.6-terra",
    "gpt-5.6-sol",
  ]);
  assert.deepEqual([...modelRoutes.research], [
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.6-sol",
  ]);
  assert.deepEqual([...modelRoutes.sourceDiscovery], [
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.6-sol",
  ]);
  assert.deepEqual([...modelRoutes.localization], [
    "gpt-5.6-luna",
    "gpt-5.6-terra",
    "gpt-5.6-sol",
  ]);
  assert.deepEqual([...modelRoutes.live], [
    "gpt-5.6-luna",
    "gpt-5.6-terra",
    "gpt-5.6-sol",
  ]);
});

test("rejects obsolete or unreported production model usage", () => {
  assert.doesNotThrow(() =>
    assertApprovedModelUsage({
      model: "gpt-5.6-luna",
      groundingModel: "gpt-5.6-luna, gpt-5.6-terra",
    }),
  );
  assert.throws(
    () => assertApprovedProductionModel("gpt-5.5"),
    /not an approved production model/,
  );
  assert.throws(
    () => assertApprovedModelUsage({ model: "gpt-5.5" }),
    /not an approved production model/,
  );
  assert.throws(
    () => assertApprovedModelUsage({ model: "legacy-default" }),
    /does not identify a production model/,
  );
});

test("uses Terra for both fast-lane and ordinary writing", () => {
  const laneForItem = (item) => item.lane;
  assert.equal(
    writingModelsForItems([{ lane: "fast" }], laneForItem)[0],
    "gpt-5.6-terra",
  );
  assert.equal(
    writingModelsForItems(
      [{ lane: "standard" }, { lane: "explore" }],
      laneForItem,
    )[0],
    "gpt-5.6-terra",
  );
});

test("reserves Sol for routed fallback instead of shadow evaluation", async () => {
  const appendFeedScript = await readFile(
    new URL("../scripts/append-feed-updates.mjs", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(appendFeedScript, /gpt-5\.6-sol/);
});
