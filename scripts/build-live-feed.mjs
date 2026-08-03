import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  getSourceKind,
  sourceCatalog,
} from "../app/source-catalog.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultSnapshotPath = resolve(projectRoot, "data/feed-snapshot.json");
const defaultOutputPath = resolve(projectRoot, "data/live-feed.json");
const liveWindowHours = 6;
const futureToleranceHours = 1;
const directSourceLimit = 3;
const maximumLiveItems = 10;
const sourceById = new Map(sourceCatalog.map((source) => [source.id, source]));

const authoritativePublisherPattern =
  /\b(?:OpenAI|Anthropic|Google(?: DeepMind)?|Meta|Amazon|AWS|Microsoft|NVIDIA|AMD|Broadcom|TSMC|ASML|Lam Research|KLA|Apple|SpaceX|ByteDance Seed|DeepSeek|Hugging Face|Model Context Protocol|Alibaba|Qwen|Tencent(?: Hunyuan)?|Baidu|ERNIE|MiniMax|Moonshot|Kimi|Z\.ai|GLM|StepFun|Baichuan|01\.AI|Mistral|Cohere|xAI|Tesla|Oracle|Palantir|Federal Reserve|SEC|CISA|NIST)\b/iu;

const trustedNewsPublisherPattern =
  /\b(?:Nikkei Asia|The Verge|TechCrunch|VentureBeat|Ars Technica|WIRED|The Decoder|Bloomberg|BBC|Engadget|The Information|The Wall Street Journal|WSJ|Scientific American|Financial Times|Reuters|The New York Times|The Washington Post|CNBC|Axios|404 Media|Semafor|Platformer)\b/iu;

const materialEventPattern =
  /\b(?:launch(?:ed|ing)?|releas(?:e|ed|ing)|introduc(?:e|ed|ing)|available now|general availability|preview|beta|model|api|pricing|price cut|earnings|results|guidance|acquisition|merger|funding|security advisory|breach|incident|cve-\d+|vulnerability|regulation|enforcement|ban|sanction)\b|(?:正式发布|正式上线|推出|开放API|降价|财报|业绩|指引|收购|合并|融资|安全公告|漏洞|攻击|事故|监管决定|制裁)/iu;

const liveScopePattern =
  /\b(?:AI|artificial intelligence|agent(?:ic|s)?|LLMs?|GPT(?:-\d+(?:\.\d+)?)?|Claude|Gemini|Copilot|OpenAI|Anthropic|DeepMind|DeepSeek|language model|foundation model|inference|training|compute|GPU|accelerator|semiconductor|chip|silicon|cloud|data center|servers?|robot(?:ics)?|cybersecurity|security|quantum|SpaceX|satellite|launch vehicle)\b|(?:人工智能|智能体|大模型|语言模型|推理|训练|算力|芯片|半导体|云计算|数据中心|服务器|机器人|网络安全|量子|航天|卫星)/iu;

function argumentValue(name, fallback) {
  const prefix = `--${name}=`;
  const value = process.argv.find((argument) =>
    argument.startsWith(prefix),
  );
  return resolve(projectRoot, value ? value.slice(prefix.length) : fallback);
}

function parseTime(value) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

function canonicalUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (
        /^utm_/i.test(key) ||
        ["campaign", "ref", "source", "st"].includes(key.toLowerCase())
      ) {
        url.searchParams.delete(key);
      }
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function displayDomain(value) {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function isDiscoveryItem(item, configuredSource) {
  return Boolean(item.discoveryOnly || configuredSource?.discoveryOnly);
}

function normalizedTitle(value) {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function sourceIdentity(item) {
  return `${item.sourceId}:${item.sourceName}`.toLowerCase();
}

function translationCacheKey(item) {
  return `${canonicalUrl(item.url)}\n${item.title?.trim() ?? ""}`;
}

export function buildLiveFeed(snapshot, now = snapshot?.generatedAt) {
  const generatedAtMs = parseTime(now);
  if (generatedAtMs === null) {
    throw new Error("Live feed snapshot has no valid generatedAt");
  }
  const windowStartMs =
    generatedAtMs - liveWindowHours * 60 * 60 * 1_000;
  const futureLimitMs =
    generatedAtMs + futureToleranceHours * 60 * 60 * 1_000;
  const seenUrls = new Set();
  const seenTitles = new Set();
  const sourceCounts = new Map();
  const clusteredOriginalUrls = new Set(
    (snapshot.items ?? []).flatMap((item) => {
      const configuredSource = sourceById.get(item.sourceId);
      if (
        !isDiscoveryItem(item, configuredSource) ||
        (item.discoveryLevel ?? configuredSource?.discoveryLevel) !== "A"
      ) {
        return [];
      }
      const url = canonicalUrl(item.url);
      return url ? [url.toLowerCase()] : [];
    }),
  );

  const items = (snapshot.items ?? [])
    .flatMap((item) => {
      const configuredSource = sourceById.get(item.sourceId);
      const discovery = isDiscoveryItem(item, configuredSource);
      if (
        item.conversationSource ||
        configuredSource?.conversationSource ||
        discovery
      ) {
        return [];
      }
      const publishedAtMs = parseTime(item.publishedAt);
      if (
        publishedAtMs === null ||
        publishedAtMs < windowStartMs ||
        publishedAtMs > futureLimitMs
      ) {
        return [];
      }
      const url = canonicalUrl(item.url);
      if (!url || /(^|\.)techmeme\.com$/i.test(displayDomain(url))) return [];

      const title = item.title?.trim() ?? "";
      const sourceName =
        item.sourcePublisher ??
        item.sourceName ??
        displayDomain(url);
      if (!title || !sourceName) return [];
      const sourceKind = getSourceKind(url);
      const candidateText = `${title} ${item.summary ?? ""}`;
      const clustered =
        Boolean(item.discoveredThroughCluster) ||
        clusteredOriginalUrls.has(url.toLowerCase());
      const authoritative = authoritativePublisherPattern.test(
        `${sourceName} ${item.sourceName ?? ""}`,
      );
      const trustedNewsPublisher = trustedNewsPublisherPattern.test(
        `${sourceName} ${item.sourceName ?? ""}`,
      );
      const officialModelFeed =
        authoritative &&
        configuredSource?.feedFormat === "huggingface-models-json";
      if (
        Number(item.durationMinutes ?? 0) >= 20 ||
        (!liveScopePattern.test(candidateText) && !officialModelFeed) ||
        (!authoritative && !trustedNewsPublisher && !clustered)
      ) {
        return [];
      }

      const publicItem = {
        id: `${item.id ?? `${item.sourceId}-${url}`}`,
        sourceId: item.sourceId,
        sourceName,
        sourcePublisher: sourceName,
        sourceKind,
        title,
        url,
        publishedAt: new Date(publishedAtMs).toISOString(),
        firstSeenAt:
          parseTime(item.firstSeenAt) === null ? null : item.firstSeenAt,
        discoveredThroughCluster: clustered,
        prominence:
          clustered ||
          (authoritative && materialEventPattern.test(candidateText))
            ? "lead"
            : "river",
      };
      return [publicItem];
    })
    .sort(
      (left, right) =>
        Date.parse(right.publishedAt) - Date.parse(left.publishedAt),
    )
    .filter((item) => {
      const urlKey = canonicalUrl(item.url).toLowerCase();
      const titleKey = normalizedTitle(item.title);
      if (
        seenUrls.has(urlKey) ||
        (titleKey && seenTitles.has(titleKey))
      ) {
        return false;
      }
      const identity = sourceIdentity(item);
      const count = sourceCounts.get(identity) ?? 0;
      if (count >= directSourceLimit) {
        return false;
      }
      seenUrls.add(urlKey);
      if (titleKey) seenTitles.add(titleKey);
      sourceCounts.set(identity, count + 1);
      return true;
    })
    .slice(0, maximumLiveItems);

  return {
    generatedAt: new Date(generatedAtMs).toISOString(),
    windowHours: liveWindowHours,
    successfulSources: Number(snapshot.successfulSources ?? 0),
    failedSources: Number(snapshot.failedSources ?? 0),
    needsAuthSources: Number(snapshot.needsAuthSources ?? 0),
    items,
  };
}

async function main() {
  const snapshotPath = argumentValue("snapshot", "data/feed-snapshot.json");
  const outputPath = argumentValue("output", "data/live-feed.json");
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  const liveFeed = buildLiveFeed(snapshot);
  let previousLiveFeed = null;
  try {
    previousLiveFeed = JSON.parse(await readFile(outputPath, "utf8"));
  } catch {
    // The first live build creates the canonical file.
  }
  if (previousLiveFeed) {
    const cachedTranslations = new Map(
      (previousLiveFeed.items ?? [])
        .filter((item) => item.titleZh)
        .map((item) => [
          translationCacheKey(item),
          item.titleZh,
        ]),
    );
    liveFeed.items = liveFeed.items.map((item) => {
      const key = translationCacheKey(item);
      const titleZh = cachedTranslations.get(key);
      return titleZh ? { ...item, titleZh } : item;
    });
    if (liveFeed.items.some((item) => item.titleZh)) {
      liveFeed.localizationModel = previousLiveFeed.localizationModel;
      liveFeed.localizedAt = previousLiveFeed.localizedAt;
    }
    liveFeed.pendingItemCount = liveFeed.items.filter(
      (item) => !item.titleZh,
    ).length;
  }
  if (
    previousLiveFeed &&
    JSON.stringify(previousLiveFeed.items ?? []) ===
      JSON.stringify(liveFeed.items)
  ) {
    console.log(
      `Live feed unchanged: ${liveFeed.items.length} items at ${previousLiveFeed.generatedAt}`,
    );
    return;
  }
  await writeFile(outputPath, `${JSON.stringify(liveFeed, null, 2)}\n`, "utf8");
  console.log(
    `Live feed: ${liveFeed.items.length} items from ${liveFeed.successfulSources} connected sources at ${liveFeed.generatedAt}`,
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
