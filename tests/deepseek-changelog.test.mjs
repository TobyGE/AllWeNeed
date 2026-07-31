import assert from "node:assert/strict";
import test from "node:test";

import {
  parseDatedChangelogHtml,
  parseSpaceXUpdatesJson,
} from "../scripts/fetch-sources.mjs";
import {
  nextState,
  selectIncrementalItems,
} from "../scripts/append-feed-updates.mjs";
import {
  publicSourceCatalog,
  sourceCatalog,
} from "../app/source-catalog.ts";

const source = {
  id: 205,
  name: "DeepSeek API Changelog",
  publisher: "DeepSeek",
  url: "https://api-docs.deepseek.com/updates/",
  feedUrl: "https://api-docs.deepseek.com/updates/",
  feedFormat: "dated-changelog-html",
};

const julyRelease = `
  <h2 id="date-2026-07-31">Date: 2026-07-31<a href="#date-2026-07-31">#</a></h2>
  <h3 id="deepseek-v4-flash-update">DeepSeek-V4-Flash Update</h3>
  <p>The official release of the DeepSeek-V4-Flash API is now in public beta.</p>
  <p>The official V4-Flash natively supports the Responses API format and is specifically adapted for Codex.</p>
`;

test("turns each dated changelog section into a versioned source item", () => {
  const items = parseDatedChangelogHtml(
    `${julyRelease}
     <h2 id="date-2026-04-24">Date: 2026-04-24</h2>
     <h3>DeepSeek-V4 Preview</h3>
     <p>Preview release.</p>`,
    source,
    source.feedUrl,
  );

  assert.equal(items.length, 2);
  assert.equal(items[0].title, "DeepSeek-V4-Flash Update");
  assert.equal(
    items[0].url,
    "https://api-docs.deepseek.com/updates/#date-2026-07-31",
  );
  assert.equal(items[0].publishedAt, "2026-07-31T00:00:00.000Z");
  assert.equal(items[0].dateOnly, true);
  assert.match(items[0].summary, /Responses API/);
  assert.match(
    items[0].versionKey,
    /^changelog:v2:205:2026-07-31:[a-f0-9]{16}$/,
  );
});

test("selects a changed version once without changing its public URL", () => {
  const [firstVersion] = parseDatedChangelogHtml(
    julyRelease,
    source,
    source.feedUrl,
  );
  const [changedVersion] = parseDatedChangelogHtml(
    `${julyRelease}<p>Terminal Bench 2.1: 82.7.</p>`,
    source,
    source.feedUrl,
  );
  assert.equal(firstVersion.url, changedVersion.url);
  assert.notEqual(firstVersion.versionKey, changedVersion.versionKey);

  const previousSnapshot = {
    generatedAt: "2026-07-31T08:00:00.000Z",
    items: [firstVersion],
  };
  const scannedSnapshot = {
    generatedAt: "2026-07-31T09:00:00.000Z",
    statuses: [{ sourceId: 205, status: "ok" }],
    items: [changedVersion],
  };
  const state = {
    lastScanAt: "2026-07-31T08:00:00.000Z",
    windowStartAt: "2026-07-31T08:00:00.000Z",
    initializedSourceIds: ["205"],
    processedUrls: [firstVersion.url],
    processedKeys: [firstVersion.versionKey],
  };

  const candidates = selectIncrementalItems({
    scannedSnapshot,
    previousSnapshot,
    state,
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].versionKey, changedVersion.versionKey);

  const updatedState = nextState({
    state,
    previousSnapshot,
    candidates,
    scannedSnapshot,
  });
  assert.ok(updatedState.processedKeys.includes(changedVersion.versionKey));
  assert.equal(
    selectIncrementalItems({
      scannedSnapshot,
      previousSnapshot,
      state: updatedState,
    }).length,
    0,
  );
});

test("parses the official SpaceX updates API into citeable source items", () => {
  const [item] = parseSpaceXUpdatesJson(
    JSON.stringify([
      {
        id: 215,
        updateId: "moon-and-beyond",
        date: "2025-10-30",
        title: "To the Moon and Beyond",
        contentBlocks: [
          {
            heading: "Starship",
            paragraph:
              "Starship is designed to establish a permanent human presence beyond Earth.",
          },
        ],
      },
    ]),
    {
      id: 220,
      name: "SpaceX Updates",
      publisher: "SpaceX",
      url: "https://www.spacex.com/updates",
    },
  );

  assert.equal(item.title, "To the Moon and Beyond");
  assert.equal(
    item.url,
    "https://www.spacex.com/updates/moon-and-beyond",
  );
  assert.equal(item.publishedAt, "2025-10-30T00:00:00.000Z");
  assert.match(item.summary, /permanent human presence/);
});

test("keeps discovery-only headline feeds out of the public source directory", () => {
  const nikkei = sourceCatalog.find((item) => item.id === 221);
  assert.equal(nikkei?.discoveryOnly, true);
  assert.equal(publicSourceCatalog.some((item) => item.id === 221), false);
});
