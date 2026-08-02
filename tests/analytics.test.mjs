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

test("configures the dedicated All We Need GA4 property on production hosts", () => {
  assert.match(analyticsSource, /G-8R17J8CJ1W/);
  assert.match(analyticsSource, /allweneed\.info/);
  assert.match(analyticsSource, /yingqiangge\.github\.io/);
  assert.match(analyticsSource, /send_page_view: false/);
  assert.match(analyticsSource, /globalPrivacyControl/);
});

test("tracks Radar page views and article opens", () => {
  assert.match(pageSource, /trackPageView/);
  assert.match(pageSource, /article_open/);
  assert.match(pageSource, /content_type/);
});
