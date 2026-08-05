import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  applyArticleMetadata,
  buildArticleCatalog,
  compactArticleCatalog,
  renderNewsSitemap,
  renderSitemap,
} from "../scripts/article-pages.mjs";

const root = new URL("../", import.meta.url);

async function fixture() {
  const [radar, routes, focusTemplate, exploreTemplate] = await Promise.all([
    readFile(new URL("data/daily-radar.json", root), "utf8").then(JSON.parse),
    readFile(new URL("data/article-routes.json", root), "utf8").then(JSON.parse),
    readFile(new URL("static/focus/index.html", root), "utf8"),
    readFile(new URL("static/explore/index.html", root), "utf8"),
  ]);
  return {
    radar,
    routes,
    focusTemplate,
    exploreTemplate,
    catalog: buildArticleCatalog(radar, routes),
  };
}

test("creates stable permanent routes for every Focus and publishable Explore article", async () => {
  const { radar, routes, catalog } = await fixture();
  const focusCount = radar.signals.filter(
    (signal) => signal.editorialBucket === "dynamic",
  ).length;
  assert.equal(
    catalog.articles.filter((article) => article.kind === "focus").length,
    focusCount,
  );
  assert.ok(
    catalog.articles.some((article) => article.kind === "explore"),
  );
  assert.equal(
    new Set(catalog.articles.map((article) => article.path)).size,
    catalog.articles.length,
  );
  assert.ok(
    catalog.articles.every(
      (article) =>
        /^\/(focus|explore)\/[a-z0-9-]+\/$/.test(article.path) &&
        article.zhPath === `/zh${article.path}` &&
        !article.path.includes("?article="),
    ),
  );

  const changedRadar = structuredClone(radar);
  const first = catalog.articles[0];
  if (first.kind === "focus") {
    const index = changedRadar.signals.findIndex(
      (signal) => String(signal.id) === first.id,
    );
    changedRadar.translations.en.signals[index].title = "A totally new title";
  }
  const regenerated = buildArticleCatalog(
    changedRadar,
    compactArticleCatalog(catalog),
  );
  assert.equal(
    regenerated.articles.find((article) => article.key === first.key).path,
    routes.articles.find((article) => article.key === first.key).path,
  );
});

test("sitemaps include permanent bilingual pages and limit News sitemap to 48 hours", async () => {
  const { catalog } = await fixture();
  const sitemap = renderSitemap(catalog);
  for (const article of catalog.articles) {
    assert.match(sitemap, new RegExp(article.path.replaceAll("/", "\\/")));
    assert.match(sitemap, new RegExp(article.zhPath.replaceAll("/", "\\/")));
  }
  assert.match(sitemap, /hreflang="en"/);
  assert.match(sitemap, /hreflang="zh-CN"/);

  const news = renderNewsSitemap(catalog, catalog.generatedAt);
  const cutoff = Date.parse(catalog.generatedAt) - 48 * 60 * 60 * 1_000;
  const eligible = catalog.articles.filter(
    (article) =>
      article.kind === "focus" && Date.parse(article.publishedAt) >= cutoff,
  );
  assert.equal((news.match(/<news:news>/g) ?? []).length, eligible.length);
  assert.ok(
    eligible.every((article) =>
      news.includes(`https://allweneed.info${article.path}`),
    ),
  );
  assert.doesNotMatch(news, /\/explore\//);
});

test("static article HTML exposes unique metadata, structured data, body copy and sources", async () => {
  const { catalog, focusTemplate, exploreTemplate } = await fixture();
  const article = catalog.articles.find(
    (candidate) =>
      candidate.kind === "focus" && candidate.locales.en.evidence.length > 0,
  );
  assert.ok(article);
  const html = applyArticleMetadata(focusTemplate, article, "en");
  assert.match(
    html,
    new RegExp(`<title>${article.locales.en.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} — All We Need</title>`),
  );
  assert.match(
    html,
    new RegExp(`rel="canonical" href="https://allweneed.info${article.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`),
  );
  assert.match(html, /property="og:type" content="article"/);
  assert.match(html, /"@type":"NewsArticle"/);
  assert.match(html, /hreflang="zh-CN"/);
  assert.match(html, /article-static-fallback/);
  assert.match(html, /<h1>/);
  assert.match(html, /<h2>Sources<\/h2>/);
  assert.match(html, /rel="noopener noreferrer"/);

  const explore = catalog.articles.find(
    (candidate) => candidate.kind === "explore",
  );
  assert.ok(explore);
  const exploreHtml = applyArticleMetadata(
    exploreTemplate,
    explore,
    "en",
  );
  assert.match(
    exploreHtml,
    new RegExp(`rel="canonical" href="https://allweneed.info${explore.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`),
  );
  assert.doesNotMatch(
    exploreHtml,
    /rel="canonical" href="https:\/\/allweneed\.info\/explore\/"/,
  );
});
