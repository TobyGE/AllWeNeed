import assert from "node:assert/strict";
import test from "node:test";
import {
  modelReasoningEffort,
  modelSearchContextSize,
  modelTaskInstructions,
} from "../scripts/model-prompts.mjs";

test("gives Terra and Luna lean task-specific instructions", () => {
  const terra = modelTaskInstructions({
    model: "gpt-5.6-terra",
    task: "editorial",
    fallbackInstructions: "FULL SOL INSTRUCTIONS",
  });
  const luna = modelTaskInstructions({
    model: "gpt-5.6-luna",
    task: "localization",
    fallbackInstructions: "FULL SOL INSTRUCTIONS",
  });
  assert.match(terra, /central\s+claim/);
  assert.match(terra, /countercase once/);
  assert.doesNotMatch(terra, /FULL SOL INSTRUCTIONS/);
  assert.match(luna, /lossless bilingual rewrite/);
  assert.match(luna, /array order/);
  const scout = modelTaskInstructions({
    model: "gpt-5.6-terra",
    task: "sourceDiscovery",
    fallbackInstructions: "FULL SOL INSTRUCTIONS",
  });
  assert.match(scout, /durable publishers/);
  assert.match(scout, /fetchable RSS/);
  assert.doesNotMatch(scout, /FULL SOL INSTRUCTIONS/);
});

test("preserves Sol effort while using medium-cost 5.6 tiers", () => {
  assert.equal(
    modelReasoningEffort({
      model: "gpt-5.6-terra",
      task: "editorial",
      fallbackEffort: "high",
    }),
    "medium",
  );
  assert.equal(
    modelReasoningEffort({
      model: "gpt-5.6-luna",
      task: "localization",
      fallbackEffort: "medium",
    }),
    "low",
  );
  assert.equal(
    modelReasoningEffort({
      model: "gpt-5.6-sol",
      task: "research",
      fallbackEffort: "high",
    }),
    "high",
  );
  assert.equal(
    modelSearchContextSize({
      model: "gpt-5.6-terra",
      fallbackSize: "high",
    }),
    "medium",
  );
});
