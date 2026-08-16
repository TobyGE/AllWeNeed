import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  trafficDateRange,
  trafficSummaryFromReport,
} from "../scripts/refresh-traffic-summary.mjs";

test("includes today's visits after the verified external baseline", () => {
  assert.deepEqual(trafficDateRange, {
    startDate: "2026-08-16",
    endDate: "today",
  });
});

test("merges new external traffic with the verified historical baseline", () => {
  const summary = trafficSummaryFromReport(
    {
      rows: [
        {
          dimensionValues: [{ value: "US" }, { value: "United States" }],
          metricValues: [
            { value: "12" },
            { value: "4" },
            { value: "2" },
          ],
        },
        {
          dimensionValues: [{ value: "KR" }, { value: "South Korea" }],
          metricValues: [
            { value: "3" },
            { value: "1" },
            { value: "1" },
          ],
        },
      ],
      totals: [
        {
          metricValues: [
            { value: "15" },
            { value: "5" },
            { value: "3" },
          ],
        },
      ],
    },
    "2026-08-04T12:00:00.000Z",
    {
      countedSince: "2026-08-02",
      activeUsers: 10,
      sessions: 20,
      pageViews: 40,
      countries: [
        {
          countryId: "US",
          nameEn: "United States",
          activeUsers: 8,
          sessions: 18,
          pageViews: 35,
        },
      ],
    },
  );

  assert.equal(summary.pageViews, 55);
  assert.equal(summary.sessions, 25);
  assert.equal(summary.activeUsers, 13);
  assert.equal(summary.countryCount, 2);
  assert.equal(summary.countries[0].nameEn, "United States");
  assert.equal(summary.countries[0].nameZh, "美国");
  assert.deepEqual(
    [summary.countries[1].latitude, summary.countries[1].longitude],
    [35.9078, 127.7669],
  );
  assert.match(summary.period.labelZh, /真实外部访问/);
  assert.match(summary.period.labelEn, /Verified external traffic/);
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
