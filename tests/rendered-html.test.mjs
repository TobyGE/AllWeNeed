import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

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

test("server-renders the Signal Radar product shell", async () => {
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
  assert.match(html, /<title>Signal Radar — AI 科技投资情报雷达<\/title>/i);
  assert.match(html, /值得关注的最新变化/);
  assert.match(html, /必须知道/);
  assert.match(html, /正在升温/);
  assert.match(html, /最新动态/);
  assert.match(html, /持续更新/);
  assert.doesNotMatch(html, /今日简报|Today's Brief|Daily Brief/);
  assert.match(html, /探索/);
  assert.doesNotMatch(html, />永久</);
  assert.match(html, /投资与公司信号/);
  assert.match(html, /GPT 已分析/);
  assert.match(html, /language-switch/);
  assert.match(html, />EN</);
  assert.match(html, /信源库/);
  assert.ok(html.includes(snapshot.items.length.toLocaleString()));
  assert.ok(html.includes(String(snapshot.successfulSources)));
  const firstDynamicIndex = radar.signals.findIndex(
    (signal) => signal.editorialBucket === "dynamic",
  );
  assert.ok(firstDynamicIndex >= 0);
  assert.ok(html.includes(radar.translations.zh.signals[firstDynamicIndex].title));
  assert.match(html, /11(?:<!-- -->)? 条动态/);
  assert.doesNotMatch(html, /30 个信号|30 signals|30 条动态|30 updates/);
  assert.match(
    html,
    /将分散的信息噪声压缩为少数值得判断的变化，让事实、共识与转折在同一条脉络中显现/,
  );
  assert.doesNotMatch(html, /新批次置顶，批内按价值排序/);
  const translatedTitle = (id) => {
    const index = radar.signals.findIndex((signal) => signal.id === id);
    return radar.translations.zh.signals[index].title;
  };
  const fomcIndex = html.indexOf(translatedTitle(10));
  const metaIndex = html.indexOf(translatedTitle(11));
  const wordIndex = html.indexOf(translatedTitle(16));
  const cloudflareIndex = html.indexOf(translatedTitle(30));
  const morningPermanentIndex = html.indexOf(translatedTitle(1));
  assert.ok(fomcIndex >= 0);
  assert.ok(fomcIndex < metaIndex);
  assert.ok(metaIndex < wordIndex);
  assert.ok(wordIndex < cloudflareIndex);
  assert.ok(cloudflareIndex < morningPermanentIndex);
  assert.match(html, /href="\?article=1"/);
  assert.match(html, /跨平台验证/);
  assert.ok(!html.includes(radar.translations.zh.signals[0].shiftTo));
  assert.match(html, />预览</);
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
    exploreArticleScript,
    fetchScript,
    analyzeScript,
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
    readFile(
      new URL("../scripts/expand-explore-articles.mjs", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../scripts/fetch-sources.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/analyze-radar.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(page, /Signal Radar/);
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
  ]) {
    assert.match(sourceCatalog, new RegExp(`ticker: "${ticker}"`));
  }
  assert.match(fetchScript, /function fetchSecSource/);
  assert.match(fetchScript, /api\/xbrl\/companyfacts/);
  assert.match(fetchScript, /--source-ids/);
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
  assert.deepEqual(editorialCounts, {
    archive: 12,
    dynamic: 11,
    explore: 7,
  });
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
  assert.deepEqual(
    [...new Set(JSON.parse(radar).signals.map((signal) => signal.feedBatchAt))],
    ["2026-07-29T20:21:07.772Z", "2026-07-29T13:02:22.855Z"],
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
        signal.evidence.length >= 2,
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
  assert.match(page, /href=\{`\?article=\$\{signal\.id\}`\}/);
  assert.match(page, /activeExploreArticle/);
  assert.match(page, /kind="explore"/);
  assert.match(page, /kind="company"/);
  assert.match(page, /function StoryLinkIcon/);
  assert.doesNotMatch(page, /permanent-badge/);
  assert.equal(page.match(/<StoryLinkIcon \/>/g)?.length, 3);
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
  assert.match(page, /function toggleExpandedExplore/);
  assert.match(page, /function toggleExpandedCompany/);
  assert.match(page, /id=\{`explore-preview-\$\{signal\.id\}`\}/);
  assert.match(page, /id=\{`company-preview-\$\{item\.id\}`\}/);
  assert.equal(page.match(/t\("预览", "Preview"\)/g)?.length, 3);
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
