import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getSourceKind,
  sourceCatalog,
} from "../app/source-catalog.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(projectRoot, "data/feed-snapshot.json");
const checkedAt = new Date().toISOString();
const xBearerToken = process.env.X_BEARER_TOKEN?.trim();
const concurrency = 5;
const itemsPerSource = 12;

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

async function fetchText(url, timeoutMs = 10_000) {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      accept:
        "application/atom+xml, application/rss+xml, application/xml, text/xml, text/html;q=0.8, */*;q=0.5",
      "user-agent":
        "SignalRadar/0.1 (+local research feed reader; contact: local-user)",
    },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return {
    text: await response.text(),
    contentType: response.headers.get("content-type") ?? "",
    finalUrl: response.url,
  };
}

function successStatus(source, feedUrl, itemCount) {
  return {
    sourceId: source.id,
    name: source.name,
    kind: getSourceKind(source.url),
    status: itemCount ? "ok" : "empty",
    feedUrl,
    itemCount,
    message: itemCount ? "抓取成功" : "Feed 暂无内容",
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

async function fetchFeedSource(source) {
  const kind = getSourceKind(source.url);
  if (kind === "X") return fetchXSource(source);

  try {
    let directCandidates = source.feedUrl ? [source.feedUrl] : [];
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
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const result = await fetchText(
            candidate,
            source.feedUrl || kind === "YouTube" ? 25_000 : 15_000,
          );
          const items = parseFeed(result.text, source, result.finalUrl);
          if (looksLikeFeed(result.text, result.contentType)) {
            return {
              items,
              status: successStatus(source, result.finalUrl, items.length),
            };
          }
        } catch {
          if (attempt === 1) {
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
          }
        }
      }
    }

    const homepage = await fetchText(source.url);
    if (looksLikeFeed(homepage.text, homepage.contentType)) {
      const items = parseFeed(homepage.text, source, homepage.finalUrl);
      return {
        items,
        status: successStatus(source, homepage.finalUrl, items.length),
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
          status: successStatus(source, result.finalUrl, items.length),
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

const results = await mapWithConcurrency(
  sourceCatalog,
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
  totalSources: sourceCatalog.length,
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

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

console.log(
  `Done: ${snapshot.successfulSources} sources connected, ${snapshot.items.length} items, ${snapshot.needsAuthSources} need auth, ${snapshot.failedSources} failed.`,
);
