import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getSourceKind,
  sourceCatalog,
} from "../app/source-catalog.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const canonicalOutputPath = resolve(projectRoot, "data/feed-snapshot.json");
const outputArgument = process.argv.find((argument) =>
  argument.startsWith("--output="),
);
const outputPath = outputArgument
  ? resolve(projectRoot, outputArgument.split("=", 2)[1])
  : canonicalOutputPath;
const checkedAt = new Date().toISOString();
const xBearerToken = process.env.X_BEARER_TOKEN?.trim();
const concurrency = 5;
const itemsPerSource = 12;
const dryRun = process.argv.includes("--dry-run");
const sourceIdsArgument = process.argv.find((argument) =>
  argument.startsWith("--source-ids="),
);
const selectedSourceIds = new Set(
  (sourceIdsArgument?.split("=", 2)[1] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map(Number)
    .filter(Number.isInteger),
);
if (selectedSourceIds.size && !dryRun) {
  throw new Error("--source-ids 只能与 --dry-run 一起使用，避免局部覆盖完整快照");
}
const crawlerUserAgent =
  "SignalRadar/1.0 gyq1101@gmail.com";
let secRequestGate = Promise.resolve();
let secLastRequestAt = 0;

let previousSnapshot = { items: [], statuses: [] };
try {
  previousSnapshot = JSON.parse(await readFile(canonicalOutputPath, "utf8"));
} catch {
  // The first run has no cache to reuse.
}

const previousStatuses = new Map(
  previousSnapshot.statuses.map((status) => [status.sourceId, status]),
);
const previousItems = new Map();
for (const item of previousSnapshot.items) {
  const sourceItems = previousItems.get(item.sourceId) ?? [];
  sourceItems.push(item);
  previousItems.set(item.sourceId, sourceItems);
}

function decodeEntities(value = "") {
  const named = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&([a-z]+);/gi, (match, name) => named[name] ?? match);
}

function cleanText(value = "") {
  return decodeEntities(value)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tagValue(block, names) {
  for (const name of names) {
    const escaped = name.replace(":", "\\:");
    const match = block.match(
      new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, "i"),
    );
    if (match?.[1]) return match[1];
  }
  return "";
}

function normalizeDate(value) {
  if (!value) return null;
  const parsed = new Date(cleanText(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function absoluteUrl(value, baseUrl) {
  const cleaned = cleanText(value);
  if (!cleaned) return null;
  try {
    return new URL(cleaned, baseUrl).toString();
  } catch {
    return null;
  }
}

function parseFeed(xml, source, feedUrl) {
  const itemBlocks = [
    ...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi),
  ].map((match) => match[1]);
  const entryBlocks = [
    ...xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi),
  ].map((match) => match[1]);
  const blocks = itemBlocks.length ? itemBlocks : entryBlocks;
  const sourceKind = getSourceKind(source.url);

  return blocks.slice(0, itemsPerSource).flatMap((block, index) => {
    const title = cleanText(tagValue(block, ["title"]));
    const rssLink = tagValue(block, ["link", "guid"]);
    const atomLink =
      block.match(/<link[^>]+href=["']([^"']+)["'][^>]*>/i)?.[1] ?? "";
    const url = absoluteUrl(atomLink || rssLink, feedUrl);
    if (!title || !url) return [];

    const publishedAt = normalizeDate(
      tagValue(block, ["pubDate", "published", "updated", "dc:date"]),
    );
    const summary = cleanText(
      tagValue(block, ["description", "summary", "content:encoded", "content"]),
    ).slice(0, 360);

    return [
      {
        id: `${source.id}-${index}-${url}`,
        sourceId: source.id,
        sourceName: source.name,
        sourcePublisher: source.publisher ?? source.name,
        sourceKind,
        title,
        url,
        publishedAt,
        summary,
        fetchedAt: checkedAt,
      },
    ];
  });
}

function parseYouTubeRelativeDate(value) {
  if (!value) return null;
  const match = value.match(
    /(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago/i,
  );
  if (!match) return null;
  const amount = Number(match[1]);
  const unitMs = {
    minute: 60_000,
    hour: 3_600_000,
    day: 86_400_000,
    week: 7 * 86_400_000,
    month: 30 * 86_400_000,
    year: 365 * 86_400_000,
  };
  return new Date(
    new Date(checkedAt).getTime() - amount * unitMs[match[2].toLowerCase()],
  ).toISOString();
}

function youtubeText(value) {
  if (typeof value?.simpleText === "string") return value.simpleText;
  if (Array.isArray(value?.runs)) {
    return value.runs.map((run) => run.text ?? "").join("");
  }
  return "";
}

function extractYouTubeInitialData(html) {
  const markers = [
    "var ytInitialData = ",
    'window["ytInitialData"] = ',
    "ytInitialData = ",
  ];
  for (const marker of markers) {
    const start = html.indexOf(marker);
    if (start < 0) continue;
    const jsonStart = start + marker.length;
    const jsonEnd = html.indexOf(";</script>", jsonStart);
    if (jsonEnd < 0) continue;
    try {
      return JSON.parse(html.slice(jsonStart, jsonEnd));
    } catch {
      // Try the next assignment form.
    }
  }
  return null;
}

function parseYouTubePage(html, source) {
  const data = extractYouTubeInitialData(html);
  if (!data) return [];

  const items = [];
  const seenVideoIds = new Set();

  function addItem(videoId, title, publishedText = "", summary = "") {
    if (!videoId || !title || seenVideoIds.has(videoId)) return;
    seenVideoIds.add(videoId);
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    items.push({
      id: `${source.id}-${videoId}`,
      sourceId: source.id,
      sourceName: source.name,
      sourcePublisher: source.publisher ?? source.name,
      sourceKind: "YouTube",
      title: cleanText(title),
      url,
      publishedAt: parseYouTubeRelativeDate(publishedText),
      summary: cleanText(summary || title).slice(0, 360),
      fetchedAt: checkedAt,
    });
  }

  const stack = [data];
  while (stack.length && items.length < itemsPerSource) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;

    const lockup = node.lockupViewModel;
    if (
      lockup?.contentId &&
      (!lockup.contentType || lockup.contentType.includes("VIDEO"))
    ) {
      const metadata = lockup.metadata?.lockupMetadataViewModel;
      const rows =
        metadata?.metadata?.contentMetadataViewModel?.metadataRows ?? [];
      const publishedText = rows
        .flatMap((row) => row.metadataParts ?? [])
        .map((part) => part.text?.content ?? part.text?.accessibilityLabel ?? "")
        .find((text) => /\bago\b/i.test(text));
      addItem(
        lockup.contentId,
        metadata?.title?.content,
        publishedText,
      );
    }

    for (const renderer of [
      node.videoRenderer,
      node.gridVideoRenderer,
      node.playlistVideoRenderer,
    ]) {
      if (!renderer) continue;
      addItem(
        renderer.videoId,
        youtubeText(renderer.title),
        youtubeText(renderer.publishedTimeText),
        youtubeText(renderer.descriptionSnippet),
      );
    }

    const values = Object.values(node);
    for (let index = values.length - 1; index >= 0; index -= 1) {
      const value = values[index];
      if (value && typeof value === "object") stack.push(value);
    }
  }

  return items;
}

function looksLikeFeed(text, contentType = "") {
  const start = text.slice(0, 800).toLowerCase();
  return (
    contentType.includes("xml") ||
    start.includes("<rss") ||
    start.includes("<feed") ||
    start.includes("<rdf:rdf")
  );
}

function discoverFeedUrls(html, pageUrl) {
  const found = [];
  const linkPattern = /<link\b[^>]*>/gi;
  for (const match of html.matchAll(linkPattern)) {
    const tag = match[0];
    const rel = tag.match(/\brel=["']([^"']+)["']/i)?.[1] ?? "";
    const type = tag.match(/\btype=["']([^"']+)["']/i)?.[1] ?? "";
    const href = tag.match(/\bhref=["']([^"']+)["']/i)?.[1] ?? "";
    if (
      href &&
      rel.toLowerCase().includes("alternate") &&
      /(rss|atom|xml)/i.test(type)
    ) {
      const url = absoluteUrl(href, pageUrl);
      if (url) found.push(url);
    }
  }
  return [...new Set(found)];
}

function commonFeedUrls(sourceUrl) {
  const url = new URL(sourceUrl);
  const origin = url.origin;
  const path = url.pathname.replace(/\/$/, "");
  const base = path && path !== "/" ? `${origin}${path}` : origin;
  return [
    `${base}/feed`,
    `${base}/feed.xml`,
    `${base}/index.xml`,
    `${base}/rss.xml`,
    `${base}/atom.xml`,
  ];
}

async function fetchText(url, timeoutMs = 10_000, validators = {}) {
  const headers = {
    accept:
      "application/json, application/atom+xml, application/rss+xml, application/xml, text/xml, text/html;q=0.8, */*;q=0.5",
    "user-agent": crawlerUserAgent,
  };
  if (validators.etag) headers["if-none-match"] = validators.etag;
  if (validators.lastModified) {
    headers["if-modified-since"] = validators.lastModified;
  }
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
    headers,
  });
  if (response.status === 304) {
    return {
      text: "",
      contentType: response.headers.get("content-type") ?? "",
      finalUrl: url,
      notModified: true,
      etag: validators.etag ?? null,
      lastModified: validators.lastModified ?? null,
    };
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return {
    text: await response.text(),
    contentType: response.headers.get("content-type") ?? "",
    finalUrl: response.url,
    notModified: false,
    etag: response.headers.get("etag"),
    lastModified: response.headers.get("last-modified"),
  };
}

async function fetchSecText(url, timeoutMs = 25_000, validators = {}) {
  const turn = secRequestGate.then(async () => {
    const waitMs = Math.max(0, 150 - (Date.now() - secLastRequestAt));
    if (waitMs) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, waitMs));
    }
    secLastRequestAt = Date.now();
  });
  secRequestGate = turn.catch(() => {});
  await turn;

  try {
    return await fetchText(url, timeoutMs, validators);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("HTTP 403")) {
      throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
    return fetchText(url, timeoutMs, validators);
  }
}

function successStatus(source, feedUrl, itemCount, metadata = {}) {
  return {
    sourceId: source.id,
    name: source.name,
    kind: getSourceKind(source.url),
    status: itemCount ? "ok" : "empty",
    feedUrl,
    requestUrl: metadata.requestUrl ?? feedUrl,
    etag: metadata.etag ?? null,
    lastModified: metadata.lastModified ?? null,
    itemCount,
    message:
      metadata.message ?? (itemCount ? "抓取成功" : "订阅源暂无内容"),
    checkedAt,
  };
}

async function fetchXSource(source) {
  const username = new URL(source.url).pathname.split("/").filter(Boolean)[0];
  if (!xBearerToken) {
    return {
      items: [],
      status: {
        sourceId: source.id,
        name: source.name,
        kind: "X",
        status: "needs_auth",
        feedUrl: null,
        itemCount: 0,
        message: "需要 X_BEARER_TOKEN",
        checkedAt,
      },
    };
  }

  try {
    const headers = { Authorization: `Bearer ${xBearerToken}` };
    const userResponse = await fetch(
      `https://api.x.com/2/users/by/username/${encodeURIComponent(username)}`,
      { headers, signal: AbortSignal.timeout(10_000) },
    );
    if (!userResponse.ok) throw new Error(`X user lookup HTTP ${userResponse.status}`);
    const userPayload = await userResponse.json();
    const userId = userPayload.data?.id;
    if (!userId) throw new Error("X user ID missing");

    const postsResponse = await fetch(
      `https://api.x.com/2/users/${userId}/tweets?max_results=10&exclude=replies,retweets&tweet.fields=created_at`,
      { headers, signal: AbortSignal.timeout(10_000) },
    );
    if (!postsResponse.ok) throw new Error(`X timeline HTTP ${postsResponse.status}`);
    const postsPayload = await postsResponse.json();
    const items = (postsPayload.data ?? []).map((post) => ({
      id: `${source.id}-${post.id}`,
      sourceId: source.id,
      sourceName: source.name,
      sourcePublisher: source.publisher ?? source.name,
      sourceKind: "X",
      title: cleanText(post.text).slice(0, 180),
      url: `https://x.com/${username}/status/${post.id}`,
      publishedAt: normalizeDate(post.created_at),
      summary: cleanText(post.text).slice(0, 360),
      fetchedAt: checkedAt,
    }));
    return {
      items,
      status: successStatus(source, source.url, items.length),
    };
  } catch (error) {
    return {
      items: [],
      status: {
        sourceId: source.id,
        name: source.name,
        kind: "X",
        status: "error",
        feedUrl: null,
        itemCount: 0,
        message: error instanceof Error ? error.message : "X 抓取失败",
        checkedAt,
      },
    };
  }
}

const secFinancialConcepts = [
  {
    label: "Revenue",
    concepts: [
      ["us-gaap", "RevenueFromContractWithCustomerExcludingAssessedTax"],
      ["us-gaap", "Revenues"],
      ["us-gaap", "SalesRevenueNet"],
      ["ifrs-full", "Revenue"],
    ],
  },
  {
    label: "Net income",
    concepts: [
      ["us-gaap", "NetIncomeLoss"],
      ["ifrs-full", "ProfitLoss"],
    ],
  },
  {
    label: "Operating income",
    concepts: [
      ["us-gaap", "OperatingIncomeLoss"],
      ["ifrs-full", "ProfitLossFromOperatingActivities"],
    ],
  },
  {
    label: "Diluted EPS",
    concepts: [
      ["us-gaap", "EarningsPerShareDiluted"],
      ["ifrs-full", "DilutedEarningsLossPerShare"],
    ],
  },
  {
    label: "Operating cash flow",
    concepts: [
      ["us-gaap", "NetCashProvidedByUsedInOperatingActivities"],
      ["ifrs-full", "CashFlowsFromUsedInOperatingActivities"],
    ],
  },
];

function secFilingUrl(cik, accessionNumber, primaryDocument) {
  const cikWithoutLeadingZeros = String(Number(cik));
  const accessionPath = accessionNumber.replaceAll("-", "");
  return `https://www.sec.gov/Archives/edgar/data/${cikWithoutLeadingZeros}/${accessionPath}/${primaryDocument}`;
}

function secDuration(entry) {
  if (!entry.start || !entry.end) return null;
  const duration = Date.parse(entry.end) - Date.parse(entry.start);
  return Number.isFinite(duration) ? duration : null;
}

function selectSecFactEntry(fact, accessionNumber, form) {
  const candidates = Object.entries(fact?.units ?? {}).flatMap(
    ([unit, entries]) =>
      entries
        .filter((entry) => entry.accn === accessionNumber)
        .map((entry) => ({ ...entry, unit })),
  );
  if (!candidates.length) return null;

  const annual = form.startsWith("10-K") || form.startsWith("20-F");
  return candidates.sort((left, right) => {
    const leftDuration = secDuration(left);
    const rightDuration = secDuration(right);
    if (leftDuration === null && rightDuration === null) return 0;
    if (leftDuration === null) return 1;
    if (rightDuration === null) return -1;
    return annual
      ? rightDuration - leftDuration
      : leftDuration - rightDuration;
  })[0];
}

function formatSecValue(value, unit) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return String(value ?? "");
  }
  if (unit === "USD") {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      notation: "compact",
      maximumFractionDigits: 2,
    }).format(value);
  }
  if (unit === "USD/shares") return `$${value.toFixed(2)}`;
  return new Intl.NumberFormat("en-US", {
    notation: Math.abs(value) >= 1_000_000 ? "compact" : "standard",
    maximumFractionDigits: 2,
  }).format(value);
}

function extractSecMetrics(companyFacts, accessionNumber, form) {
  const facts = companyFacts?.facts ?? {};
  const metrics = [];
  for (const metric of secFinancialConcepts) {
    let selected = null;
    for (const [taxonomy, concept] of metric.concepts) {
      const entry = selectSecFactEntry(
        facts[taxonomy]?.[concept],
        accessionNumber,
        form,
      );
      if (entry) {
        selected = entry;
        break;
      }
    }
    if (!selected) continue;
    metrics.push(
      `${metric.label}: ${formatSecValue(selected.val, selected.unit)}`,
    );
    if (metrics.length === 4) break;
  }
  return metrics;
}

function isEarningsFiling(form, filingItems = "") {
  const normalizedForm = form.replace(/\/A$/, "");
  if (["10-K", "10-Q", "20-F", "6-K"].includes(normalizedForm)) {
    return true;
  }
  return (
    normalizedForm === "8-K" &&
    filingItems
      .split(",")
      .map((item) => item.trim())
      .includes("2.02")
  );
}

async function fetchSecSource(source) {
  const previousStatus = previousStatuses.get(source.id);
  const cachedItems = previousItems.get(source.id) ?? [];
  const submissionsUrl = `https://data.sec.gov/submissions/CIK${source.secCik}.json`;

  try {
    const submissions = await fetchSecText(
      submissionsUrl,
      25_000,
      previousStatus?.requestUrl === submissionsUrl
        ? {
            etag: previousStatus.etag,
            lastModified: previousStatus.lastModified,
          }
        : {},
    );
    if (submissions.notModified) {
      return {
        items: cachedItems,
        status: successStatus(
          source,
          previousStatus?.feedUrl ?? submissionsUrl,
          cachedItems.length,
          {
            requestUrl: submissionsUrl,
            etag: submissions.etag,
            lastModified: submissions.lastModified,
            message: "SEC submissions 未变化，已复用缓存",
          },
        ),
      };
    }

    const payload = JSON.parse(submissions.text);
    const recent = payload.filings?.recent;
    if (!recent?.form) throw new Error("SEC submissions missing filings.recent");

    let companyFacts = null;
    let factsMessage = "";
    try {
      const factsResponse = await fetchSecText(
        `https://data.sec.gov/api/xbrl/companyfacts/CIK${source.secCik}.json`,
        30_000,
      );
      companyFacts = JSON.parse(factsResponse.text);
    } catch (error) {
      factsMessage =
        error instanceof Error ? `；XBRL 暂不可用：${error.message}` : "";
    }

    const items = [];
    for (
      let index = 0;
      index < recent.form.length && items.length < itemsPerSource;
      index += 1
    ) {
      const form = recent.form[index] ?? "";
      const filingItems = recent.items?.[index] ?? "";
      if (!isEarningsFiling(form, filingItems)) continue;

      const accessionNumber = recent.accessionNumber[index];
      const primaryDocument = recent.primaryDocument[index];
      if (!accessionNumber || !primaryDocument) continue;

      const reportDate = recent.reportDate?.[index] || recent.filingDate[index];
      const filingDate = recent.filingDate[index];
      const metrics = companyFacts
        ? extractSecMetrics(companyFacts, accessionNumber, form)
        : [];
      const itemDetails = filingItems ? ` SEC items ${filingItems}.` : "";
      const metricDetails = metrics.length
        ? ` Reported XBRL facts: ${metrics.join("; ")}.`
        : "";
      const tickerLabel = source.ticker ? `${source.ticker} ` : "";

      items.push({
        id: `${source.id}-${accessionNumber}`,
        sourceId: source.id,
        sourceName: source.name,
        sourcePublisher: source.publisher ?? source.name,
        sourceKind: "SEC",
        title: `${tickerLabel}${form} filing — period ended ${reportDate}`,
        url: secFilingUrl(
          source.secCik,
          accessionNumber,
          primaryDocument,
        ),
        publishedAt:
          normalizeDate(recent.acceptanceDateTime?.[index]) ??
          normalizeDate(filingDate),
        summary: cleanText(
          `${payload.name} filed ${form} with the SEC for the period ended ${reportDate}.${itemDetails}${metricDetails}`,
        ).slice(0, 420),
        fetchedAt: checkedAt,
      });
    }

    return {
      items,
      status: successStatus(source, submissionsUrl, items.length, {
        requestUrl: submissionsUrl,
        etag: submissions.etag,
        lastModified: submissions.lastModified,
        message: items.length
          ? `SEC filings 与 XBRL 抓取成功${factsMessage}`
          : "SEC 暂无匹配的财报披露",
      }),
    };
  } catch (error) {
    if (cachedItems.length) {
      return {
        items: cachedItems,
        status: successStatus(
          source,
          previousStatus?.feedUrl ?? submissionsUrl,
          cachedItems.length,
          {
            requestUrl: submissionsUrl,
            etag: previousStatus?.etag,
            lastModified: previousStatus?.lastModified,
            message: `SEC 暂时不可用，已复用缓存：${
              error instanceof Error ? error.message : "抓取失败"
            }`,
          },
        ),
      };
    }
    return {
      items: [],
      status: {
        sourceId: source.id,
        name: source.name,
        kind: "SEC",
        status: "error",
        feedUrl: submissionsUrl,
        requestUrl: submissionsUrl,
        itemCount: 0,
        message: error instanceof Error ? error.message : "SEC 抓取失败",
        checkedAt,
      },
    };
  }
}

async function fetchFeedSource(source) {
  const kind = getSourceKind(source.url);
  if (kind === "X") return fetchXSource(source);
  if (kind === "SEC") return fetchSecSource(source);
  const previousStatus = previousStatuses.get(source.id);
  const cachedItems = previousItems.get(source.id) ?? [];

  try {
    let directCandidates = source.feedUrl ? [source.feedUrl] : [];
    let directFailureMessage = "";
    if (kind === "YouTube") {
      const channelId = new URL(source.url).pathname.split("/").filter(Boolean).at(-1);
      directCandidates.push(
        `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`,
      );
    } else if (source.name === "Hacker News") {
      directCandidates.push("https://hnrss.org/best");
    } else if (source.name === "Product Hunt") {
      directCandidates.push("https://www.producthunt.com/feed");
    } else if (new URL(source.url).hostname.includes("substack.com")) {
      directCandidates.push(`${source.url.replace(/\/$/, "")}/feed`);
    }
    directCandidates = [...new Set(directCandidates)];

    for (const candidate of directCandidates) {
      const maxAttempts = kind === "YouTube" ? 1 : 2;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const canRevalidate =
            previousStatus?.requestUrl === candidate ||
            previousStatus?.feedUrl === candidate;
          const result = await fetchText(
            candidate,
            source.feedUrl || kind === "YouTube" ? 25_000 : 15_000,
            canRevalidate
              ? {
                  etag: previousStatus.etag,
                  lastModified: previousStatus.lastModified,
                }
              : {},
          );
          if (result.notModified) {
            return {
              items: cachedItems,
              status: successStatus(
                source,
                previousStatus.feedUrl ?? candidate,
                cachedItems.length,
                {
                  requestUrl: candidate,
                  etag: result.etag,
                  lastModified: result.lastModified,
                  message: "订阅源未变化，已复用缓存",
                },
              ),
            };
          }
          const items = parseFeed(result.text, source, result.finalUrl);
          if (looksLikeFeed(result.text, result.contentType)) {
            return {
              items,
              status: successStatus(source, result.finalUrl, items.length, {
                requestUrl: candidate,
                etag: result.etag,
                lastModified: result.lastModified,
              }),
            };
          }
        } catch (error) {
          directFailureMessage =
            error instanceof Error ? error.message : "订阅源抓取失败";
          if (attempt === 1) {
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
          }
        }
      }
    }

    if (source.feedUrl) {
      if (cachedItems.length) {
        return {
          items: cachedItems,
          status: successStatus(
            source,
            previousStatus?.feedUrl ?? source.feedUrl,
            cachedItems.length,
            {
              requestUrl: source.feedUrl,
              etag: previousStatus?.etag,
              lastModified: previousStatus?.lastModified,
              message: `订阅源暂时不可用，已复用上次缓存：${directFailureMessage}`,
            },
          ),
        };
      }
      return {
        items: [],
        status: {
          sourceId: source.id,
          name: source.name,
          kind,
          status: "error",
          feedUrl: source.feedUrl,
          itemCount: 0,
          message: `已配置订阅源暂时不可用：${directFailureMessage}`,
          checkedAt,
        },
      };
    }

    const homepageUrl =
      kind === "YouTube"
        ? `${source.url.replace(/\/$/, "")}/videos`
        : source.url;
    const homepage = await fetchText(
      homepageUrl,
      kind === "YouTube" ? 25_000 : 10_000,
    );
    if (kind === "YouTube") {
      const items = parseYouTubePage(homepage.text, source);
      if (items.length) {
        return {
          items,
          status: successStatus(source, homepage.finalUrl, items.length, {
            requestUrl: homepageUrl,
            etag: homepage.etag,
            lastModified: homepage.lastModified,
            message: "YouTube 公开频道页回退抓取成功",
          }),
        };
      }
      return {
        items: [],
        status: {
          sourceId: source.id,
          name: source.name,
          kind,
          status: "error",
          feedUrl: null,
          itemCount: 0,
          message: "YouTube Atom 与公开频道页回退均未返回内容",
          checkedAt,
        },
      };
    }

    if (looksLikeFeed(homepage.text, homepage.contentType)) {
      const items = parseFeed(homepage.text, source, homepage.finalUrl);
      return {
        items,
        status: successStatus(source, homepage.finalUrl, items.length, {
          requestUrl: homepageUrl,
          etag: homepage.etag,
          lastModified: homepage.lastModified,
        }),
      };
    }

    const discovered = discoverFeedUrls(homepage.text, homepage.finalUrl);
    const candidates = [
      ...discovered,
      ...commonFeedUrls(homepage.finalUrl),
    ].filter((value, index, array) => array.indexOf(value) === index);

    for (const candidate of candidates.slice(0, 6)) {
      try {
        const result = await fetchText(candidate, 8_000);
        if (!looksLikeFeed(result.text, result.contentType)) continue;
        const items = parseFeed(result.text, source, result.finalUrl);
        return {
          items,
          status: successStatus(source, result.finalUrl, items.length, {
            requestUrl: candidate,
            etag: result.etag,
            lastModified: result.lastModified,
          }),
        };
      } catch {
        // Try the next conventional feed URL.
      }
    }

    return {
      items: [],
      status: {
        sourceId: source.id,
        name: source.name,
        kind,
        status: "error",
        feedUrl: null,
        itemCount: 0,
        message: "未发现公开 RSS/Atom Feed",
        checkedAt,
      },
    };
  } catch (error) {
    return {
      items: [],
      status: {
        sourceId: source.id,
        name: source.name,
        kind,
        status: "error",
        feedUrl: null,
        itemCount: 0,
        message: error instanceof Error ? error.message : "抓取失败",
        checkedAt,
      },
    };
  }
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
      const completed = results.filter(Boolean).length;
      if (completed % 10 === 0 || completed === items.length) {
        console.log(`Fetched ${completed}/${items.length} sources`);
      }
    }
  }

  await Promise.all(Array.from({ length: limit }, () => run()));
  return results;
}

const sourcesToFetch = selectedSourceIds.size
  ? sourceCatalog.filter((source) => selectedSourceIds.has(source.id))
  : sourceCatalog;
const results = await mapWithConcurrency(
  sourcesToFetch,
  concurrency,
  fetchFeedSource,
);

const statuses = results.map((result) => result.status);
const items = results
  .flatMap((result) => result.items)
  .filter(
    (item, index, array) =>
      array.findIndex((candidate) => candidate.url === item.url) === index,
  )
  .sort((a, b) => {
    const aTime = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const bTime = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return bTime - aTime;
  });

const snapshot = {
  generatedAt: checkedAt,
  totalSources: sourcesToFetch.length,
  successfulSources: statuses.filter((status) =>
    ["ok", "empty"].includes(status.status),
  ).length,
  needsAuthSources: statuses.filter(
    (status) => status.status === "needs_auth",
  ).length,
  failedSources: statuses.filter((status) => status.status === "error").length,
  items,
  statuses,
};

if (!dryRun) {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

console.log(
  `${dryRun ? "Dry run" : "Done"}: ${snapshot.successfulSources} sources connected, ${snapshot.items.length} items, ${snapshot.needsAuthSources} need auth, ${snapshot.failedSources} failed.`,
);
if (dryRun) {
  console.log(
    JSON.stringify(
      {
        statuses: snapshot.statuses,
        sampleItems: snapshot.items.slice(0, 20),
      },
      null,
      2,
    ),
  );
}
