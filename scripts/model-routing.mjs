function modelChain(...models) {
  return Object.freeze(
    models.filter(
      (model, index, values) =>
        model &&
        approvedProductionModels.has(model) &&
        values.indexOf(model) === index,
    ),
  );
}

export const approvedProductionModels = new Set([
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
]);

export const modelRoutes = Object.freeze({
  fullAnalysis: modelChain(
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.6-sol",
  ),
  standardWriting: modelChain(
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.6-sol",
  ),
  criticalWriting: modelChain(
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.6-sol",
  ),
  grounding: modelChain(
    "gpt-5.6-luna",
    "gpt-5.6-terra",
    "gpt-5.6-sol",
  ),
  research: modelChain(
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.6-sol",
  ),
  sourceDiscovery: modelChain(
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.6-sol",
  ),
  localization: modelChain(
    "gpt-5.6-luna",
    "gpt-5.6-terra",
    "gpt-5.6-sol",
  ),
  live: modelChain(
    "gpt-5.6-luna",
    "gpt-5.6-terra",
    "gpt-5.6-sol",
  ),
});

export function assertApprovedProductionModel(model, label = "model") {
  if (!approvedProductionModels.has(model)) {
    throw new Error(`${label} is not an approved production model: ${model}`);
  }
  return model;
}

export function assertApprovedModelUsage(result) {
  const fields = [
    "model",
    "conversationModel",
    "groundingModel",
    "editorialResearchModel",
    "localizationModel",
  ];
  for (const field of fields) {
    const value = result?.[field];
    if (!value) continue;
    const models = String(value).match(/\bgpt-[\w.-]+\b/gu) ?? [];
    if (!models.length) {
      throw new Error(`${field} does not identify a production model: ${value}`);
    }
    for (const model of models) {
      assertApprovedProductionModel(model, field);
    }
  }
  return true;
}

export function writingModelsForItems(items, laneForItem) {
  return items.some((item) => laneForItem(item) === "fast")
    ? modelRoutes.criticalWriting
    : modelRoutes.standardWriting;
}
