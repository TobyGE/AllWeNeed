import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { googleAccessToken } from "./google-access-token.mjs";
import {
  listSearchConsoleSites,
  listSearchConsoleSitemaps,
  querySearchConsole,
  resolveSearchConsoleSite,
  searchConsoleStatusFromError,
  submitSearchConsoleSitemap,
} from "./search-console.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultJsonOutput = resolve(projectRoot, "tmp/growth-report.json");
const defaultMarkdownOutput = resolve(projectRoot, "tmp/growth-report.md");
const ga4PropertyId = process.env.GA4_PROPERTY_ID ?? "548148776";
const siteOrigin = "https://allweneed.info";
const sitemapUrls = [
  `${siteOrigin}/sitemap.xml`,
  `${siteOrigin}/news-sitemap.xml`,
];

function number(row, index) {
  return Number(row?.metricValues?.[index]?.value ?? 0);
}

function rounded(value, digits = 3) {
  return Number(Number(value || 0).toFixed(digits));
}

export function percentChange(current, previous) {
  if (!previous) return current ? null : 0;
  return rounded(((current - previous) / previous) * 100, 1);
}

export function ga4Totals(report) {
  const row = report?.totals?.[0] ?? report?.rows?.[0];
  return {
    pageViews: number(row, 0),
    activeUsers: number(row, 1),
    sessions: number(row, 2),
    engagedSessions: number(row, 3),
    engagementRate: rounded(
      number(row, 2) ? number(row, 3) / number(row, 2) : 0,
    ),
  };
}

export function ga4DimensionRows(report, dimensionNames, metricNames) {
  return (report?.rows ?? []).map((row) => ({
    ...Object.fromEntries(
      dimensionNames.map((name, index) => [
        name,
        row.dimensionValues?.[index]?.value ?? "",
      ]),
    ),
    ...Object.fromEntries(
      metricNames.map((name, index) => [name, number(row, index)]),
    ),
  }));
}

export function searchConsoleTotals(report) {
  const row = report?.rows?.[0] ?? {};
  return {
    clicks: Number(row.clicks ?? 0),
    impressions: Number(row.impressions ?? 0),
    ctr: rounded(row.ctr ?? 0),
    position: rounded(row.position ?? 0, 1),
  };
}

export function searchConsoleRows(report, keyName) {
  return (report?.rows ?? []).map((row) => ({
    [keyName]: row.keys?.[0] ?? "",
    clicks: Number(row.clicks ?? 0),
    impressions: Number(row.impressions ?? 0),
    ctr: rounded(row.ctr ?? 0),
    position: rounded(row.position ?? 0, 1),
  }));
}

function dateInNewYork(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function shiftDate(date, days) {
  const shifted = new Date(`${date}T12:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

async function ga4Request(token, body) {
  const response = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${ga4PropertyId}:runReport`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `GA4 Data API returned ${response.status}: ${detail.slice(0, 700)}`,
    );
  }
  return response.json();
}

function totalRequest(dateRange) {
  return {
    dateRanges: [dateRange],
    metrics: [
      { name: "screenPageViews" },
      { name: "activeUsers" },
      { name: "sessions" },
      { name: "engagedSessions" },
    ],
    metricAggregations: ["TOTAL"],
  };
}

async function collectGa4(token) {
  const currentRange = { startDate: "6daysAgo", endDate: "today" };
  const previousRange = { startDate: "13daysAgo", endDate: "7daysAgo" };
  const [current, previous, landingPages, acquisition, events] =
    await Promise.all([
      ga4Request(token, totalRequest(currentRange)),
      ga4Request(token, totalRequest(previousRange)),
      ga4Request(token, {
        dateRanges: [currentRange],
        dimensions: [{ name: "landingPagePlusQueryString" }],
        metrics: [
          { name: "sessions" },
          { name: "activeUsers" },
          { name: "engagedSessions" },
          { name: "screenPageViews" },
        ],
        orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
        limit: 15,
      }),
      ga4Request(token, {
        dateRanges: [currentRange],
        dimensions: [
          { name: "sessionDefaultChannelGroup" },
          { name: "sessionSourceMedium" },
        ],
        metrics: [
          { name: "sessions" },
          { name: "activeUsers" },
          { name: "engagedSessions" },
        ],
        orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
        limit: 20,
      }),
      ga4Request(token, {
        dateRanges: [currentRange],
        dimensions: [{ name: "eventName" }],
        metrics: [{ name: "eventCount" }, { name: "activeUsers" }],
        dimensionFilter: {
          filter: {
            fieldName: "eventName",
            inListFilter: {
              values: [
                "article_open",
                "article_read_complete",
                "article_share",
                "rss_subscribe",
                "source_link_open",
              ],
            },
          },
        },
        orderBys: [{ metric: { metricName: "eventCount" }, desc: true }],
      }),
    ]);

  const currentTotals = ga4Totals(current);
  const previousTotals = ga4Totals(previous);
  const landingPageRows = ga4DimensionRows(
    landingPages,
    ["landingPage"],
    ["sessions", "activeUsers", "engagedSessions", "pageViews"],
  );
  const acquisitionRows = ga4DimensionRows(
    acquisition,
    ["channel", "sourceMedium"],
    ["sessions", "activeUsers", "engagedSessions"],
  );
  const eventRows = ga4DimensionRows(
    events,
    ["eventName"],
    ["eventCount", "activeUsers"],
  );
  const organic = acquisitionRows.find((row) => row.channel === "Organic Search");
  const articleEntrySessions = landingPageRows
    .filter((row) =>
      /^\/(?:zh\/)?(?:focus|explore)\/.+/.test(row.landingPage),
    )
    .reduce((sum, row) => sum + row.sessions, 0);

  return {
    status: "ready",
    current: currentTotals,
    previous: previousTotals,
    changes: Object.fromEntries(
      ["pageViews", "activeUsers", "sessions", "engagedSessions"].map(
        (metric) => [
          metric,
          percentChange(currentTotals[metric], previousTotals[metric]),
        ],
      ),
    ),
    organic: organic ?? {
      channel: "Organic Search",
      sourceMedium: "",
      sessions: 0,
      activeUsers: 0,
      engagedSessions: 0,
    },
    articleEntrySessions,
    articleEntryShare: rounded(
      currentTotals.sessions ? articleEntrySessions / currentTotals.sessions : 0,
    ),
    landingPages: landingPageRows,
    acquisition: acquisitionRows,
    events: eventRows,
  };
}

async function collectSearchConsole(token, now, { submitSitemaps = true } = {}) {
  try {
    const permissionSites = await listSearchConsoleSites(token);
    const siteUrl = resolveSearchConsoleSite(permissionSites);
    if (!siteUrl) {
      return {
        status: "property_missing",
        availableSites: permissionSites.map((item) => item.siteUrl),
        actionRequired:
          "Add and verify allweneed.info in Google Search Console.",
      };
    }

    const today = dateInNewYork(now);
    const currentEnd = shiftDate(today, -2);
    const currentStart = shiftDate(currentEnd, -27);
    const previousEnd = shiftDate(currentStart, -1);
    const previousStart = shiftDate(previousEnd, -27);
    const summaryBody = (startDate, endDate, dimensions = []) => ({
      startDate,
      endDate,
      dimensions,
      type: "web",
      rowLimit: dimensions.length ? 10 : 1,
    });

    const submissions = [];
    if (submitSitemaps) {
      for (const sitemapUrl of sitemapUrls) {
        await submitSearchConsoleSitemap(token, siteUrl, sitemapUrl);
        submissions.push(sitemapUrl);
      }
    }

    const [current, previous, queries, pages, sitemaps] = await Promise.all([
      querySearchConsole(
        token,
        siteUrl,
        summaryBody(currentStart, currentEnd),
      ),
      querySearchConsole(
        token,
        siteUrl,
        summaryBody(previousStart, previousEnd),
      ),
      querySearchConsole(
        token,
        siteUrl,
        summaryBody(currentStart, currentEnd, ["query"]),
      ),
      querySearchConsole(
        token,
        siteUrl,
        summaryBody(currentStart, currentEnd, ["page"]),
      ),
      listSearchConsoleSitemaps(token, siteUrl),
    ]);
    const currentTotals = searchConsoleTotals(current);
    const previousTotals = searchConsoleTotals(previous);
    return {
      status: "ready",
      siteUrl,
      period: { startDate: currentStart, endDate: currentEnd },
      current: currentTotals,
      previous: previousTotals,
      changes: {
        clicks: percentChange(currentTotals.clicks, previousTotals.clicks),
        impressions: percentChange(
          currentTotals.impressions,
          previousTotals.impressions,
        ),
      },
      topQueries: searchConsoleRows(queries, "query"),
      topPages: searchConsoleRows(pages, "page"),
      submittedSitemaps: submissions,
      sitemaps: sitemaps.map((item) => ({
        path: item.path,
        lastSubmitted: item.lastSubmitted ?? null,
        lastDownloaded: item.lastDownloaded ?? null,
        isPending: Boolean(item.isPending),
        isSitemapsIndex: Boolean(item.isSitemapsIndex),
        warnings: Number(item.warnings ?? 0),
        errors: Number(item.errors ?? 0),
        contents: item.contents ?? [],
      })),
    };
  } catch (error) {
    return {
      status: searchConsoleStatusFromError(error),
      actionRequired:
        "Authorize Google application-default credentials with the webmasters scope.",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function eventCount(ga4, eventName) {
  return ga4.events.find((item) => item.eventName === eventName)?.eventCount ?? 0;
}

export function buildRecommendations(report) {
  const actions = [];
  if (report.searchConsole.status !== "ready") {
    actions.push({
      priority: 1,
      code: "connect_search_console",
      title: "完成 Search Console 授权与站点验证",
      reason: "当前无法观察 Google 曝光、点击、搜索词和索引错误。",
    });
  }
  if (report.ga4.organic.activeUsers < 5) {
    actions.push({
      priority: 1,
      code: "grow_organic_reach",
      title: "扩大自然搜索的真实用户覆盖",
      reason: `本周自然搜索仅带来 ${report.ga4.organic.activeUsers} 位活跃用户。`,
    });
  }
  if (report.ga4.articleEntryShare < 0.2) {
    actions.push({
      priority: 1,
      code: "increase_article_entries",
      title: "让具体文章成为外部入口",
      reason: `文章入口会话占比仅 ${(report.ga4.articleEntryShare * 100).toFixed(1)}%。`,
    });
  }
  if (eventCount(report.ga4, "article_share") === 0) {
    actions.push({
      priority: 2,
      code: "earn_first_share",
      title: "获得首批可归因的文章分享",
      reason: "本周尚未记录文章分享转化。",
    });
  }
  if (eventCount(report.ga4, "rss_subscribe") === 0) {
    actions.push({
      priority: 2,
      code: "earn_first_subscription",
      title: "获得首批可归因的 RSS 订阅点击",
      reason: "本周尚未记录 RSS 订阅点击。",
    });
  }
  if (report.ga4.current.engagementRate < 0.4) {
    actions.push({
      priority: 2,
      code: "improve_engagement",
      title: "改善访问质量",
      reason: `有效互动会话率为 ${(report.ga4.current.engagementRate * 100).toFixed(1)}%。`,
    });
  }
  return actions.slice(0, 5);
}

function changeLabel(value) {
  if (value === null) return "新出现";
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

export function renderGrowthMarkdown(report) {
  const ga4 = report.ga4;
  const search = report.searchConsole;
  const topLanding = ga4.landingPages[0];
  const lines = [
    "# All We Need 周增长复盘",
    "",
    `生成时间：${report.generatedAt}`,
    "",
    "## 本周真实增长",
    "",
    `- 活跃用户：${ga4.current.activeUsers}（环比 ${changeLabel(ga4.changes.activeUsers)}）`,
    `- 浏览量：${ga4.current.pageViews}（环比 ${changeLabel(ga4.changes.pageViews)}）`,
    `- 会话：${ga4.current.sessions}；有效互动会话：${ga4.current.engagedSessions}（${(ga4.current.engagementRate * 100).toFixed(1)}%）`,
    `- 自然搜索：${ga4.organic.activeUsers} 位用户、${ga4.organic.sessions} 个会话`,
    `- 文章入口占比：${(ga4.articleEntryShare * 100).toFixed(1)}%`,
    ...(topLanding
      ? [`- 最大入口：${topLanding.landingPage || "(not set)"}（${topLanding.sessions} 个会话）`]
      : []),
    "",
    "## Google Search Console",
    "",
    ...(search.status === "ready"
      ? [
          `- 点击：${search.current.clicks}（环比 ${changeLabel(search.changes.clicks)}）`,
          `- 曝光：${search.current.impressions}（环比 ${changeLabel(search.changes.impressions)}）`,
          `- CTR：${(search.current.ctr * 100).toFixed(2)}%；平均排名：${search.current.position}`,
          `- Sitemap：${search.sitemaps.length} 个，错误 ${search.sitemaps.reduce((sum, item) => sum + item.errors, 0)}，警告 ${search.sitemaps.reduce((sum, item) => sum + item.warnings, 0)}`,
        ]
      : [
          `- 状态：${search.status}`,
          `- 待办：${search.actionRequired}`,
        ]),
    "",
    "## 转化事件",
    "",
    ...[
      "article_open",
      "article_read_complete",
      "article_share",
      "rss_subscribe",
      "source_link_open",
    ].map(
      (name) => `- ${name}: ${eventCount(ga4, name)}`,
    ),
    "",
    "## 下周动作",
    "",
    ...report.recommendations.map(
      (item, index) => `${index + 1}. ${item.title} — ${item.reason}`,
    ),
    "",
  ];
  return lines.join("\n");
}

function outputArgument(prefix, fallback) {
  const argument = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return argument ? resolve(projectRoot, argument.slice(prefix.length)) : fallback;
}

export async function refreshGrowthReport({
  now = new Date(),
  jsonOutput = defaultJsonOutput,
  markdownOutput = defaultMarkdownOutput,
  submitSitemaps = !process.argv.includes("--no-submit-sitemaps"),
} = {}) {
  const ga4Token = await googleAccessToken({ envNames: ["GA4_ACCESS_TOKEN"] });
  const ga4 = await collectGa4(ga4Token);
  let searchConsole;
  try {
    const searchConsoleToken = await googleAccessToken({
      envNames: ["SEARCH_CONSOLE_ACCESS_TOKEN"],
    });
    searchConsole = await collectSearchConsole(searchConsoleToken, now, {
      submitSitemaps,
    });
  } catch (error) {
    searchConsole = {
      status: "authorization_required",
      actionRequired:
        "Authorize Google application-default credentials with the webmasters scope.",
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const report = {
    generatedAt: now.toISOString(),
    period: {
      current: { startDate: "6daysAgo", endDate: "today" },
      previous: { startDate: "13daysAgo", endDate: "7daysAgo" },
    },
    internalTraffic: {
      excludeUrl: `${siteOrigin}/?awn_internal=1`,
      restoreUrl: `${siteOrigin}/?awn_internal=0`,
    },
    ga4,
    searchConsole,
    recommendations: [],
  };
  report.recommendations = buildRecommendations(report);
  const markdown = renderGrowthMarkdown(report);
  await Promise.all([
    mkdir(dirname(jsonOutput), { recursive: true }),
    mkdir(dirname(markdownOutput), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(jsonOutput, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
    writeFile(markdownOutput, `${markdown}\n`, "utf8"),
  ]);
  console.log(markdown);
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await refreshGrowthReport({
    jsonOutput: outputArgument("--json-output=", defaultJsonOutput),
    markdownOutput: outputArgument("--markdown-output=", defaultMarkdownOutput),
  });
}
