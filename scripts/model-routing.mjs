function modelChain(...models) {
  return Object.freeze(
    models.filter(
      (model, index, values) =>
        model && values.indexOf(model) === index,
    ),
  );
}

export const modelRoutes = Object.freeze({
  fullAnalysis: modelChain(
    process.env.SIGNAL_RADAR_ANALYSIS_MODEL?.trim(),
    "gpt-5.6-terra",
    "gpt-5.6-sol",
    "gpt-5.5",
  ),
  standardWriting: modelChain(
    process.env.SIGNAL_RADAR_WRITING_MODEL?.trim(),
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    process.env.SIGNAL_RADAR_MODEL?.trim(),
    "gpt-5.6-sol",
    "gpt-5.5",
  ),
  criticalWriting: modelChain(
    process.env.SIGNAL_RADAR_CRITICAL_MODEL?.trim(),
    "gpt-5.6-terra",
    "gpt-5.6-sol",
    "gpt-5.6-luna",
    "gpt-5.5",
  ),
  grounding: modelChain(
    process.env.SIGNAL_RADAR_GROUNDING_MODEL?.trim(),
    "gpt-5.6-luna",
    "gpt-5.6-terra",
    "gpt-5.6-sol",
    "gpt-5.5",
  ),
  research: modelChain(
    process.env.SIGNAL_RADAR_RESEARCH_MODEL?.trim(),
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.6-sol",
    "gpt-5.5",
  ),
  sourceDiscovery: modelChain(
    process.env.SIGNAL_RADAR_SOURCE_SCOUT_MODEL?.trim(),
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.6-sol",
    "gpt-5.5",
  ),
  localization: modelChain(
    process.env.SIGNAL_RADAR_LOCALIZATION_MODEL?.trim(),
    "gpt-5.6-luna",
    "gpt-5.6-terra",
    "gpt-5.6-sol",
    "gpt-5.5",
  ),
});

export function writingModelsForItems(items, laneForItem) {
  return items.some((item) => laneForItem(item) === "fast")
    ? modelRoutes.criticalWriting
    : modelRoutes.standardWriting;
}
