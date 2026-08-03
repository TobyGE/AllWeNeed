import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const analyticsSource = await readFile(
  new URL("../app/analytics.ts", import.meta.url),
  "utf8",
);
const pageSource = await readFile(
  new URL("../app/page.tsx", import.meta.url),
  "utf8",
);
const layoutSource = await readFile(
  new URL("../app/layout.tsx", import.meta.url),
  "utf8",
);
const staticEntrypoints = await Promise.all(
  ["../static/index.html", "../static/live/index.html", "../static/explore/index.html", "../static/conversations/index.html", "../static/sources/index.html"].map(
    (entrypoint) => readFile(new URL(entrypoint, import.meta.url), "utf8"),
  ),
);

test("configures the dedicated All We Need GA4 property on production hosts", () => {
  assert.match(analyticsSource, /G-8R17J8CJ1W/);
  assert.match(analyticsSource, /allweneed\.info/);
  assert.match(analyticsSource, /yingqiangge\.github\.io/);
  assert.match(analyticsSource, /send_page_view: false/);
  assert.match(analyticsSource, /globalPrivacyControl/);
  assert.doesNotMatch(analyticsSource, /document\.createElement\("script"\)/);
});

test("initializes GA4 in the document head before React starts", () => {
  assert.match(layoutSource, /googletagmanager\.com\/gtag\/js/);
  assert.match(layoutSource, /signalRadarAnalyticsReady = true/);
  assert.match(layoutSource, /analytics_storage/);
  assert.match(layoutSource, /ad_personalization: "denied"/);

  for (const entrypoint of staticEntrypoints) {
    assert.match(entrypoint, /googletagmanager\.com\/gtag\/js/);
    assert.match(entrypoint, /G-8R17J8CJ1W/);
    assert.match(entrypoint, /signalRadarAnalyticsReady = true/);
  }
});

test("tracks Radar page views and article opens", () => {
  assert.match(pageSource, /trackPageView/);
  assert.match(pageSource, /article_open/);
  assert.match(pageSource, /content_type/);
});
