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
  assert.match(html, /今天真正需要知道的/);
  assert.match(html, /必须知道/);
  assert.match(html, /正在升温/);
  assert.match(html, /今日简报/);
  assert.match(html, /探索/);
  assert.match(html, /投资与公司信号/);
  assert.match(html, /GPT 已分析/);
  assert.match(html, /language-switch/);
  assert.match(html, />EN</);
  assert.match(html, /信源库/);
  assert.ok(html.includes(snapshot.items.length.toLocaleString()));
  assert.ok(html.includes(String(snapshot.successfulSources)));
  assert.ok(html.includes(radar.translations.zh.signals[0].title));
  assert.match(html, /href="\?article=1"/);
  assert.match(html, /跨平台验证/);
  assert.ok(!html.includes(radar.translations.zh.signals[0].shiftTo));
  assert.match(html, />预览</);
  assert.ok(html.includes(radar.translations.zh.companySignals[0].headline));
  assert.match(html, /投资解读/);
  assert.match(html, /潜在催化因素/);
  assert.match(html, /反证风险/);
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
  assert.ok(
    JSON.parse(radar).signals.length >= 6 &&
      JSON.parse(radar).signals.length <= 12,
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
    JSON.parse(radar).signals.filter((signal) => signal.sourceCount >= 2)
      .length >= Math.ceil((JSON.parse(radar).signals.length * 2) / 3),
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
  assert.equal(JSON.parse(radar).exploreSignals.length, 8);
  assert.ok(
    new Set(
      JSON.parse(radar).exploreSignals.map((signal) => signal.category),
    ).size >= 6,
  );
  assert.ok(
    JSON.parse(radar).exploreSignals.filter(
      (signal) => signal.label === "高风险高潜",
    ).length >= 2,
  );
  assert.ok(
    JSON.parse(radar).exploreSignals.filter(
      (signal) => signal.sourceCount >= 2,
    ).length >= 5,
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
  assert.match(page, /function StoryLinkIcon/);
  assert.equal(page.match(/<StoryLinkIcon \/>/g)?.length, 2);
  assert.match(
    page,
    /const \[expanded, setExpanded\] = useState<number\[]>\(\[\]\)/,
  );
  assert.match(
    page,
    /const \[expandedExplore, setExpandedExplore\] = useState<string\[]>\(\[\]\)/,
  );
  assert.match(page, /function toggleExpandedExplore/);
  assert.match(page, /id=\{`explore-preview-\$\{signal\.id\}`\}/);
  assert.equal(page.match(/t\("预览", "Preview"\)/g)?.length, 2);
  assert.match(styles, /\.explore-card\.explore-featured\.explore-expanded/);
  assert.match(styles, /\.explore-card-actions \.analysis-toggle/);
  assert.match(articleView, /这篇稿子基于什么/);
  assert.match(articleView, /evidence\.url/);
  assert.match(articleView, /返回探索/);
  assert.match(exploreArticleScript, /single-source hypothesis/);
  assert.match(packageJson, /expand-explore-articles\.mjs/);
  assert.match(page, /SourceLibrary locale=\{locale\}/);
  assert.match(page, /最强反方观点/);
  assert.doesNotMatch(page, /SkeletonPreview|codex-preview/);
  assert.doesNotMatch(layout, /Starter Project|codex-preview/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);

  await assert.rejects(
    access(new URL("../app/_sites-preview", templateRoot)),
  );
});
