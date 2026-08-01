import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  rankIncrementalItems,
} from "./append-feed-updates.mjs";
import { buildUpdatePlan } from "./update-policy.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const snapshotPath = resolve(
  projectRoot,
  process.argv
    .find((argument) => argument.startsWith("--snapshot="))
    ?.split("=", 2)[1] ?? "tmp/feed-snapshot.json",
);
const previousSnapshotPath = resolve(projectRoot, "data/feed-snapshot.json");
const incrementalStatePath = resolve(projectRoot, "data/incremental-state.json");
const scheduleStatePath = resolve(projectRoot, "tmp/feed-schedule-state.json");
const reportPath = resolve(projectRoot, "tmp/feed-update-plan.json");

async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

const [scannedSnapshot, previousSnapshot, state, scheduleState] =
  await Promise.all([
    readJson(snapshotPath),
    readJson(previousSnapshotPath, { generatedAt: null, items: [] }),
    readJson(incrementalStatePath, null),
    readJson(scheduleStatePath, null),
  ]);
if (!scannedSnapshot) throw new Error(`Missing snapshot at ${snapshotPath}`);

const candidates = rankIncrementalItems({
  scannedSnapshot,
  previousSnapshot,
  state,
});
const plan = buildUpdatePlan({
  candidates,
  now: scannedSnapshot.generatedAt,
  scheduleState,
  fallbackLastCycleAt:
    state?.lastScanAt ?? previousSnapshot.generatedAt ?? null,
});
const report = {
  ...plan,
  scannedAt: scannedSnapshot.generatedAt,
  successfulSources: scannedSnapshot.successfulSources,
  failedSources: scannedSnapshot.failedSources,
  needsAuthSources: scannedSnapshot.needsAuthSources,
};

await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));

