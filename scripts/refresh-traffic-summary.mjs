import { spawnSync } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(projectRoot, "data/traffic-summary.json");
const propertyId = process.env.GA4_PROPERTY_ID ?? "548148776";
export const trafficDateRange = {
  startDate: "30daysAgo",
  endDate: "today",
};

const countryCentroids = {
  AU: [-25.2744, 133.7751],
  BR: [-14.235, -51.9253],
  CA: [56.1304, -106.3468],
  CH: [46.8182, 8.2275],
  CN: [35.8617, 104.1954],
  DE: [51.1657, 10.4515],
  ES: [40.4637, -3.7492],
  FR: [46.2276, 2.2137],
  GB: [55.3781, -3.436],
  HK: [22.3193, 114.1694],
  ID: [-0.7893, 113.9213],
  IE: [53.1424, -7.6921],
  IN: [20.5937, 78.9629],
  IT: [41.8719, 12.5674],
  JP: [36.2048, 138.2529],
  KR: [35.9078, 127.7669],
  MX: [23.6345, -102.5528],
  NL: [52.1326, 5.2913],
  NZ: [-40.9006, 174.886],
  PL: [51.9194, 19.1451],
  RU: [61.524, 105.3188],
  SE: [60.1282, 18.6435],
  SG: [1.3521, 103.8198],
  TW: [23.6978, 120.9605],
  US: [39.8283, -98.5795],
  VN: [14.0583, 108.2772],
  ZA: [-30.5595, 22.9375],
};

function metricNumber(row, index) {
  return Number(row?.metricValues?.[index]?.value ?? 0);
}

export function trafficSummaryFromReport(
  report,
  generatedAt = new Date().toISOString(),
) {
  const chineseRegionNames = new Intl.DisplayNames(["zh-CN"], {
    type: "region",
  });
  const countries = (report.rows ?? [])
    .map((row) => {
      const countryId = row.dimensionValues?.[0]?.value?.toUpperCase() ?? "";
      const nameEn = row.dimensionValues?.[1]?.value ?? countryId;
      if (!/^[A-Z]{2}$/.test(countryId)) return null;
      const centroid = countryCentroids[countryId] ?? [null, null];
      return {
        nameZh: chineseRegionNames.of(countryId) ?? nameEn,
        nameEn,
        latitude: centroid[0],
        longitude: centroid[1],
        activeUsers: metricNumber(row, 1),
      };
    })
    .filter(Boolean)
    .sort(
      (left, right) =>
        right.activeUsers - left.activeUsers ||
        left.nameEn.localeCompare(right.nameEn),
    );

  const total = report.totals?.[0];
  const pageViews = total
    ? metricNumber(total, 0)
    : (report.rows ?? []).reduce(
        (sum, row) => sum + metricNumber(row, 0),
        0,
      );
  const activeUsers = total
    ? metricNumber(total, 1)
    : countries.reduce((sum, country) => sum + country.activeUsers, 0);

  return {
    generatedAt,
    period: {
      labelZh: "最近 30 天",
      labelEn: "Last 30 days",
    },
    activeUsers,
    pageViews,
    countryCount: countries.length,
    countries,
  };
}

async function firstAccessible(paths) {
  for (const path of paths) {
    try {
      await access(path);
      return path;
    } catch {
      // Try the next supported installation location.
    }
  }
  return null;
}

async function accessToken() {
  if (process.env.GA4_ACCESS_TOKEN) return process.env.GA4_ACCESS_TOKEN;
  const gcloud = await firstAccessible([
    "/usr/local/bin/gcloud",
    "/opt/homebrew/bin/gcloud",
    "/usr/local/share/google-cloud-sdk/bin/gcloud",
    "/opt/homebrew/share/google-cloud-sdk/bin/gcloud",
  ]);
  if (!gcloud) {
    throw new Error(
      "GA4 refresh requires GA4_ACCESS_TOKEN or Google Cloud CLI.",
    );
  }
  const result = spawnSync(
    gcloud,
    ["auth", "application-default", "print-access-token"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error(
      `Unable to obtain a renewable GA4 access token: ${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
}

export async function refreshTrafficSummary({
  fetchImpl = fetch,
  now = new Date(),
} = {}) {
  const token = await accessToken();
  const response = await fetchImpl(
    `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        dateRanges: [trafficDateRange],
        dimensions: [{ name: "countryId" }, { name: "country" }],
        metrics: [{ name: "screenPageViews" }, { name: "activeUsers" }],
        metricAggregations: ["TOTAL"],
        orderBys: [
          { metric: { metricName: "activeUsers" }, desc: true },
        ],
        limit: 250,
      }),
    },
  );
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `GA4 Data API returned ${response.status}: ${detail.slice(0, 1000)}`,
    );
  }
  const summary = trafficSummaryFromReport(
    await response.json(),
    now.toISOString(),
  );
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(
    `Updated GA4 traffic summary: ${summary.pageViews} views, ${summary.activeUsers} visitors, ${summary.countryCount} countries.`,
  );
  return summary;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await refreshTrafficSummary();
}
