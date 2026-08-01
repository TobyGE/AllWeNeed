import { spawnSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const planPath = resolve(projectRoot, "tmp/feed-update-plan.json");
const scheduleStatePath = resolve(projectRoot, "tmp/feed-schedule-state.json");

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
      argument !== "--reuse-snapshot",
  );
}

run("npm", ["run", "poll:feed"]);
const plan = JSON.parse(await readFile(planPath, "utf8"));
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
  ...forwardedArguments(),
]);

let scheduleState = { laneProcessedAt: {} };
try {
  scheduleState = JSON.parse(await readFile(scheduleStatePath, "utf8"));
} catch {
  // First smart cycle starts an empty schedule.
}
scheduleState.lastFullCycleAt = plan.plannedAt;
scheduleState.laneProcessedAt = {
  ...(scheduleState.laneProcessedAt ?? {}),
  ...Object.fromEntries(plan.dueLanes.map((lane) => [lane, plan.plannedAt])),
};
await mkdir(dirname(scheduleStatePath), { recursive: true });
await writeFile(
  scheduleStatePath,
  `${JSON.stringify(scheduleState, null, 2)}\n`,
  "utf8",
);
