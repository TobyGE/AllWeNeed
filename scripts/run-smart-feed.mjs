import { spawnSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const planPath = resolve(projectRoot, "tmp/feed-update-plan.json");
const scheduleStatePath = resolve(projectRoot, "tmp/feed-schedule-state.json");

async function readScheduleState() {
  try {
    return JSON.parse(await readFile(scheduleStatePath, "utf8"));
  } catch {
    return { laneProcessedAt: {} };
  }
}

async function writeScheduleState(scheduleState) {
  await mkdir(dirname(scheduleStatePath), { recursive: true });
  await writeFile(
    scheduleStatePath,
    `${JSON.stringify(scheduleState, null, 2)}\n`,
    "utf8",
  );
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: "inherit",
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with ${result.status}`);
  }
}

function runOptional(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: "inherit",
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    console.warn(
      `Optional upstream task failed: ${command} ${args.join(" ")}`,
    );
    return false;
  }
  return true;
}

function forwardedArguments() {
  return process.argv.slice(2).filter(
    (argument) =>
      !argument.startsWith("--lanes=") &&
      !argument.startsWith("--snapshot-generated-at=") &&
      argument !== "--reuse-snapshot",
  );
}

run("npm", ["run", "poll:feed"]);
const plan = JSON.parse(await readFile(planPath, "utf8"));
let scheduleState = await readScheduleState();

// Start the global cooldown before the first model task. A failed Live or
// curated cycle is still a complete model attempt and must not be retried by
// every hourly poll. Lane timestamps remain success-only below so candidates
// are queued, not lost, while the cooldown is active.
if (!plan.modelCooldownActive && plan.shouldRunFullCycle) {
  scheduleState.lastFullCycleAt = plan.plannedAt;
  await writeScheduleState(scheduleState);
}

// Live is an independent lightweight publication lane. It asks the Live
// editorial model only about undecided additions to the six-hour window;
// accepted decisions and translations are cached, rejected candidates are
// remembered, and a two-hour Live-model cooldown queues bursts safely.
// Publish it before the curated cycle so fresh wire items do not wait for the
// full analysis cadence. The global cooldown covers every model task,
// including Live localization, so a cooling full cycle must not be bypassed
// through this independent lane.
if (!plan.modelCooldownActive) {
  run("npm", [
    "run",
    "cycle:live",
    "--",
    "--reuse-snapshot",
    `--snapshot-generated-at=${plan.plannedAt}`,
    ...forwardedArguments(),
  ]);
} else {
  console.log("Skipping Live localization during the global model cooldown.");
}

if (!plan.shouldRunFullCycle) {
  runOptional("npm", ["run", "scout:sources:scheduled"]);
  console.log(
    JSON.stringify(
      {
        status: "queued",
        reason: plan.reason,
        nextDueAt: plan.nextDueAt,
        laneCounts: plan.laneCounts,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

run("npm", [
  "run",
  "cycle:feed",
  "--",
  `--lanes=${plan.dueLanes.join(",")}`,
  "--reuse-snapshot",
  `--snapshot-generated-at=${plan.plannedAt}`,
  ...forwardedArguments(),
]);

scheduleState.lastFullCycleAt = plan.plannedAt;
scheduleState.laneProcessedAt = {
  ...(scheduleState.laneProcessedAt ?? {}),
  ...Object.fromEntries(plan.dueLanes.map((lane) => [lane, plan.plannedAt])),
};
await writeScheduleState(scheduleState);
