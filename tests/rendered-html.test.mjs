import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

import {
  calculateSignalHeat,
  compareExposureEditorialValue,
} from "../app/signal-heat.ts";
import {
  getSourceKind,
  publicSourceCatalog,
  sourceCatalog as configuredSources,
} from "../app/source-catalog.ts";

const templateRoot = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the All We Need product shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  const radar = JSON.parse(
    await readFile(new URL("../data/daily-radar.json", import.meta.url), "utf8"),
  );
  const snapshot = JSON.parse(
    await readFile(new URL("../data/feed-snapshot.json", import.meta.url), "utf8"),
  );
  assert.match(html, /<title>All We Need — AI 科技投资情报<\/title>/i);
  assert.match(html, /值得关注的最新变化/);
  assert.match(html, /必须知道/);
  assert.match(html, /正在形成的变化/);
  assert.match(html, /最新动态/);
  assert.match(html, /持续更新/);
  assert.doesNotMatch(html, /今日简报|Today's Brief|Daily Brief/);
  assert.match(html, /探索/);
  assert.doesNotMatch(html, />永久</);
  assert.match(html, /投资与公司信号/);
  assert.match(html, /GPT 已分析/);
  assert.match(html, /language-switch/);
  assert.match(html, />EN</);
  assert.match(html, /font-size-control/);
  assert.match(html, /较大字体/);
  assert.match(html, /超大字体/);
  assert.match(html, /信源库/);
  assert.match(html, /条真实内容已抓取/);
  const publicSourceIds = new Set(publicSourceCatalog.map((source) => source.id));
  const publicSuccessfulSources = snapshot.statuses.filter(
    (status) =>
      publicSourceIds.has(status.sourceId) &&
      ["ok", "empty"].includes(status.status),
  ).length;
  assert.ok(html.includes(String(publicSuccessfulSources)));
  const activeDynamicSignals = radar.signals
    .map((signal, index) => ({
      ...signal,
      translatedTitle: radar.translations.zh.signals[index].title,
      heat: calculateSignalHeat(signal, {
        now: radar.generatedAt,
        profile: "dynamic",
      }),
    }))
    .filter(
      (signal) =>
        signal.editorialBucket === "dynamic" && signal.heat.visible,
    )
    .sort((left, right) =>
      compareExposureEditorialValue(left, right, {
        profile: "dynamic",
      }),
    );
  const firstDynamicIndex = radar.signals.findIndex(
    (signal) => signal.id === activeDynamicSignals[0]?.id,
  );
  assert.ok(firstDynamicIndex >= 0);
  assert.ok(html.includes(radar.translations.zh.signals[firstDynamicIndex].title));
  const dynamicCount = activeDynamicSignals.length;
  assert.match(html, new RegExp(`${dynamicCount}(?:<!-- -->)? 条动态`));
  assert.doesNotMatch(html, /30 个信号|30 signals|30 条动态|30 updates/);
  assert.match(
    html,
    /将分散的信息噪声压缩为少数值得判断的变化，让事实、共识与转折在同一条脉络中显现/,
  );
  assert.doesNotMatch(html, /新批次置顶，批内按价值排序/);
  const expectedDynamicOrder = activeDynamicSignals;
  const renderedDynamicIndices = expectedDynamicOrder.map((signal) =>
    html.indexOf(signal.translatedTitle),
  );
  assert.ok(renderedDynamicIndices.every((index) => index >= 0));
  assert.ok(
    renderedDynamicIndices.every(
      (index, position) =>
        position === 0 || renderedDynamicIndices[position - 1] < index,
    ),
  );
  assert.match(html, /href="\?article=1"/);
  assert.match(html, /高热 \d+|关注 \d+|降温 \d+/);
  assert.match(html, /跨平台验证/);
  assert.ok(!html.includes(radar.translations.zh.signals[0].shiftTo));
  assert.match(html, />预览</);
  assert.match(html, /探索更多/);
  assert.match(html, /看完发生了什么，再去看接下来可能发生什么/);
  assert.ok(
    html.indexOf("GPT 分析完成") < html.indexOf("看完发生了什么，再去看接下来可能发生什么"),
  );
  assert.ok(html.includes(radar.translations.zh.companySignals[0].headline));
  assert.match(html, /href="\?article=company-0"/);
  assert.ok(
    !html.includes(radar.translations.zh.companySignals[0].investmentRead),
  );
  assert.ok(!html.includes(radar.translations.zh.companySignals[0].catalyst));
  assert.ok(!html.includes(radar.translations.zh.companySignals[0].risk));
  assert.match(html, /GPT 分析完成/);
  assert.doesNotMatch(
    html,
    /今日 Brief|Explore 信息流|MUST KNOW|WHY NOW|EVIDENCE TRAIL|INVESTMENT READ|CAPITAL &amp; COMPANY SIGNALS|GPT ANALYZED/,
  );
  assert.doesNotMatch(html, /codex-preview/);
  assert.doesNotMatch(html, /Your site is taking shape/);
});

test("removes all disposable starter preview code", async () => {
  const [
    page,
    layout,
    styles,
    packageJson,
    sourceLibrary,
    snapshot,
    radar,
    sourceCatalog,
    articleView,
    conversations,
    exploreArticleScript,
    fetchScript,
    analyzeScript,
    staticConfig,
    exploreEntry,
    conversationsEntry,
    sourcesEntry,
  ] =
    await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../app/source-library.tsx", import.meta.url), "utf8"),
    readFile(new URL("../data/feed-snapshot.json", import.meta.url), "utf8"),
    readFile(new URL("../data/daily-radar.json", import.meta.url), "utf8"),
    readFile(new URL("../app/source-catalog.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/article-view.tsx", import.meta.url), "utf8"),
    readFile(new URL("../data/conversations.json", import.meta.url), "utf8"),
    readFile(
      new URL("../scripts/expand-explore-articles.mjs", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../scripts/fetch-sources.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/analyze-radar.mjs", import.meta.url), "utf8"),
    readFile(new URL("../vite.static.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../static/explore/index.html", import.meta.url), "utf8"),
    readFile(
      new URL("../static/conversations/index.html", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../static/sources/index.html", import.meta.url), "utf8"),
  ]);

  assert.match(page, /All We Need/);
  assert.match(page, /t\("搜索情报", "Search intelligence"\)/);
  assert.match(styles, /prefers-reduced-motion/);
  assert.match(layout, /lang="zh-CN"/);
  assert.match(sourceLibrary, /刚刚抓取/);
  assert.match(sourceLibrary, /官方 API 凭证/);
  const snapshotData = JSON.parse(snapshot);
  assert.equal(snapshotData.totalSources, snapshotData.statuses.length);
  assert.ok(snapshotData.successfulSources >= 120);
  assert.ok(snapshotData.items.length > 1000);
  assert.equal(
    snapshotData.statuses.filter(
      (status) => status.kind === "YouTube" && status.status === "error",
    ).length,
    0,
  );
  assert.match(sourceCatalog, /UCXl4i9dYBrFOabk0xGmbkRA/);
  assert.match(sourceCatalog, /UC9cn0TuPq4dnbTY-CBsm8XA/);
  assert.match(
    sourceCatalog,
    /SAIR Foundation[\s\S]*UC7Ali6YE6lik1w8MS7Hr55Q/,
  );
  assert.match(
    sourceCatalog,
    /Silicon Valley Vector 硅谷坐标[\s\S]*UCsiOlr6emY5OxXF848EYqGw/,
  );
  assert.match(
    sourceCatalog,
    /a16z Newsletter[\s\S]*feedUrl: "https:\/\/www\.a16z\.news\/feed"/,
  );
  assert.match(
    sourceCatalog,
    /Federal Reserve — Monetary Policy[\s\S]*press_monetary\.xml/,
  );
  assert.match(
    sourceCatalog,
    /Federal Reserve — Speeches & Testimony[\s\S]*speeches_and_testimony\.xml/,
  );
  for (const ticker of [
    "NVDA",
    "MSFT",
    "AAPL",
    "GOOGL",
    "AMZN",
    "META",
    "TSLA",
    "AMD",
    "AVGO",
    "ORCL",
    "PLTR",
    "TSM",
    "GFS",
    "LRCX",
    "AMAT",
    "KLAC",
    "ASML",
    "SNPS",
    "CDNS",
    "MU",
    "MRVL",
  ]) {
    assert.match(sourceCatalog, new RegExp(`ticker: "${ticker}"`));
  }
  assert.match(
    sourceCatalog,
    /GlobalFoundries Newsroom[\s\S]*wp-json\/wp\/v2\/press-release[\s\S]*feedFormat: "wordpress-json"/,
  );
  assert.match(
    sourceCatalog,
    /NIST News[\s\S]*nist\.gov\/news-events\/news\/rss\.xml/,
  );
  assert.match(
    sourceCatalog,
    /Lam Research Newsroom[\s\S]*press-releases\?pagetemplate=rss/,
  );
  assert.match(
    sourceCatalog,
    /Applied Materials News Releases[\s\S]*rss\/news-releases\.xml/,
  );
  assert.match(
    sourceCatalog,
    /KLA Press Releases[\s\S]*press-releases\/rss/,
  );
  assert.match(
    sourceCatalog,
    /Synopsys News Releases[\s\S]*home\?pagetemplate=rss/,
  );
  assert.match(
    sourceCatalog,
    /Micron News Releases[\s\S]*rss\/news-releases\.xml[\s\S]*feedLanguage: "en"/,
  );
  assert.match(fetchScript, /function parseWordPressJson/);
  assert.match(fetchScript, /function parseAmazonPressHtml/);
  assert.match(fetchScript, /function matchesConfiguredLanguage/);
  assert.match(
    sourceCatalog,
    /Amazon Press Center[\s\S]*press-release-archive\?q=&f0=en-US[\s\S]*feedFormat: "amazon-press-html"/,
  );
  assert.match(
    sourceCatalog,
    /Anthropic Newsroom[\s\S]*feedFormat: "sitemap-xml"[\s\S]*feedPathPrefixes: \["\/news\/"\]/,
  );
  assert.match(
    sourceCatalog,
    /Moonshot AI \/ Kimi Blog[\s\S]*feedFormat: "news-list-html"/,
  );
  assert.match(
    sourceCatalog,
    /DeepSeek — Hugging Face Models[\s\S]*feedFormat: "huggingface-models-json"/,
  );
  assert.match(
    sourceCatalog,
    /DeepSeek API Changelog[\s\S]*feedUrl: "https:\/\/api-docs\.deepseek\.com\/updates\/"[\s\S]*feedFormat: "dated-changelog-html"/,
  );
  assert.match(fetchScript, /function parseSitemapXml/);
  assert.match(fetchScript, /function parseNewsListHtml/);
  assert.match(fetchScript, /function parseDatedChangelogHtml/);
  assert.match(fetchScript, /function parseHuggingFaceModelsJson/);
  assert.match(fetchScript, /function fetchSecSource/);
  assert.match(fetchScript, /api\/xbrl\/companyfacts/);
  assert.match(fetchScript, /--source-ids/);
  assert.match(
    await readFile(
      new URL("scripts/run-feed-cycle.mjs", templateRoot),
      "utf8",
    ),
    /mkdir\(dirname\(lockPath\), \{ recursive: true \}\)/,
  );
  assert.match(analyzeScript, /Federal Reserve 与 SEC 属于一手官方来源/);
  assert.match(sourceCatalog, /host === "www\.a16z\.news"/);
  assert.doesNotMatch(page, /nav-count">159/);
  assert.doesNotMatch(sourceLibrary, /All 159 Sources|全部 159 个信源/);
  assert.match(
    sourceCatalog,
    /Chris Siebenmann[\s\S]*feedUrl: "https:\/\/utcc\.utoronto\.ca\/~cks\/space\/blog\/\?atom"/,
  );
  const repairedBlogIds = new Set([
    57, 62, 66, 90, 91, 92, 94, 99, 117, 127, 131, 135, 142,
  ]);
  assert.ok(
    snapshotData.statuses
      .filter((status) => repairedBlogIds.has(status.sourceId))
      .every(
        (status) =>
          status.status === "ok" &&
          status.itemCount > 0 &&
          status.feedUrl,
      ),
  );
  assert.ok(JSON.parse(radar).signals.length >= 6);
  const editorialCounts = JSON.parse(radar).signals.reduce(
    (counts, signal) => {
      counts[signal.editorialBucket] =
        (counts[signal.editorialBucket] ?? 0) + 1;
      return counts;
    },
    {},
  );
  assert.ok(editorialCounts.dynamic >= 1);
  assert.ok(editorialCounts.explore >= 1);
  assert.ok(editorialCounts.archive >= 1);
  assert.equal(
    Object.values(editorialCounts).reduce((sum, count) => sum + count, 0),
    JSON.parse(radar).signals.length,
  );
  assert.ok(
    JSON.parse(radar).signals.every((signal) =>
      ["dynamic", "explore", "archive"].includes(signal.editorialBucket),
    ),
  );
  assert.ok(
    JSON.parse(radar).signals.every(
      (signal) =>
        signal.feedBatchAt &&
        Number.isFinite(Date.parse(signal.feedBatchAt)) &&
        signal.score >= 0 &&
        signal.score <= 99,
    ),
  );
  const feedBatches = [
    ...new Set(JSON.parse(radar).signals.map((signal) => signal.feedBatchAt)),
  ];
  assert.ok(feedBatches.length >= 2);
  assert.deepEqual(
    feedBatches,
    [...feedBatches].sort((left, right) => Date.parse(right) - Date.parse(left)),
  );
  assert.equal(
    JSON.parse(radar).signals.find((signal) => signal.id === 30).score,
    74,
  );
  assert.deepEqual(
    JSON.parse(radar).signals
      .filter((signal) => signal.permanent)
      .map((signal) => signal.id)
      .sort((left, right) => left - right),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
  assert.ok(JSON.parse(radar).analyzedItemCount > 100);
  assert.ok(
    ["gpt-5.6-sol", "gpt-5.5"].includes(JSON.parse(radar).model),
  );
  assert.ok(JSON.parse(radar).translations?.zh);
  assert.ok(JSON.parse(radar).translations?.en);
  assert.equal(
    JSON.parse(radar).translations.en.signals.length,
    JSON.parse(radar).signals.length,
  );
  assert.match(
    JSON.parse(radar).translations.zh.signals
      .map((signal) => `${signal.title} ${signal.summary}`)
      .join(" "),
    /AI|OpenAI|Hugging Face|Kimi|Agent|token|context|cache|workflow|moat/i,
  );
  assert.ok(JSON.parse(radar).translations.en.signals[0].title);
  assert.ok(
    JSON.parse(radar).signals.every(
      (signal) =>
        signal.sourceCount >= 1 &&
        signal.evidence.length >= 1 &&
        signal.evidence.every((item) => item.url),
    ),
  );
  assert.ok(
    JSON.parse(radar).signals.every(
      (signal) =>
        signal.shiftFrom &&
        signal.shiftTo &&
        signal.crossValidation &&
        signal.article?.lead &&
        signal.article?.sections?.length === 3 &&
        signal.article?.sections.every(
          (section) => section.heading && section.body,
        ) &&
        signal.article?.outlook &&
        signal.evidence.length,
    ),
  );
  assert.ok(
    JSON.parse(radar).translations.zh.signals.every(
      (signal) =>
        signal.article?.lead &&
        signal.article?.sections?.length === 3 &&
        signal.article?.outlook,
    ),
  );
  assert.ok(
    JSON.parse(radar).translations.en.signals.every(
      (signal) =>
        signal.article?.lead &&
        signal.article?.sections?.length === 3 &&
        signal.article?.outlook,
    ),
  );
  assert.equal(JSON.parse(radar).companySignals.length, 3);
  assert.ok(
    JSON.parse(radar).companySignals.every(
      (signal) =>
        signal.sourceCount >= 2 &&
        signal.investmentRead &&
        signal.catalyst &&
        signal.risk &&
        signal.watchNext &&
        signal.crossValidation &&
        signal.article?.lead &&
        signal.article?.sections?.length === 3 &&
        signal.article?.sections.every(
          (section) => section.heading && section.body,
        ) &&
        signal.article?.outlook &&
        signal.evidence.length >= 2,
    ),
  );
  assert.ok(
    JSON.parse(radar).translations.zh.companySignals.every(
      (signal) =>
        signal.crossValidation &&
        signal.article?.lead &&
        signal.article?.sections?.length === 3 &&
        signal.article?.outlook,
    ),
  );
  assert.ok(
    JSON.parse(radar).translations.en.companySignals.every(
      (signal) =>
        signal.crossValidation &&
        signal.article?.lead &&
        signal.article?.sections?.length === 3 &&
        signal.article?.outlook,
    ),
  );
  assert.ok(JSON.parse(radar).exploreSignals.length >= 50);
  assert.ok(
    JSON.parse(radar).exploreSignals.every(
      (signal) =>
        Number.isFinite(Date.parse(signal.feedBatchAt)) &&
        signal.valueScore >= 0 &&
        signal.valueScore <= 99,
    ),
  );
  assert.deepEqual(
    JSON.parse(radar).exploreSignals
      .filter((signal) => signal.relatedSignalId)
      .map((signal) => [signal.id, signal.relatedSignalId]),
    [
      ["explore-2", 2],
      ["explore-4", 6],
      ["explore-6", 12],
      ["explore-7", 8],
    ],
  );
  assert.ok(
    JSON.parse(radar).signals.filter(
      (signal) => signal.editorialBucket === "explore",
    ).length +
      JSON.parse(radar).exploreSignals.filter(
        (signal) => !signal.relatedSignalId,
      ).length >=
      50,
  );
  assert.ok(
    new Set(
      JSON.parse(radar).exploreSignals.map((signal) => signal.category),
    ).size >= 10,
  );
  assert.ok(
    JSON.parse(radar).exploreSignals.filter(
      (signal) => signal.label === "高风险高潜",
    ).length >= 8,
  );
  assert.ok(
    JSON.parse(radar).exploreSignals.filter(
      (signal) => signal.sourceCount >= 2,
    ).length >= 15,
  );
  assert.ok(
    JSON.parse(radar).exploreSignals.every(
      (signal) =>
        signal.crossValidation &&
        signal.article?.lead &&
        signal.article?.sections?.length === 3 &&
        signal.article?.sections.every(
          (section) => section.heading && section.body,
        ) &&
        signal.article?.outlook,
    ),
  );
  for (const locale of ["zh", "en"]) {
    assert.equal(
      JSON.parse(radar).translations[locale].exploreSignals.length,
      JSON.parse(radar).exploreSignals.length,
    );
    assert.ok(
      JSON.parse(radar).translations[locale].exploreSignals.every(
        (signal) =>
          signal.crossValidation &&
          signal.article?.lead &&
          signal.article?.sections?.length === 3 &&
          signal.article?.outlook,
      ),
    );
  }
  assert.match(page, /explore-grid/);
  assert.match(page, /signal-radar-locale/);
  assert.match(page, /compareExposureEditorialValue/);
  assert.doesNotMatch(page, /all-we-need-read-history-v1/);
  assert.match(page, /href=\{`\?article=\$\{signal\.id\}`\}/);
  assert.match(page, /activeExploreArticle/);
  assert.match(page, /meetsExploreEditorialFloor\(signal\)/);
  assert.match(page, /kind="explore"/);
  assert.match(page, /kind="company"/);
  assert.match(page, /kind="conversation"/);
  assert.match(page, /function StoryLinkIcon/);
  assert.doesNotMatch(page, /permanent-badge/);
  assert.equal(page.match(/<StoryLinkIcon \/>/g)?.length, 4);
  assert.match(page, /conversation-grid/);
  assert.match(page, /function toggleExpandedConversation/);
  assert.match(page, /function conversationsMore/);
  assert.match(page, /t\("精选对谈", "Conversations"\)/);
  assert.match(page, /conversation-bridge-cta/);
  assert.match(page, /function basePathFromPathname/);
  assert.match(page, /function sectionPath/);
  assert.match(page, /pathname\.startsWith\("\/intelligence\/"\)/);
  assert.match(page, /function routeFromPathname/);
  assert.match(page, /window\.history\.pushState/);
  assert.match(
    page,
    /`\$\{window\.location\.pathname\}\$\{window\.location\.search\}`/,
  );
  assert.match(staticConfig, /static\/explore\/index\.html/);
  assert.match(staticConfig, /static\/conversations\/index\.html/);
  assert.match(staticConfig, /static\/sources\/index\.html/);
  assert.match(exploreEntry, /<title>探索 — All We Need<\/title>/);
  assert.match(
    conversationsEntry,
    /<title>精选对谈 — All We Need<\/title>/,
  );
  assert.match(sourcesEntry, /<title>信源库 — All We Need<\/title>/);
  const conversationData = JSON.parse(conversations);
  assert.ok(conversationData.items.length >= 20);
  assert.ok(
    conversationData.items.every(
      (item) =>
        /^https:\/\//.test(item.url) &&
        ["YouTube", "Podcast"].includes(item.sourceKind) &&
        item.titleZh &&
        item.titleEn &&
        item.takeawaysZh?.length === 3 &&
        item.takeawaysEn?.length === 3 &&
        item.articleZh?.sections?.length === 3 &&
        item.articleEn?.sections?.length === 3,
      ),
  );
  assert.ok(
    configuredSources.some(
      (source) =>
        source.conversationSource && getSourceKind(source.url) === "Podcast",
    ),
  );
  assert.match(
    page,
    /const \[expanded, setExpanded\] = useState<number\[]>\(\[\]\)/,
  );
  assert.match(
    page,
    /const \[expandedExplore, setExpandedExplore\] = useState<string\[]>\(\[\]\)/,
  );
  assert.match(
    page,
    /const \[expandedCompany, setExpandedCompany\] = useState<string\[]>\(\[\]\)/,
  );
  assert.match(page, /expandedConversation/);
  assert.match(page, /function toggleExpandedExplore/);
  assert.match(page, /function toggleExpandedCompany/);
  assert.match(page, /matchMedia\("\(max-width: 700px\)"\)/);
  assert.match(page, /view === "brief" && !mobileAnalysisInExplore/);
  assert.match(page, /view === "explore" && mobileAnalysisInExplore/);
  assert.match(page, /signal\.sourceCount >= 2/);
  assert.doesNotMatch(page, /localizedDiscoveries/);
  assert.match(page, /id=\{`explore-preview-\$\{signal\.id\}`\}/);
  assert.match(page, /id=\{`company-preview-\$\{item\.id\}`\}/);
  assert.match(page, /id=\{`conversation-preview-\$\{item\.id\}`\}/);
  assert.equal(page.match(/t\("预览", "Preview"\)/g)?.length, 4);
  assert.match(styles, /\.explore-card\.explore-featured\.explore-expanded/);
  assert.match(styles, /\.explore-card-actions \.analysis-toggle/);
  assert.match(articleView, /这篇稿子基于什么/);
  assert.match(articleView, /evidence\.url/);
  assert.match(articleView, /返回探索/);
  assert.match(exploreArticleScript, /single-source hypothesis/);
  assert.match(packageJson, /expand-explore-articles\.mjs/);
  assert.match(packageJson, /ensure-explore-depth\.mjs/);
  assert.match(page, /SourceLibrary locale=\{locale\}/);
  assert.match(page, /最强反方观点/);
  assert.doesNotMatch(page, /SkeletonPreview|codex-preview/);
  assert.doesNotMatch(layout, /Starter Project|codex-preview/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);

  await assert.rejects(
    access(new URL("../app/_sites-preview", templateRoot)),
  );
});
