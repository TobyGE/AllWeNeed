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

test("configures production-only GA4 analytics", () => {
  assert.match(analyticsSource, /G-6KK2W66GZC/);
  assert.match(analyticsSource, /yingqiangge\.github\.io/);
  assert.match(analyticsSource, /send_page_view: false/);
  assert.match(analyticsSource, /globalPrivacyControl/);
});

test("tracks Radar page views and article opens", () => {
  assert.match(pageSource, /trackPageView/);
  assert.match(pageSource, /article_open/);
  assert.match(pageSource, /content_type/);
});
