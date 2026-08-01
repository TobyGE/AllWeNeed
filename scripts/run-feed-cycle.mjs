import { spawnSync } from "node:child_process";
import {
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultHomepageRepo =
  process.env.RADAR_HOMEPAGE_REPO ??
  "/Users/yingqiang/yingqiangge.github.io";
const lockPath = resolve(projectRoot, "tmp/feed-cycle.lock");
const reportPath = resolve(projectRoot, "tmp/feed-cycle-report.json");
const radarPath = resolve(projectRoot, "data/daily-radar.json");
const resultPath = resolve(projectRoot, "tmp/incremental-result.json");
const staticDistPath = resolve(projectRoot, "static-dist");
const publishedUrl = "https://allweneed.info/";
const primaryVerificationUrl = "http://allweneed.info/";
const legacyPublishedUrl = "https://yingqiangge.github.io/intelligence/";
const staleLockMs = 3 * 60 * 60 * 1000;
const generatedDataFiles = [
  "data/daily-radar.json",
  "data/feed-snapshot.json",
  "data/conversations.json",
  "data/event-graph.json",
  "data/model-quality.json",
  "data/control-center.json",
  "data/source-candidates.json",
  "data/discovered-sources.json",
];

function argumentValue(name) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(
    prefix.length,
  );
}

function commandText(command, args) {
  return [command, ...args].join(" ");
}

function runCommand(command, args, { cwd, capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = capture
      ? [result.stdout, result.stderr].filter(Boolean).join("\n").trim()
      : "";
    throw new Error(
      `${commandText(command, args)} failed with exit code ${result.status}${
        detail ? `\n${detail}` : ""
      }`,
    );
  }
  return capture ? result.stdout.trim() : "";
}

function gitOutput(repo, args) {
  return runCommand("git", args, { cwd: repo, capture: true });
}

function gitStatus(repo) {
  const result = spawnSync(
    "git",
    ["status", "--porcelain", "--untracked-files=all"],
    {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Unable to inspect git status in ${repo}`);
  }
  return result.stdout.replace(/\r?\n$/, "");
}

function statusPaths(status) {
  return status
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const value = /^[ MADRCU?!]{2} /.test(line)
        ? line.slice(3)
        : /^[MADRCU?!] /.test(line)
          ? line.slice(2)
          : line;
      const renameTarget = value.includes(" -> ")
        ? value.split(" -> ").at(-1)
        : value;
      return renameTarget.replace(/^"|"$/g, "");
    });
}

function onlyExpectedChanges(status, allowedPrefixes) {
  return statusPaths(status).every((path) =>
    allowedPrefixes.some(
      (prefix) => path === prefix || path.startsWith(`${prefix}/`),
    ),
  );
}

export function assertOnlyExpectedChanges(status, allowedPrefixes, label) {
  const unexpected = statusPaths(status).filter(
    (path) =>
      !allowedPrefixes.some(
        (prefix) => path === prefix || path.startsWith(`${prefix}/`),
      ),
  );
  if (unexpected.length) {
    throw new Error(
      `${label} contains unexpected changes: ${unexpected.join(", ")}`,
    );
  }
}

export function shouldAutoResume({
  radarStatus,
  homepageStatus,
  result,
}) {
  if (!radarStatus || !result) return false;
  if (
    !onlyExpectedChanges(radarStatus, generatedDataFiles)
  ) {
    return false;
  }
  if (!onlyExpectedChanges(homepageStatus, ["intelligence"])) return false;
  return publicationDecision(result);
}

function assertClean(repo, label) {
  const status = gitStatus(repo);
  if (status) {
    throw new Error(`${label} is not clean:\n${status}`);
  }
}

function assertBranch(repo, expected, label) {
  const branch = gitOutput(repo, ["branch", "--show-current"]);
  if (branch !== expected) {
    throw new Error(`${label} must be on ${expected}; found ${branch || "detached"}`);
  }
}

function assertSyncedWithRemote(repo, branch, label) {
  runCommand("git", ["fetch", "--quiet", "origin", branch], { cwd: repo });
  const local = gitOutput(repo, ["rev-parse", "HEAD"]);
  const remote = gitOutput(repo, ["rev-parse", `origin/${branch}`]);
  if (local !== remote) {
    throw new Error(
      `${label} is not synchronized with origin/${branch}; refusing to publish`,
    );
  }
}

function localizedArticleById(radar, locale) {
  const localizedSignals = radar.translations?.[locale]?.signals ?? [];
  return new Map(
    (radar.signals ?? []).map((signal, index) => [
      String(signal.id),
      localizedSignals[index]?.article ?? null,
    ]),
  );
}

export function articleSnapshot(radar) {
  const zh = localizedArticleById(radar, "zh");
  const en = localizedArticleById(radar, "en");
  return new Map(
    (radar.signals ?? []).map((signal) => [
      String(signal.id),
      {
        article: signal.article ?? null,
        zh: zh.get(String(signal.id)) ?? null,
        en: en.get(String(signal.id)) ?? null,
      },
    ]),
  );
}

export function assertExistingArticlesPreserved(before, after) {
  const afterSnapshot = articleSnapshot(after);
  for (const [id, previous] of articleSnapshot(before)) {
    const current = afterSnapshot.get(id);
    if (!current) throw new Error(`Existing signal ${id} was removed`);
    if (JSON.stringify(previous) !== JSON.stringify(current)) {
      throw new Error(`Existing article ${id} was rewritten`);
    }
  }
}

export function publicationDecision(result) {
  const changedCount =
    Number(result.feedStoryCount ?? 0) +
    Number(result.updatedStoryCount ?? 0) +
    Number(result.conversationCount ?? 0);
  if (Boolean(result.publishRequired) !== (changedCount > 0)) {
    throw new Error(
      `Invalid incremental result: publishRequired=${result.publishRequired}, changedCount=${changedCount}`,
    );
  }
  return changedCount > 0;
}

export function parseAssetPaths(indexHtml) {
  return [
    ...new Set(
      [...indexHtml.matchAll(/assets\/[^"'?\s>]+\.(?:js|css)/g)].map(
        (match) => match[0],
      ),
    ),
  ];
}

export function assertReusableSnapshot(
  snapshot,
  now = Date.now(),
  maxAgeMs = 15 * 60 * 1_000,
) {
  const generatedAt = Date.parse(snapshot?.generatedAt ?? "");
  if (!Number.isFinite(generatedAt)) {
    throw new Error("Reusable snapshot has no valid generatedAt");
  }
  const ageMs = now - generatedAt;
  if (ageMs < -5 * 60 * 1_000 || ageMs > maxAgeMs) {
    throw new Error(
      `Reusable snapshot is stale or future-dated: ${snapshot.generatedAt}`,
    );
  }
  if (
    !Number.isFinite(Number(snapshot?.successfulSources)) ||
    !Array.isArray(snapshot?.items)
  ) {
    throw new Error("Reusable snapshot is incomplete");
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeReport(value) {
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function acquireLock() {
  await mkdir(dirname(lockPath), { recursive: true });
  try {
    await mkdir(lockPath, { recursive: false });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const lockStat = await stat(lockPath);
    if (Date.now() - lockStat.mtimeMs < staleLockMs) {
      throw new Error("Another All We Need feed cycle is already running");
    }
    await rm(lockPath, { recursive: true, force: true });
    await mkdir(lockPath, { recursive: false });
  }
  await writeFile(
    resolve(lockPath, "owner.json"),
    `${JSON.stringify(
      { pid: process.pid, startedAt: new Date().toISOString() },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function commit(repo, paths, message) {
  runCommand("git", ["add", "--", ...paths], { cwd: repo });
  const staged = spawnSync("git", ["diff", "--cached", "--quiet"], {
    cwd: repo,
    stdio: "ignore",
  });
  if (staged.status === 0) {
    throw new Error(`No staged changes in ${repo} despite publishRequired=true`);
  }
  if (staged.status !== 1) {
    throw new Error(`Unable to inspect staged changes in ${repo}`);
  }
  runCommand("git", ["commit", "-m", message], { cwd: repo });
  return gitOutput(repo, ["rev-parse", "--short", "HEAD"]);
}

function push(repo, branch) {
  const first = spawnSync("git", ["push", "origin", branch], {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (first.status === 0) {
    process.stdout.write(first.stdout);
    process.stderr.write(first.stderr);
    return;
  }
  const combined = `${first.stdout ?? ""}\n${first.stderr ?? ""}`;
  if (!/HTTP 400/i.test(combined)) {
    throw new Error(`git push origin ${branch} failed\n${combined.trim()}`);
  }
  runCommand(
    "git",
    [
      "-c",
      "http.version=HTTP/1.1",
      "-c",
      "http.postBuffer=524288000",
      "push",
      "origin",
      branch,
    ],
    { cwd: repo },
  );
}

async function verifyPages(expectedAssets, commit, pageUrl) {
  const attempts = 12;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const pageResponse = await fetch(
        `${pageUrl}?feed-cycle=${encodeURIComponent(commit)}-${attempt}`,
        { cache: "no-store" },
      );
      const html = await pageResponse.text();
      const pageReady =
        pageResponse.ok && expectedAssets.every((asset) => html.includes(asset));
      if (pageReady) {
        const assetResponses = await Promise.all(
          expectedAssets.map((asset) =>
            fetch(new URL(asset, pageUrl), { cache: "no-store" }),
          ),
        );
        if (assetResponses.every((response) => response.ok)) {
          return { url: pageUrl, attempts: attempt, assets: expectedAssets };
        }
      }
    } catch {
      // GitHub Pages may briefly return the previous deployment.
    }
    if (attempt < attempts) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10_000));
    }
  }
  throw new Error(
    `GitHub Pages at ${pageUrl} did not expose ${expectedAssets.join(", ")} within ${
      attempts * 10
    } seconds`,
  );
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const resume = process.argv.includes("--resume");
  const skipRemoteCheck = process.argv.includes("--skip-remote-check");
  const reuseSnapshot = process.argv.includes("--reuse-snapshot");
  const requestedLanes = argumentValue("lanes");
  const homepageRepo = resolve(argumentValue("homepage") ?? defaultHomepageRepo);
  const startedAt = new Date().toISOString();
  let recoveredBatch = null;
  if (dryRun && resume) {
    throw new Error("--dry-run and --resume cannot be used together");
  }

  if (!dryRun && !resume) {
    let pendingResult = null;
    try {
      pendingResult = await readJson(resultPath);
    } catch {
      // A missing result means there is no analyzed batch to recover.
    }
    if (
      shouldAutoResume({
        radarStatus: gitStatus(projectRoot),
        homepageStatus: gitStatus(homepageRepo),
        result: pendingResult,
      })
    ) {
      console.log(
        "Recovering the previously analyzed batch before scanning for newer URLs...",
      );
      const resumeArgs = [
        invokedPath,
        "--resume",
        `--homepage=${homepageRepo}`,
      ];
      if (skipRemoteCheck) resumeArgs.push("--skip-remote-check");
      runCommand(process.execPath, resumeArgs, { cwd: projectRoot });
      const recoveryReport = await readJson(reportPath);
      recoveredBatch = {
        status: recoveryReport.status,
        scannedAt: recoveryReport.scannedAt,
        radarCommit: recoveryReport.radarCommit,
        homepageCommit: recoveryReport.homepageCommit,
      };
    }
  }

  await acquireLock();

  try {
    assertBranch(projectRoot, "main", "Radar repository");
    assertBranch(homepageRepo, "master", "Homepage repository");
    if (!resume) {
      assertClean(projectRoot, "Radar repository");
      assertClean(homepageRepo, "Homepage repository");
    } else {
      const radarStatus = gitStatus(projectRoot);
      if (!radarStatus) {
        throw new Error("Resume requested, but Radar has no pending data changes");
      }
      assertOnlyExpectedChanges(
        radarStatus,
        generatedDataFiles,
        "Radar repository",
      );
      assertOnlyExpectedChanges(
        gitStatus(homepageRepo),
        ["intelligence"],
        "Homepage repository",
      );
    }
    if (!dryRun && !skipRemoteCheck) {
      assertSyncedWithRemote(projectRoot, "main", "Radar repository");
      assertSyncedWithRemote(homepageRepo, "master", "Homepage repository");
    }

    const before = resume
      ? JSON.parse(
          gitOutput(projectRoot, ["show", "HEAD:data/daily-radar.json"]),
        )
      : await readJson(radarPath);
    if (!resume) {
      const laneArgument = requestedLanes
        ? [`--lanes=${requestedLanes}`]
        : [];
      if (reuseSnapshot) {
        assertReusableSnapshot(
          await readJson(resolve(projectRoot, "tmp/feed-snapshot.json")),
        );
        runCommand(
          process.execPath,
          [
            resolve(projectRoot, "scripts/append-feed-updates.mjs"),
            `--snapshot=${resolve(projectRoot, "tmp/feed-snapshot.json")}`,
            ...(dryRun ? ["--dry-run"] : []),
            ...laneArgument,
          ],
          { cwd: projectRoot },
        );
      } else {
        runCommand(
          "npm",
          [
            "run",
            dryRun ? "refresh:incremental:dry" : "refresh:incremental",
            ...(laneArgument.length ? ["--", ...laneArgument] : []),
          ],
          { cwd: projectRoot },
        );
      }
    }
    const result = await readJson(resultPath);
    const shouldPublish = publicationDecision(result);

    if (resume && !shouldPublish) {
      throw new Error("Resume result does not contain publishable changes");
    }
    if (dryRun || !shouldPublish) {
      assertClean(projectRoot, "Radar repository after no-op scan");
      assertClean(homepageRepo, "Homepage repository after no-op scan");
      const report = {
        status: dryRun ? "dry_run" : "no_changes",
        startedAt,
        finishedAt: new Date().toISOString(),
        ...(recoveredBatch ? { recoveredBatch } : {}),
        ...result,
      };
      await writeReport(report);
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    const after = await readJson(radarPath);
    assertExistingArticlesPreserved(before, after);
    runCommand(
      process.execPath,
      [resolve(projectRoot, "scripts/build-operational-data.mjs")],
      { cwd: projectRoot },
    );
    assertOnlyExpectedChanges(
      gitStatus(projectRoot),
      generatedDataFiles,
      "Radar repository",
    );

    runCommand("npm", ["test"], { cwd: projectRoot });
    runCommand("npm", ["run", "build:static:legacy"], { cwd: projectRoot });
    runCommand(
      "rsync",
      [
        "-a",
        "--delete",
        `${staticDistPath}/`,
        `${resolve(homepageRepo, "intelligence")}/`,
      ],
      { cwd: projectRoot },
    );
    assertOnlyExpectedChanges(
      gitStatus(homepageRepo),
      ["intelligence"],
      "Homepage repository",
    );

    const stamp = new Date(result.scannedAt ?? Date.now())
      .toISOString()
      .replace("T", " ")
      .slice(0, 16);
    const radarCommit = commit(
      projectRoot,
      generatedDataFiles,
      `Update Radar feed ${stamp}`,
    );
    const homepageCommit = commit(
      homepageRepo,
      ["intelligence"],
      `Publish Radar feed ${stamp}`,
    );

    push(projectRoot, "main");
    push(homepageRepo, "master");

    const staticIndex = await readFile(
      resolve(staticDistPath, "index.html"),
      "utf8",
    );
    const expectedAssets = parseAssetPaths(staticIndex);
    if (!expectedAssets.length) {
      throw new Error("Static build did not expose any versioned assets");
    }
    const rootAssets = expectedAssets.map((asset) =>
      asset.replace(/^\/intelligence/, ""),
    );
    const [primaryPages, legacyPages] = await Promise.all([
      verifyPages(rootAssets, radarCommit, primaryVerificationUrl).then(
        (verification) => ({
          ...verification,
          url: publishedUrl,
          verificationUrl: primaryVerificationUrl,
        }),
      ),
      verifyPages(expectedAssets, homepageCommit, legacyPublishedUrl),
    ]);
    const pages = { primary: primaryPages, legacy: legacyPages };
    assertClean(projectRoot, "Radar repository after publish");
    assertClean(homepageRepo, "Homepage repository after publish");

    const report = {
      status: resume ? "resumed_and_published" : "published",
      startedAt,
      finishedAt: new Date().toISOString(),
      radarCommit,
      homepageCommit,
      publishedUrl,
      pages,
      ...(recoveredBatch ? { recoveredBatch } : {}),
      ...result,
    };
    await writeReport(report);
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    const report = {
      status: "failed",
      startedAt,
      finishedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    };
    await writeReport(report);
    throw error;
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
