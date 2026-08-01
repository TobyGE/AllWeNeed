import assert from "node:assert/strict";
import test from "node:test";
import {
  articleSnapshot,
  assertExistingArticlesPreserved,
  assertOnlyExpectedChanges,
  assertReusableSnapshot,
  parseAssetPaths,
  publicationDecision,
  shouldAutoResume,
} from "../scripts/run-feed-cycle.mjs";

function radar(ids = ["one", "two"]) {
  return {
    signals: ids.map((id) => ({
      id,
      article: { lead: `${id} base`, sections: [], outlook: `${id} end` },
    })),
    translations: {
      zh: {
        signals: ids.map((id) => ({
          article: { lead: `${id} zh`, sections: [], outlook: `${id} zh end` },
        })),
      },
      en: {
        signals: ids.map((id) => ({
          article: { lead: `${id} en`, sections: [], outlook: `${id} en end` },
        })),
      },
    },
  };
}

test("preserves every old article while allowing new stories and reordering", () => {
  const before = radar();
  const after = radar(["new", "two", "one"]);
  after.signals[0].article = { lead: "new", sections: [], outlook: "new" };
  after.translations.zh.signals[0].article = {
    lead: "new zh",
    sections: [],
    outlook: "new zh",
  };
  after.translations.en.signals[0].article = {
    lead: "new en",
    sections: [],
    outlook: "new en",
  };

  assert.doesNotThrow(() => assertExistingArticlesPreserved(before, after));
  assert.deepEqual([...articleSnapshot(before).keys()], ["one", "two"]);
});

test("reuses only a fresh, complete polling snapshot", () => {
  const now = Date.parse("2026-08-01T12:00:00.000Z");
  assert.doesNotThrow(() =>
    assertReusableSnapshot(
      {
        generatedAt: "2026-08-01T11:55:00.000Z",
        successfulSources: 198,
        items: [],
      },
      now,
    ),
  );
  assert.throws(
    () =>
      assertReusableSnapshot(
        {
          generatedAt: "2026-08-01T11:30:00.000Z",
          successfulSources: 198,
          items: [],
        },
        now,
      ),
    /stale/,
  );
  assert.throws(
    () =>
      assertReusableSnapshot(
        {
          generatedAt: "2026-08-01T11:55:00.000Z",
          items: [],
        },
        now,
      ),
    /incomplete/,
  );
});

test("rejects a rewritten or removed old article", () => {
  const before = radar();
  const rewritten = radar();
  rewritten.translations.zh.signals[0].article.lead = "rewritten";
  assert.throws(
    () => assertExistingArticlesPreserved(before, rewritten),
    /Existing article one was rewritten/,
  );

  const removed = radar(["one"]);
  assert.throws(
    () => assertExistingArticlesPreserved(before, removed),
    /Existing signal two was removed/,
  );
});

test("publishes only when a new story, update, or conversation exists", () => {
  assert.equal(
    publicationDecision({
      publishRequired: false,
      feedStoryCount: 0,
      updatedStoryCount: 0,
    }),
    false,
  );
  assert.equal(
    publicationDecision({
      publishRequired: true,
      feedStoryCount: 2,
      updatedStoryCount: 1,
    }),
    true,
  );
  assert.equal(
    publicationDecision({
      publishRequired: true,
      feedStoryCount: 0,
      updatedStoryCount: 0,
      conversationCount: 1,
    }),
    true,
  );
  assert.throws(
    () =>
      publicationDecision({
        publishRequired: true,
        feedStoryCount: 0,
        updatedStoryCount: 0,
      }),
    /Invalid incremental result/,
  );
});

test("limits publication changes to generated Radar and homepage assets", () => {
  assert.doesNotThrow(() =>
    assertOnlyExpectedChanges(
      " M data/daily-radar.json\n M data/feed-snapshot.json\n M data/conversations.json",
      [
        "data/daily-radar.json",
        "data/feed-snapshot.json",
        "data/conversations.json",
      ],
      "Radar",
    ),
  );
  assert.doesNotThrow(() =>
    assertOnlyExpectedChanges(
      "M data/daily-radar.json\n M data/feed-snapshot.json",
      ["data/daily-radar.json", "data/feed-snapshot.json"],
      "Radar",
    ),
  );
  assert.doesNotThrow(() =>
    assertOnlyExpectedChanges(
      " D intelligence/assets/old.js\n?? intelligence/assets/new.js",
      ["intelligence"],
      "Homepage",
    ),
  );
  assert.throws(
    () =>
      assertOnlyExpectedChanges(
        " M app/page.tsx\n M data/daily-radar.json",
        ["data/daily-radar.json"],
        "Radar",
      ),
    /app\/page\.tsx/,
  );
});

test("extracts the exact versioned assets required for Pages verification", () => {
  assert.deepEqual(
    parseAssetPaths(
      '<link href="/intelligence/assets/index-a.css"><script src="./assets/index-b.js"></script>',
    ),
    ["assets/index-a.css", "assets/index-b.js"],
  );
});

test("auto-resumes only a fully analyzed generated batch", () => {
  const result = {
    publishRequired: true,
    feedStoryCount: 1,
    updatedStoryCount: 0,
  };
  assert.equal(
    shouldAutoResume({
      radarStatus:
        " M data/feed-snapshot.json\n M data/conversations.json",
      homepageStatus:
        " D intelligence/assets/old.js\n?? intelligence/assets/new.js",
      result: {
        publishRequired: true,
        feedStoryCount: 0,
        updatedStoryCount: 0,
        conversationCount: 1,
      },
    }),
    true,
  );
  assert.equal(
    shouldAutoResume({
      radarStatus:
        " M app/page.tsx\n M data/daily-radar.json\n M data/feed-snapshot.json",
      homepageStatus: "",
      result,
    }),
    false,
  );
  assert.equal(
    shouldAutoResume({
      radarStatus:
        " M data/daily-radar.json\n M data/feed-snapshot.json",
      homepageStatus: "",
      result: {
        publishRequired: false,
        feedStoryCount: 0,
        updatedStoryCount: 0,
      },
    }),
    false,
  );
});
