import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const summary = JSON.parse(
  await readFile(new URL("../data/traffic-summary.json", import.meta.url)),
);
const pageSource = await readFile(
  new URL("../app/page.tsx", import.meta.url),
  "utf8",
);
const styles = await readFile(
  new URL("../app/globals.css", import.meta.url),
  "utf8",
);

test("publishes country aggregates without city-level data", () => {
  assert.equal(summary.countryCount, summary.countries.length);
  assert.equal("cities" in summary, false);
  assert.ok(summary.activeUsers >= 0);
  assert.ok(summary.pageViews >= 0);
  assert.ok(
    summary.countries.every(
      (country) =>
        country.activeUsers >= 0 &&
        (country.latitude === null || Number.isFinite(country.latitude)) &&
        (country.longitude === null || Number.isFinite(country.longitude)),
    ),
  );
});

test("renders the visitor map in the desktop sidebar only", () => {
  assert.match(pageSource, /<VisitorMap/);
  assert.match(styles, /\.visitor-map-card/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*?\.sidebar \{\s*display: none;/);
});
