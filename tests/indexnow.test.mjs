import assert from "node:assert/strict";
import test from "node:test";

import {
  indexNowPayload,
  sitemapUrls,
} from "../scripts/submit-indexnow.mjs";

test("IndexNow submission only includes canonical All We Need sitemap URLs", () => {
  const urls = sitemapUrls(`
    <urlset>
      <url><loc>https://allweneed.info/</loc></url>
      <url><loc>https://allweneed.info/focus/example/</loc></url>
      <url><loc>https://example.com/not-ours</loc></url>
    </urlset>
  `);
  assert.deepEqual(urls, [
    "https://allweneed.info/",
    "https://allweneed.info/focus/example/",
  ]);
  const payload = indexNowPayload([...urls, urls[0]]);
  assert.equal(payload.host, "allweneed.info");
  assert.equal(payload.urlList.length, 2);
  assert.match(payload.keyLocation, /^https:\/\/allweneed\.info\/[a-z0-9]+\.txt$/);
});
