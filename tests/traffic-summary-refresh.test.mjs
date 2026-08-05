import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  trafficDateRange,
  trafficSummaryFromReport,
} from "../scripts/refresh-traffic-summary.mjs";

test("includes today's visits in the public 30-day summary", () => {
  assert.deepEqual(trafficDateRange, {
    startDate: "30daysAgo",
    endDate: "today",
  });
});

test("converts GA4 country rows and grand totals into the public summary", () => {
  const summary = trafficSummaryFromReport(
    {
      rows: [
        {
          dimensionValues: [{ value: "US" }, { value: "United States" }],
          metricValues: [{ value: "120" }, { value: "9" }],
        },
        {
          dimensionValues: [{ value: "KR" }, { value: "South Korea" }],
          metricValues: [{ value: "30" }, { value: "2" }],
        },
      ],
      totals: [
        {
          metricValues: [{ value: "150" }, { value: "10" }],
        },
      ],
    },
    "2026-08-04T12:00:00.000Z",
  );

  assert.equal(summary.pageViews, 150);
  assert.equal(summary.activeUsers, 10);
  assert.equal(summary.countryCount, 2);
  assert.equal(summary.countries[0].nameEn, "United States");
  assert.equal(summary.countries[0].nameZh, "美国");
  assert.deepEqual(
    [summary.countries[1].latitude, summary.countries[1].longitude],
    [35.9078, 127.7669],
  );
  assert.deepEqual(summary.period, {
    labelZh: "最近 30 天",
    labelEn: "Last 30 days",
  });
});

test("actual Live and full publications refresh traffic before building", async () => {
  const runner = await readFile(
    new URL("../scripts/run-feed-cycle.mjs", import.meta.url),
    "utf8",
  );
  const calls = runner.match(
    /runCommand\("npm", \["run", "refresh:traffic"\]/g,
  );
  assert.equal(calls?.length, 2);
  assert.match(
    runner,
    /\["data\/live-feed\.json", "data\/traffic-summary\.json"\]/,
  );
});
