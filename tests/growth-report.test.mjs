import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildRecommendations,
  ga4DimensionRows,
  ga4Totals,
  percentChange,
  renderGrowthMarkdown,
  searchConsoleRows,
  searchConsoleTotals,
} from "../scripts/refresh-growth-report.mjs";
import {
  resolveSearchConsoleSite,
  searchConsoleStatusFromError,
  SearchConsoleError,
} from "../scripts/search-console.mjs";

test("normalizes GA4 and Search Console reports", () => {
  assert.deepEqual(
    ga4Totals({
      totals: [
        {
          metricValues: [
            { value: "70" },
            { value: "11" },
            { value: "20" },
            { value: "12" },
          ],
        },
      ],
    }),
    {
      pageViews: 70,
      activeUsers: 11,
      sessions: 20,
      engagedSessions: 12,
      engagementRate: 0.6,
    },
  );
  assert.deepEqual(
    ga4DimensionRows(
      {
        rows: [
          {
            dimensionValues: [{ value: "Organic Search" }],
            metricValues: [{ value: "9" }, { value: "4" }],
          },
        ],
      },
      ["channel"],
      ["sessions", "activeUsers"],
    ),
    [{ channel: "Organic Search", sessions: 9, activeUsers: 4 }],
  );
  assert.deepEqual(
    searchConsoleTotals({
      rows: [{ clicks: 5, impressions: 100, ctr: 0.05, position: 8.26 }],
    }),
    { clicks: 5, impressions: 100, ctr: 0.05, position: 8.3 },
  );
  assert.equal(
    searchConsoleRows(
      { rows: [{ keys: ["gpt news"], clicks: 2, impressions: 40 }] },
      "query",
    )[0].query,
    "gpt news",
  );
});

test("resolves the preferred All We Need Search Console property", () => {
  const sites = [
    { siteUrl: "https://example.com/" },
    { siteUrl: "sc-domain:allweneed.info" },
    { siteUrl: "https://allweneed.info/" },
  ];
  assert.equal(resolveSearchConsoleSite(sites), "sc-domain:allweneed.info");
  assert.equal(
    resolveSearchConsoleSite(sites, "https://allweneed.info/"),
    "https://allweneed.info/",
  );
  assert.equal(resolveSearchConsoleSite(sites, "https://missing.test/"), null);
});

test("recognizes the one-time Search Console authorization requirement", () => {
  assert.equal(
    searchConsoleStatusFromError(
      new SearchConsoleError("scope", {
        status: 403,
        code: "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
      }),
    ),
    "authorization_required",
  );
  assert.equal(
    searchConsoleStatusFromError(
      new SearchConsoleError("permission", { status: 403 }),
    ),
    "permission_required",
  );
});

test("builds a deterministic weekly review around reach and article entry", () => {
  const report = {
    generatedAt: "2026-08-15T12:00:00.000Z",
    ga4: {
      current: {
        pageViews: 70,
        activeUsers: 4,
        sessions: 20,
        engagedSessions: 6,
        engagementRate: 0.3,
      },
      previous: {
        pageViews: 50,
        activeUsers: 5,
        sessions: 14,
        engagedSessions: 7,
      },
      changes: {
        pageViews: percentChange(70, 50),
        activeUsers: percentChange(4, 5),
        sessions: percentChange(20, 14),
        engagedSessions: percentChange(6, 7),
      },
      organic: { activeUsers: 2, sessions: 4, engagedSessions: 3 },
      articleEntrySessions: 1,
      articleEntryShare: 0.05,
      landingPages: [
        { landingPage: "/", sessions: 15, activeUsers: 4, engagedSessions: 5 },
      ],
      acquisition: [],
      events: [{ eventName: "article_open", eventCount: 3, activeUsers: 2 }],
    },
    searchConsole: {
      status: "authorization_required",
      actionRequired: "Authorize Search Console.",
    },
    recommendations: [],
  };
  report.recommendations = buildRecommendations(report);
  assert.deepEqual(
    report.recommendations.slice(0, 3).map((item) => item.code),
    [
      "connect_search_console",
      "grow_organic_reach",
      "increase_article_entries",
    ],
  );
  const markdown = renderGrowthMarkdown(report);
  assert.match(markdown, /活跃用户：4/);
  assert.match(markdown, /文章入口占比：5\.0%/);
  assert.match(markdown, /authorization_required/);
});

test("the weekly command writes only ignored tmp reports", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(
    packageJson.scripts["growth:weekly"],
    "node scripts/refresh-growth-report.mjs",
  );
  const source = await readFile(
    new URL("../scripts/refresh-growth-report.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /tmp\/growth-report\.json/);
  assert.match(source, /tmp\/growth-report\.md/);
});

