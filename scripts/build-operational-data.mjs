import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildEventGraph } from "./event-graph.mjs";
import { appendQualityRecord } from "./shadow-evaluation.mjs";
import { sourceCatalog } from "../app/source-catalog.ts";
import {
  mergeSourceScoutCandidates,
  promoteReadySources,
} from "./source-scout-store.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function readJson(relativePath, fallback) {
  try {
    return JSON.parse(
      await readFile(resolve(projectRoot, relativePath), "utf8"),
    );
  } catch {
    return fallback;
  }
}

async function writeJson(relativePath, value) {
  await writeFile(
    resolve(projectRoot, relativePath),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}

const [
  radar,
  conversations,
  snapshot,
  result,
  plan,
  existingQuality,
  existingSourceCandidates,
  discoveredSources,
  sourceScoutResult,
] =
  await Promise.all([
    readJson("data/daily-radar.json", { signals: [] }),
    readJson("data/conversations.json", { items: [] }),
    readJson("data/feed-snapshot.json", { statuses: [] }),
    readJson("tmp/incremental-result.json", {}),
    readJson("tmp/feed-update-plan.json", {}),
    readJson("data/model-quality.json", { schemaVersion: 1, records: [] }),
    readJson("data/source-candidates.json", {
      schemaVersion: 1,
      generatedAt: null,
      candidates: [],
    }),
    readJson("data/discovered-sources.json", {
      schemaVersion: 1,
      updatedAt: null,
      sources: [],
    }),
    readJson("tmp/source-scout-result.json", null),
  ]);

const baselineMode = process.argv.includes("--baseline");
if (!result.publishRequired && !baselineMode) {
  throw new Error("Operational data may only be generated for a publishable run");
}

const generatedAt =
  result.scannedAt ?? snapshot.generatedAt ?? new Date().toISOString();
const eventGraph = buildEventGraph({
  radar,
  conversations,
  generatedAt,
});
let quality = existingQuality;
if (result.shadowEvaluation?.attempted) {
  quality = appendQualityRecord(existingQuality, result.shadowEvaluation);
}
const mergedSourceCandidates = sourceScoutResult?.candidates
  ? mergeSourceScoutCandidates({
      existing: existingSourceCandidates,
      result: sourceScoutResult,
    })
  : existingSourceCandidates;
const sourcePromotion = promoteReadySources({
  candidates: mergedSourceCandidates,
  configuredSources: sourceCatalog,
  discovered: discoveredSources,
  promotedAt: generatedAt,
});

const statusCounts = (snapshot.statuses ?? []).reduce(
  (counts, status) => {
    counts[status.status] = (counts[status.status] ?? 0) + 1;
    return counts;
  },
  {},
);
const controlCenter = {
  schemaVersion: 1,
  generatedAt,
  scan: {
    successfulSources: result.successfulSources ?? 0,
    failedSources: result.failedSources ?? 0,
    needsAuthSources: result.needsAuthSources ?? 0,
    statusCounts,
    candidateCount: plan.candidateCount ?? result.newItemCount ?? 0,
    laneCounts: plan.laneCounts ?? {},
    freshnessExcludedCount: plan.freshnessExcludedCount ?? 0,
    freshnessExcluded: plan.freshnessExcluded ?? [],
  },
  publication: {
    feedStories: result.feedStoryCount ?? 0,
    updatedStories: result.updatedStoryCount ?? 0,
    conversations: result.conversationCount ?? 0,
    ignored: result.ignoredItemCount ?? 0,
    deferred: result.editorialResearchDeferredCount ?? 0,
    addedTitles: result.addedTitles ?? [],
    updatedTitles: result.updatedTitles ?? [],
    deferredTitles: result.deferredTitles ?? [],
  },
  models: {
    editorial: result.model ?? null,
    conversation: result.conversationModel ?? null,
    grounding: result.groundingModel ?? null,
    research: result.editorialResearchModel ?? null,
    shadow: result.shadowEvaluation ?? null,
    recentQuality: quality.records?.slice(-10) ?? [],
  },
  graph: eventGraph.counts,
  revisionQueue: eventGraph.revisionQueue,
  sourceScout: {
    generatedAt: sourcePromotion.candidates.generatedAt ?? null,
    model: sourcePromotion.candidates.model ?? null,
    candidateCount: sourcePromotion.candidates.candidates?.length ?? 0,
    readyCount: sourcePromotion.candidates.candidates?.filter(
      (candidate) => candidate.status === "ready",
    ).length ?? 0,
    reviewCount: sourcePromotion.candidates.candidates?.filter(
      (candidate) => candidate.status === "review",
    ).length ?? 0,
    rejectedCount: sourcePromotion.candidates.candidates?.filter(
      (candidate) => candidate.status === "rejected",
    ).length ?? 0,
    promotedCount: sourcePromotion.candidates.candidates?.filter(
      (candidate) => candidate.status === "promoted",
    ).length ?? 0,
    candidates: sourcePromotion.candidates.candidates?.slice(0, 20) ?? [],
  },
};

await Promise.all([
  writeJson("data/event-graph.json", eventGraph),
  writeJson("data/model-quality.json", quality),
  writeJson("data/control-center.json", controlCenter),
  writeJson("data/source-candidates.json", sourcePromotion.candidates),
  writeJson("data/discovered-sources.json", sourcePromotion.registry),
]);
