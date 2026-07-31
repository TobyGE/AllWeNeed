import assert from "node:assert/strict";
import test from "node:test";

import {
  extractSecMetricRecords,
  extractSecMetrics,
  selectSecFactEntry,
} from "../scripts/fetch-sources.mjs";

const accessionNumber = "0001018724-26-000026";

function fact(entries, unit = "USD") {
  return { units: { [unit]: entries } };
}

test("SEC facts select the filing report period instead of its comparative period", () => {
  const revenueFact = fact([
    {
      accn: accessionNumber,
      start: "2025-04-01",
      end: "2025-06-30",
      filed: "2026-07-30",
      val: 167_700_000_000,
    },
    {
      accn: accessionNumber,
      start: "2026-04-01",
      end: "2026-06-30",
      filed: "2026-07-30",
      val: 200_600_000_000,
    },
  ]);

  const selected = selectSecFactEntry(
    revenueFact,
    accessionNumber,
    "10-Q",
    "2026-06-30",
  );

  assert.equal(selected?.end, "2026-06-30");
  assert.equal(selected?.val, 200_600_000_000);
});

test("SEC facts do not fall back to a different period when report date is known", () => {
  const comparativeOnly = fact([
    {
      accn: accessionNumber,
      start: "2025-04-01",
      end: "2025-06-30",
      filed: "2026-07-30",
      val: 167_700_000_000,
    },
  ]);

  assert.equal(
    selectSecFactEntry(
      comparativeOnly,
      accessionNumber,
      "10-Q",
      "2026-06-30",
    ),
    null,
  );
});

test("Amazon-like 10-Q metrics consistently use the current quarter", () => {
  const currentAndComparative = (current, comparative, unit = "USD") =>
    fact(
      [
        {
          accn: accessionNumber,
          start: "2025-04-01",
          end: "2025-06-30",
          filed: "2026-07-30",
          val: comparative,
        },
        {
          accn: accessionNumber,
          start: "2026-04-01",
          end: "2026-06-30",
          filed: "2026-07-30",
          val: current,
        },
      ],
      unit,
    );
  const companyFacts = {
    facts: {
      "us-gaap": {
        RevenueFromContractWithCustomerExcludingAssessedTax:
          currentAndComparative(200_600_000_000, 167_700_000_000),
        NetIncomeLoss: currentAndComparative(
          62_600_000_000,
          18_160_000_000,
        ),
        OperatingIncomeLoss: currentAndComparative(
          27_500_000_000,
          19_170_000_000,
        ),
        EarningsPerShareDiluted: currentAndComparative(
          5.75,
          1.68,
          "USD/shares",
        ),
      },
    },
  };

  const records = extractSecMetricRecords(
    companyFacts,
    accessionNumber,
    "10-Q",
    "2026-06-30",
  );
  assert.deepEqual(
    records.map(({ label, value, end }) => ({ label, value, end })),
    [
      { label: "Revenue", value: 200_600_000_000, end: "2026-06-30" },
      { label: "Net income", value: 62_600_000_000, end: "2026-06-30" },
      {
        label: "Operating income",
        value: 27_500_000_000,
        end: "2026-06-30",
      },
      { label: "Diluted EPS", value: 5.75, end: "2026-06-30" },
    ],
  );
  assert.deepEqual(
    extractSecMetrics(
      companyFacts,
      accessionNumber,
      "10-Q",
      "2026-06-30",
    ),
    [
      "Revenue: $200.6B",
      "Net income: $62.6B",
      "Operating income: $27.5B",
      "Diluted EPS: $5.75",
    ],
  );
});
