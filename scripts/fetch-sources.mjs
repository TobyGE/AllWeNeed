import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
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
const crawlerUserAgent = "SignalRadar/1.0 (personal research)";
const execFileAsync = promisify(execFile);
const secUserAgent =
  process.env.SEC_USER_AGENT?.trim() || crawlerUserAgent;
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
const previousItemsByProcessingKey = new Map();
for (const item of previousSnapshot.items) {
  const sourceItems = previousItems.get(item.sourceId) ?? [];
  sourceItems.push(item);
  previousItems.set(item.sourceId, sourceItems);
  previousItemsByProcessingKey.set(item.versionKey ?? item.url, item);
}

function decodeEntities(value = "") {
  const named = {
    amp: "&",
    apos: "'",
    gt: ">",
    hellip: "…",
    lt: "<",
    ldquo: "“",
    lsquo: "‘",
    mdash: "—",
    ndash: "–",
    nbsp: " ",
    quot: '"',
    rdquo: "”",
    rsquo: "’",
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
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
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

function canonicalComparisonUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (
        /^utm_/i.test(key) ||
        [
          "accesstoken",
          "campaign",
          "gift",
          "ref",
          "ref_src",
          "sharetoken",
          "smid",
          "source",
          "st",
          "unlocked_article_code",
          "view_token",
        ].includes(key.toLowerCase())
      ) {
        url.searchParams.delete(key);
      }
    }
    return url.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return "";
  }
}

function truncateOriginalText(value, limit = 180) {
  const text = cleanText(value);
  if (text.length <= limit) return text;
  const shortened = text.slice(0, limit + 1).replace(/\s+\S*$/, "").trim();
  return `${shortened || text.slice(0, limit).trim()}…`;
}

export function parseXOriginalOembed(payload) {
  const value =
    typeof payload === "string" ? JSON.parse(payload) : payload;
  const paragraph =
    String(value?.html ?? "").match(
      /<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/i,
    )?.[1] ?? "";
  const originalText = cleanText(paragraph).replace(
    /\s+(?:https:\/\/t\.co\/\S+|pic\.twitter\.com\/\S+)\s*$/i,
    "",
  );
  const authorName = cleanText(value?.author_name ?? "");
  if (!originalText || !authorName) return null;
  return {
    authorName,
    originalText,
    title: truncateOriginalText(originalText),
  };
}

const publisherUrlTitleRules = [
  {
    hostname: /(^|\.)wsj\.com$/i,
    publisher: "The Wall Street Journal",
    sourceId: 900226,
  },
];

const publisherMetadataRules = [
  {
    hostname: /(^|\.)asia\.nikkei\.com$/i,
    publisher: "Nikkei Asia",
    sourceId: 900221,
  },
  {
    hostname: /(^|\.)theverge\.com$/i,
    publisher: "The Verge",
    sourceId: 227,
  },
  {
    hostname: /(^|\.)techcrunch\.com$/i,
    publisher: "TechCrunch",
    sourceId: 228,
  },
  {
    hostname: /(^|\.)venturebeat\.com$/i,
    publisher: "VentureBeat",
    sourceId: 229,
  },
  {
    hostname: /(^|\.)arstechnica\.com$/i,
    publisher: "Ars Technica",
    sourceId: 230,
  },
  {
    hostname: /(^|\.)wired\.com$/i,
    publisher: "WIRED",
    sourceId: 231,
  },
  {
    hostname: /(^|\.)the-decoder\.com$/i,
    publisher: "The Decoder",
    sourceId: 232,
  },
  {
    hostname: /(^|\.)bloomberg\.com$/i,
    publisher: "Bloomberg",
    sourceId: 233,
  },
  {
    hostname: /(^|\.)bbc\.(?:com|co\.uk)$/i,
    publisher: "BBC",
    sourceId: 234,
  },
  {
    hostname: /(^|\.)engadget\.com$/i,
    publisher: "Engadget",
    sourceId: 235,
  },
  {
    hostname: /(^|\.)theinformation\.com$/i,
    publisher: "The Information",
    sourceId: 236,
  },
  {
    hostname: /(^|\.)wsj\.com$/i,
    publisher: "The Wall Street Journal",
    sourceId: 900226,
  },
  {
    hostname: /(^|\.)scientificamerican\.com$/i,
    publisher: "Scientific American",
    sourceId: 900301,
  },
  {
    hostname: /(^|\.)ft\.com$/i,
    publisher: "Financial Times",
    sourceId: 900302,
  },
  {
    hostname: /(^|\.)reuters\.com$/i,
    publisher: "Reuters",
    sourceId: 900303,
  },
  {
    hostname: /(^|\.)nytimes\.com$/i,
    publisher: "The New York Times",
    sourceId: 900304,
  },
  {
    hostname: /(^|\.)washingtonpost\.com$/i,
    publisher: "The Washington Post",
    sourceId: 900305,
  },
  {
    hostname: /(^|\.)cnbc\.com$/i,
    publisher: "CNBC",
    sourceId: 900306,
  },
  {
    hostname: /(^|\.)axios\.com$/i,
    publisher: "Axios",
    sourceId: 900307,
  },
  {
    hostname: /(^|\.)404media\.co$/i,
    publisher: "404 Media",
    sourceId: 900308,
  },
  {
    hostname: /(^|\.)semafor\.com$/i,
    publisher: "Semafor",
    sourceId: 900309,
  },
  {
    hostname: /(^|\.)platformer\.news$/i,
    publisher: "Platformer",
    sourceId: 900310,
  },
];

function publicMetadataRule(value) {
  try {
    const hostname = new URL(value).hostname;
    return (
      publisherMetadataRules.find((rule) =>
        rule.hostname.test(hostname),
      ) ?? null
    );
  } catch {
    return null;
  }
}

export function originalFromPublicPageMetadata(
  item,
  html,
  publisher,
  sourceId = 900226,
) {
  const metadata = extractPageMetadata(html);
  const title = cleanText(metadata.title ?? "");
  if (
    !title ||
    title.length < 12 ||
    /(?:access denied|attention required|just a moment|page not found|robot check)/i.test(
      title,
    )
  ) {
    return null;
  }
  return {
    id: `grounded-page-metadata-${createHash("sha256")
      .update(item.url)
      .digest("hex")
      .slice(0, 16)}`,
    sourceId,
    sourceName: publisher,
    sourcePublisher: publisher,
    sourceKind: getSourceKind(item.url),
    title,
    url: item.url,
    publishedAt: metadata.publishedAt ?? item.publishedAt,
    summary: cleanText(metadata.summary || title).slice(0, 1_200),
    fetchedAt: checkedAt,
    groundedFromDiscovery: true,
    originalTitleMethod: "public-page-metadata",
  };
}

function titleCasePublisherSlug(slug) {
  const lowerCaseWords = new Set([
    "a",
    "an",
    "and",
    "at",
    "but",
    "for",
    "in",
    "nor",
    "of",
    "on",
    "or",
    "the",
    "to",
    "with",
  ]);
  const upperCaseWords = new Map([
    ["ai", "AI"],
    ["api", "API"],
    ["aws", "AWS"],
    ["ceo", "CEO"],
    ["gpu", "GPU"],
    ["gpt", "GPT"],
    ["llm", "LLM"],
    ["nvidia", "Nvidia"],
    ["openai", "OpenAI"],
    ["u-s", "U.S."],
    ["us", "U.S."],
  ]);
  return slug
    .split("-")
    .filter(Boolean)
    .map((word, index) => {
      const normalized = word.toLowerCase();
      if (upperCaseWords.has(normalized)) {
        return upperCaseWords.get(normalized);
      }
      if (index > 0 && lowerCaseWords.has(normalized)) return normalized;
      return `${normalized.slice(0, 1).toUpperCase()}${normalized.slice(1)}`;
    })
    .join(" ");
}

export function originalTitleFromPublisherUrl(value) {
  try {
    const url = new URL(value);
    const rule = publisherUrlTitleRules.find((candidate) =>
      candidate.hostname.test(url.hostname),
    );
    if (!rule) return null;
    const rawSlug = url.pathname.split("/").filter(Boolean).at(-1) ?? "";
    const slug = rawSlug.replace(/-[a-f0-9]{8,}$/i, "");
    if (slug.split("-").filter(Boolean).length < 5) return null;
    const title = titleCasePublisherSlug(slug);
    return title
      ? {
          title,
          publisher: rule.publisher,
          sourceId: rule.sourceId,
        }
      : null;
  } catch {
    return null;
  }
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

function matchesConfiguredLanguage(title, source) {
  if (source.feedLanguage !== "en") return true;
  const letters = title.match(/\p{L}/gu) ?? [];
  if (!letters.length) return false;
  const latinLetters = title.match(/\p{Script=Latin}/gu) ?? [];
  return latinLetters.length / letters.length >= 0.7;
}

function durationMinutes(value = "") {
  const normalized = cleanText(value);
  if (!normalized) return null;
  const parts = normalized.split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;
  if (parts.length === 3) {
    return Math.max(1, Math.round(parts[0] * 60 + parts[1] + parts[2] / 60));
  }
  if (parts.length === 2) {
    return Math.max(1, Math.round(parts[0] + parts[1] / 60));
  }
  const seconds = Number(normalized);
  return Number.isFinite(seconds) ? Math.max(1, Math.round(seconds / 60)) : null;
}

export function parseFeed(xml, source, feedUrl) {
  const itemBlocks = [
    ...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi),
  ].map((match) => match[1]);
  const entryBlocks = [
    ...xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi),
  ].map((match) => match[1]);
  const blocks = itemBlocks.length ? itemBlocks : entryBlocks;
  const sourceKind = getSourceKind(source.url);

  return blocks.flatMap((block, index) => {
    const title = cleanText(tagValue(block, ["title"]));
    const rssLink = tagValue(block, ["link", "guid"]);
    const atomLink =
      block.match(/<link[^>]+href=["']([^"']+)["'][^>]*>/i)?.[1] ?? "";
    const url = absoluteUrl(atomLink || rssLink, feedUrl);
    if (
      !title ||
      !url ||
      !matchesConfiguredLanguage(title, source) ||
      !matchesConfiguredPath(url, source)
    ) {
      return [];
    }
    if (
      sourceKind === "YouTube" &&
      new URL(url).pathname.startsWith("/shorts/")
    ) {
      return [];
    }

    const publishedAt = normalizeDate(
      tagValue(block, ["pubDate", "published", "updated", "dc:date"]),
    );
    const summary = cleanText(
      tagValue(block, ["description", "summary", "content:encoded", "content"]),
    ).slice(0, source.feedSummaryLimit ?? 360);
    const episodeDurationMinutes = durationMinutes(
      tagValue(block, ["itunes:duration"]),
    );

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
        ...(episodeDurationMinutes
          ? { durationMinutes: episodeDurationMinutes }
          : {}),
        fetchedAt: checkedAt,
      },
    ];
  }).slice(0, itemsPerSource);
}

function canonicalTechmemeOriginalUrl(value, feedUrl) {
  const url = absoluteUrl(value, feedUrl);
  if (!url) return null;
  const parsed = new URL(url);
  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === "techmeme.com" ||
    hostname === "www.techmeme.com" ||
    !["http:", "https:"].includes(parsed.protocol)
  ) {
    return null;
  }
  parsed.hash = "";
  for (const key of [...parsed.searchParams.keys()]) {
    if (
      /^utm_/i.test(key) ||
      [
        "accesstoken",
        "campaign",
        "gift",
        "leadsource",
        "mc_cid",
        "mc_eid",
        "ref",
        "reflink",
        "sharetoken",
        "smid",
        "source",
        "st",
        "unlocked_article_code",
        "view_token",
      ].includes(key.toLowerCase())
    ) {
      parsed.searchParams.delete(key);
    }
  }
  return parsed.toString();
}

export function extractTechmemeOriginalUrl(block, feedUrl) {
  const description = tagValue(block, [
    "description",
    "summary",
    "content:encoded",
    "content",
  ]);
  const candidates = [
    ...decodeEntities(description).matchAll(
      /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi,
    ),
  ]
    .map((match) => canonicalTechmemeOriginalUrl(match[1], feedUrl))
    .filter(Boolean);

  // Techmeme descriptions put the headline's original article link after the
  // author/publisher homepage link. Choosing the final external anchor also
  // handles social posts, where a profile link precedes the status URL.
  return candidates.at(-1) ?? null;
}

export function parseTechmemeFeed(xml, source, feedUrl) {
  const blocks = [
    ...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi),
  ].map((match) => match[1]);

  return blocks.flatMap((block, index) => {
    const title = cleanText(tagValue(block, ["title"]));
    const url = extractTechmemeOriginalUrl(block, feedUrl);
    if (!title || !url) return [];

    const description = tagValue(block, [
      "description",
      "summary",
      "content:encoded",
      "content",
    ]);
    return [
      {
        id: `${source.id}-${index}-${url}`,
        sourceId: source.id,
        sourceName: source.name,
        sourcePublisher: source.publisher ?? source.name,
        sourceKind: getSourceKind(source.url),
        title,
        url,
        publishedAt: normalizeDate(
          tagValue(block, ["pubDate", "published", "updated", "dc:date"]),
        ),
        summary: cleanText(description).slice(
          0,
          source.feedSummaryLimit ?? 700,
        ),
        fetchedAt: checkedAt,
      },
    ];
  }).slice(0, itemsPerSource);
}

export function parseWordPressJson(text, source, feedUrl) {
  const payload = JSON.parse(text);
  if (!Array.isArray(payload)) {
    throw new Error("WordPress feed did not return an array");
  }

  return payload.slice(0, itemsPerSource).flatMap((post, index) => {
    const title = cleanText(post?.title?.rendered ?? post?.title ?? "");
    const url = absoluteUrl(post?.link, feedUrl);
    if (!title || !url) return [];

    const publishedAt = normalizeDate(
      post?.date_gmt
        ? `${String(post.date_gmt).replace(/Z$/, "")}Z`
        : post?.date,
    );
    const summary = cleanText(
      post?.excerpt?.rendered ??
        post?.excerpt ??
        post?.content?.rendered ??
        post?.content ??
        title,
    ).slice(0, 800);

    return [
      {
        id: `${source.id}-${post?.id ?? index}-${url}`,
        sourceId: source.id,
        sourceName: source.name,
        sourcePublisher: source.publisher ?? source.name,
        sourceKind: getSourceKind(source.url),
        title,
        url,
        publishedAt,
        summary,
        fetchedAt: checkedAt,
      },
    ];
  });
}

function normalizeAmazonPressUrl(value, feedUrl) {
  const cleaned = decodeEntities(value).trim();
  const embedded = cleaned.match(
    /^https?:\/\/press\.aboutamazon\.com\/(https?):\/([^/].+)$/i,
  );
  if (embedded) {
    return `${embedded[1]}://${embedded[2]}`;
  }
  return absoluteUrl(cleaned, feedUrl);
}

export function parseAmazonPressHtml(html, source, feedUrl) {
  const cards = [
    ...html.matchAll(
      /<li class=["']SearchResultsModuleResults-items-item["']>([\s\S]*?)<\/li>/gi,
    ),
  ].map((match) => match[1]);

  return cards.slice(0, itemsPerSource).flatMap((card, index) => {
    const titleBlock =
      card.match(
        /<div class=["']PromoCardSearchResults-title["']>([\s\S]*?)<\/div>/i,
      )?.[1] ?? "";
    const title = cleanText(tagValue(titleBlock, ["h2"]));
    const rawUrl =
      titleBlock.match(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>/i)?.[1] ?? "";
    const url = normalizeAmazonPressUrl(rawUrl, feedUrl);
    if (!title || !url || !matchesConfiguredLanguage(title, source)) return [];

    const publishedAt = normalizeDate(
      card.match(
        /<div class=["']PromoCardSearchResults-date["'][^>]*>([\s\S]*?)<\/div>/i,
      )?.[1],
    );

    return [
      {
        id: `${source.id}-${index}-${url}`,
        sourceId: source.id,
        sourceName: source.name,
        sourcePublisher: source.publisher ?? source.name,
        sourceKind: getSourceKind(source.url),
        title,
        url,
        publishedAt,
        summary: title,
        fetchedAt: checkedAt,
      },
    ];
  });
}

function matchesConfiguredPath(url, source) {
  const prefixes = source.feedPathPrefixes ?? [];
  if (!prefixes.length) return true;
  const pathname = new URL(url).pathname;
  return prefixes.some((prefix) => pathname.startsWith(prefix));
}

function titleFromUrl(url) {
  const pathname = new URL(url).pathname.replace(/\/$/, "");
  const slug = pathname.split("/").filter(Boolean).at(-1) ?? "";
  return cleanText(
    decodeURIComponent(slug)
      .replace(/\.(?:html?|md)$/i, "")
      .replace(/[-_]+/g, " "),
  );
}

export function parseSitemapXml(xml, source, feedUrl) {
  const blocks = [
    ...xml.matchAll(/<url(?:\s[^>]*)?>([\s\S]*?)<\/url>/gi),
  ].map((match) => match[1]);

  return blocks
    .flatMap((block) => {
      const url = absoluteUrl(tagValue(block, ["loc"]), feedUrl);
      if (!url || !matchesConfiguredPath(url, source)) return [];
      return [
        {
          id: `${source.id}-${url}`,
          sourceId: source.id,
          sourceName: source.name,
          sourcePublisher: source.publisher ?? source.name,
          sourceKind: getSourceKind(source.url),
          title: titleFromUrl(url),
          url,
          publishedAt: normalizeDate(tagValue(block, ["lastmod"])),
          summary: "",
          fetchedAt: checkedAt,
        },
      ];
    })
    .sort(
      (left, right) =>
        Date.parse(right.publishedAt ?? "") -
        Date.parse(left.publishedAt ?? ""),
    )
    .slice(0, itemsPerSource);
}

function contentFingerprint(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function parseDatedChangelogHtml(html, source, feedUrl) {
  const headings = [
    ...html.matchAll(/<h2\b([^>]*)>([\s\S]*?)<\/h2>/gi),
  ];
  const items = headings.flatMap((heading, index) => {
    const date = cleanText(heading[2]).match(/\b20\d{2}-\d{2}-\d{2}\b/)?.[0];
    if (!date) return [];

    const sectionStart = (heading.index ?? 0) + heading[0].length;
    const sectionEnd = headings[index + 1]?.index ?? html.length;
    const section = html.slice(sectionStart, sectionEnd);
    const sectionTitles = [
      ...section.matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi),
    ]
      .map((match) => cleanText(match[1]))
      .filter(Boolean);
    const title =
      sectionTitles.join(" · ") ||
      `${source.publisher ?? source.name} API update ${date}`;
    const summary = cleanText(section).slice(0, 1_600);
    if (!summary || !matchesConfiguredLanguage(title, source)) return [];

    const configuredAnchor =
      heading[1].match(/\bid=["']([^"']+)["']/i)?.[1] ?? `date-${date}`;
    const url = new URL(`#${configuredAnchor}`, feedUrl).toString();
    const versionHash = contentFingerprint(`${date}\n${title}\n${summary}`);

    return [
      {
        id: `${source.id}-${date}-${versionHash}`,
        versionKey: `changelog:v2:${source.id}:${date}:${versionHash}`,
        sourceId: source.id,
        sourceName: source.name,
        sourcePublisher: source.publisher ?? source.name,
        sourceKind: getSourceKind(source.url),
        title,
        url,
        publishedAt: normalizeDate(`${date}T00:00:00Z`),
        dateOnly: true,
        summary,
        fetchedAt: checkedAt,
      },
    ];
  });

  return items
    .sort(
      (left, right) =>
        Date.parse(right.publishedAt ?? "") -
        Date.parse(left.publishedAt ?? ""),
    )
    .slice(0, itemsPerSource);
}

function dateFromText(value) {
  const match = cleanText(value).match(
    /\b(?:20\d{2}-\d{2}-\d{2}|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+20\d{2})\b/i,
  );
  return normalizeDate(match?.[0]);
}

export function parseNewsListHtml(html, source, feedUrl) {
  const seenUrls = new Set();
  const items = [];
  for (const match of html.matchAll(
    /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
  )) {
    const url = absoluteUrl(match[1], feedUrl);
    if (
      !url ||
      seenUrls.has(url) ||
      !matchesConfiguredPath(url, source) ||
      url.replace(/\/$/, "") === source.url.replace(/\/$/, "")
    ) {
      continue;
    }
    const content = match[2];
    const heading =
      tagValue(content, ["h1", "h2", "h3", "h4"]) || content;
    const title = cleanText(heading).slice(0, 180);
    if (!title || !matchesConfiguredLanguage(title, source)) continue;
    seenUrls.add(url);
    items.push({
      id: `${source.id}-${url}`,
      sourceId: source.id,
      sourceName: source.name,
      sourcePublisher: source.publisher ?? source.name,
      sourceKind: getSourceKind(source.url),
      title,
      url,
      publishedAt: dateFromText(content),
      summary: cleanText(content).slice(0, 500),
      fetchedAt: checkedAt,
    });
    if (items.length === itemsPerSource) break;
  }
  return items;
}

export function parseHuggingFaceModelsJson(text, source) {
  const payload = JSON.parse(text);
  if (!Array.isArray(payload)) {
    throw new Error("Hugging Face models feed did not return an array");
  }
  return payload.slice(0, itemsPerSource).flatMap((model) => {
    const modelId = cleanText(model?.id ?? model?.modelId ?? "");
    if (!modelId) return [];
    const modelName = modelId.split("/").at(-1) ?? modelId;
    const url = `https://huggingface.co/${modelId}`;
    const tags = Array.isArray(model?.tags)
      ? model.tags
          .filter((tag) => typeof tag === "string")
          .slice(0, 8)
          .join(", ")
      : "";
    const metrics = [
      model?.pipeline_tag ? `task: ${model.pipeline_tag}` : "",
      Number.isFinite(model?.downloads)
        ? `downloads: ${model.downloads}`
        : "",
      Number.isFinite(model?.likes) ? `likes: ${model.likes}` : "",
      tags ? `tags: ${tags}` : "",
    ].filter(Boolean);
    return [
      {
        id: `${source.id}-${modelId}`,
        sourceId: source.id,
        sourceName: source.name,
        sourcePublisher: source.publisher ?? source.name,
        sourceKind: getSourceKind(source.url),
        title: `${modelName} model update`,
        url,
        publishedAt: normalizeDate(model?.lastModified ?? model?.createdAt),
        summary: metrics.join(" · ").slice(0, 800),
        fetchedAt: checkedAt,
      },
    ];
  });
}

export function parseSpaceXUpdatesJson(text, source) {
  const payload = JSON.parse(text);
  if (!Array.isArray(payload)) {
    throw new Error("SpaceX updates feed did not return an array");
  }

  return payload.slice(0, itemsPerSource).flatMap((update, index) => {
    const title = cleanText(update?.title ?? "");
    const updateId = cleanText(update?.updateId ?? "");
    if (!title || !updateId) return [];

    const summary = (update?.contentBlocks ?? [])
      .flatMap((block) => [block?.heading, block?.paragraph])
      .map((value) => cleanText(value ?? ""))
      .filter(Boolean)
      .join(" ")
      .slice(0, 1_200);
    const url = `https://www.spacex.com/updates/${encodeURIComponent(updateId)}`;

    return [
      {
        id: `${source.id}-${update?.id ?? index}-${updateId}`,
        sourceId: source.id,
        sourceName: source.name,
        sourcePublisher: source.publisher ?? source.name,
        sourceKind: getSourceKind(source.url),
        title,
        url,
        publishedAt: normalizeDate(update?.date ?? update?.publishedAt),
        summary: summary || title,
        fetchedAt: checkedAt,
      },
    ];
  });
}

function parseConfiguredFeed(text, source, feedUrl) {
  if (source.feedFormat === "techmeme-rss") {
    return parseTechmemeFeed(text, source, feedUrl);
  }
  if (source.feedFormat === "wordpress-json") {
    return parseWordPressJson(text, source, feedUrl);
  }
  if (source.feedFormat === "amazon-press-html") {
    return parseAmazonPressHtml(text, source, feedUrl);
  }
  if (source.feedFormat === "sitemap-xml") {
    return parseSitemapXml(text, source, feedUrl);
  }
  if (source.feedFormat === "news-list-html") {
    return parseNewsListHtml(text, source, feedUrl);
  }
  if (source.feedFormat === "dated-changelog-html") {
    return parseDatedChangelogHtml(text, source, feedUrl);
  }
  if (source.feedFormat === "spacex-updates-json") {
    return parseSpaceXUpdatesJson(text, source);
  }
  if (source.feedFormat === "huggingface-models-json") {
    return parseHuggingFaceModelsJson(text, source);
  }
  return parseFeed(text, source, feedUrl);
}

export function extractFedReleaseSummary(html) {
  const contentBlocks = [
    ...html.matchAll(
      /<div class=["']col-xs-12 col-sm-8 col-md-8["']>([\s\S]*?)<\/div>/gi,
    ),
  ]
    .map((match) =>
      [...match[1].matchAll(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/gi)]
        .map((paragraph) => cleanText(paragraph[1]))
        .filter(
          (paragraph) =>
            paragraph &&
            !paragraph.startsWith("For media inquiries") &&
            !paragraph.startsWith("Implementation Note"),
        )
        .join(" "),
    )
    .filter(Boolean);
  return contentBlocks.sort((left, right) => right.length - left.length)[0] ?? "";
}

function extractPageMetadata(html) {
  const metaTags = [...html.matchAll(/<meta\b[^>]*>/gi)].map(
    (match) => match[0],
  );
  const meta = new Map();
  for (const tag of metaTags) {
    const key =
      tag.match(/\b(?:name|property|itemprop)=["']([^"']+)["']/i)?.[1] ?? "";
    const content =
      tag.match(/\bcontent=["']([^"']*)["']/i)?.[1] ?? "";
    if (key && content) meta.set(key.toLowerCase(), cleanText(content));
  }
  const pageTitle = cleanText(tagValue(html, ["title"]));
  const title =
    meta.get("og:title") ?? meta.get("twitter:title") ?? pageTitle;
  const summary =
    meta.get("description") ??
    meta.get("og:description") ??
    meta.get("twitter:description") ??
    "";
  const jsonDate =
    html.match(/["']datePublished["']\s*:\s*["']([^"']+)["']/i)?.[1] ??
    html.match(/<time\b[^>]*\bdatetime=["']([^"']+)["']/i)?.[1] ??
    "";
  const publishedAt = normalizeDate(
    meta.get("article:published_time") ??
      meta.get("date") ??
      meta.get("datepublished") ??
      jsonDate,
  );
  return { title, summary, publishedAt };
}

async function enrichHtmlListingItems(items, source) {
  const cachedByUrl = new Map(
    (previousItems.get(source.id) ?? []).map((item) => [item.url, item]),
  );
  return Promise.all(
    items.map(async (item) => {
      const cached = cachedByUrl.get(item.url);
      if (cached?.title && cached?.summary) {
        return { ...cached, fetchedAt: checkedAt };
      }
      try {
        const page = await fetchText(item.url, 12_000);
        const metadata = extractPageMetadata(page.text);
        const title =
          source.feedTitleFromDescription && metadata.summary
            ? metadata.summary
            : metadata.title;
        return {
          ...item,
          title: title || item.title,
          summary: (metadata.summary || item.summary || item.title).slice(
            0,
            1_200,
          ),
          publishedAt: metadata.publishedAt ?? item.publishedAt,
        };
      } catch {
        return item;
      }
    }),
  );
}

async function enrichOfficialFeedItems(items, kind, source) {
  if (
    source.feedFormat === "sitemap-xml" ||
    source.feedFormat === "news-list-html"
  ) {
    return enrichHtmlListingItems(items, source);
  }
  if (kind !== "Fed") return items;

  let hydratedCount = 0;
  const hydrated = [];
  for (const item of items) {
    const shouldHydrate =
      hydratedCount < 3 &&
      /FOMC statement/i.test(item.title) &&
      item.summary.length <= item.title.length + 24;
    if (!shouldHydrate) {
      hydrated.push(item);
      continue;
    }

    try {
      const page = await fetchText(item.url, 12_000);
      const summary = extractFedReleaseSummary(page.text);
      hydrated.push(
        summary
          ? {
              ...item,
              summary: summary.slice(0, 1_600),
            }
          : item,
      );
      hydratedCount += 1;
    } catch {
      hydrated.push(item);
    }
  }
  return hydrated;
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
    "user-agent": validators.userAgent ?? crawlerUserAgent,
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

async function fetchTextWithCurl(url, timeoutMs = 15_000) {
  const { stdout } = await execFileAsync(
    "curl",
    [
      "--fail",
      "--location",
      "--silent",
      "--show-error",
      "--compressed",
      "--max-time",
      String(Math.max(1, Math.ceil(timeoutMs / 1_000))),
      "--user-agent",
      "AllWeNeedFeedReader/1.0 (+https://allweneed.info)",
      url,
    ],
    {
      encoding: "utf8",
      maxBuffer: 8 * 1_024 * 1_024,
      timeout: timeoutMs + 2_000,
    },
  );
  return {
    text: stdout,
    contentType: "application/xml",
    finalUrl: url,
    notModified: false,
    etag: null,
    lastModified: null,
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
    return await fetchText(url, timeoutMs, {
      ...validators,
      userAgent: secUserAgent,
    });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("HTTP 403")) {
      throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
    return fetchText(url, timeoutMs, {
      ...validators,
      userAgent: secUserAgent,
    });
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

function secFilingIndexUrl(cik, accessionNumber) {
  const cikWithoutLeadingZeros = String(Number(cik));
  const accessionPath = accessionNumber.replaceAll("-", "");
  return `https://www.sec.gov/Archives/edgar/data/${cikWithoutLeadingZeros}/${accessionPath}/${accessionNumber}-index.htm`;
}

export function extractSecExhibitLink(indexHtml, indexUrl) {
  const rows = [
    ...indexHtml.matchAll(/<tr(?:\s[^>]*)?>([\s\S]*?)<\/tr>/gi),
  ];
  for (const row of rows) {
    if (!/\bEX-99\.1\b/i.test(cleanText(row[1]))) continue;
    const href = row[1].match(/href=["']([^"']+)["']/i)?.[1];
    if (href) return absoluteUrl(href, indexUrl);
  }
  return null;
}

export function extractEarningsReleaseSummary(html) {
  const text = cleanText(html);
  if (!text) return "";
  const highlightIndex = text.search(/Financial Highlights/i);
  const resultIndex = text.search(/reported financial results/i);
  const start =
    highlightIndex >= 0
      ? Math.max(0, highlightIndex - 240)
      : resultIndex >= 0
        ? Math.max(0, resultIndex - 160)
        : 0;
  const financialExcerpt = text.slice(start, start + 1_350);
  const outlookIndex = text.search(/CFO Outlook Commentary|Business Outlook/i);
  const outlookExcerpt =
    outlookIndex >= 0 ? text.slice(outlookIndex, outlookIndex + 850) : "";
  return cleanText(`${financialExcerpt} ${outlookExcerpt}`).slice(0, 2_200);
}

async function fetchSecEarningsExhibit(source, accessionNumber) {
  const indexUrl = secFilingIndexUrl(source.secCik, accessionNumber);
  const indexResponse = await fetchSecText(indexUrl, 25_000);
  const exhibitUrl = extractSecExhibitLink(indexResponse.text, indexUrl);
  if (!exhibitUrl) return null;
  const exhibitResponse = await fetchSecText(exhibitUrl, 25_000);
  const summary = extractEarningsReleaseSummary(exhibitResponse.text);
  return summary ? { summary, url: exhibitUrl } : null;
}

function secDuration(entry) {
  if (!entry.start || !entry.end) return null;
  const duration = Date.parse(entry.end) - Date.parse(entry.start);
  return Number.isFinite(duration) ? duration : null;
}

function normalizeSecDate(value) {
  const match = String(value ?? "").match(/^\d{4}-\d{2}-\d{2}/);
  return match?.[0] ?? "";
}

export function selectSecFactEntry(
  fact,
  accessionNumber,
  form,
  reportDate = "",
) {
  const candidates = Object.entries(fact?.units ?? {}).flatMap(
    ([unit, entries]) =>
      entries
        .filter((entry) => entry.accn === accessionNumber)
        .map((entry) => ({ ...entry, unit })),
  );
  if (!candidates.length) return null;

  const normalizedReportDate = normalizeSecDate(reportDate);
  const periodCandidates = normalizedReportDate
    ? candidates.filter(
        (entry) => normalizeSecDate(entry.end) === normalizedReportDate,
      )
    : candidates;
  // A filing accession can contain both the current period and comparative
  // prior-period facts. If the SEC submission gives us a report date, never
  // silently fall back to a fact ending in another period.
  if (normalizedReportDate && !periodCandidates.length) return null;

  const annual = form.startsWith("10-K") || form.startsWith("20-F");
  return periodCandidates.sort((left, right) => {
    const leftDuration = secDuration(left);
    const rightDuration = secDuration(right);
    if (leftDuration === null && rightDuration === null) {
      return String(right.filed ?? "").localeCompare(String(left.filed ?? ""));
    }
    if (leftDuration === null) return 1;
    if (rightDuration === null) return -1;
    const durationDifference = annual
      ? rightDuration - leftDuration
      : leftDuration - rightDuration;
    if (durationDifference !== 0) return durationDifference;
    return String(right.filed ?? "").localeCompare(String(left.filed ?? ""));
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

export function extractSecMetricRecords(
  companyFacts,
  accessionNumber,
  form,
  reportDate = "",
) {
  const facts = companyFacts?.facts ?? {};
  const metrics = [];
  for (const metric of secFinancialConcepts) {
    let selected = null;
    for (const [taxonomy, concept] of metric.concepts) {
      const entry = selectSecFactEntry(
        facts[taxonomy]?.[concept],
        accessionNumber,
        form,
        reportDate,
      );
      if (entry) {
        selected = entry;
        break;
      }
    }
    if (!selected) continue;
    metrics.push({
      label: metric.label,
      value: selected.val,
      unit: selected.unit,
      start: selected.start ?? null,
      end: selected.end ?? null,
      formatted: formatSecValue(selected.val, selected.unit),
    });
    if (metrics.length === 4) break;
  }
  return metrics;
}

export function extractSecMetrics(
  companyFacts,
  accessionNumber,
  form,
  reportDate = "",
) {
  return extractSecMetricRecords(
    companyFacts,
    accessionNumber,
    form,
    reportDate,
  ).map((metric) => `${metric.label}: ${metric.formatted}`);
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
    let earningsExhibitFetched = false;
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
        ? extractSecMetrics(
            companyFacts,
            accessionNumber,
            form,
            reportDate,
          )
        : [];
      let earningsExhibit = null;
      if (
        !earningsExhibitFetched &&
        form.replace(/\/A$/, "") === "8-K" &&
        filingItems
          .split(",")
          .map((item) => item.trim())
          .includes("2.02")
      ) {
        earningsExhibitFetched = true;
        try {
          earningsExhibit = await fetchSecEarningsExhibit(
            source,
            accessionNumber,
          );
        } catch {
          // XBRL and filing metadata remain usable when an exhibit is blocked.
        }
      }
      const itemDetails = filingItems ? ` SEC items ${filingItems}.` : "";
      const metricDetails = metrics.length
        ? ` Reported XBRL facts: ${metrics.join("; ")}.`
        : "";
      const exhibitDetails = earningsExhibit?.summary
        ? ` Earnings release: ${earningsExhibit.summary}`
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
          `${payload.name} filed ${form} with the SEC for the period ended ${reportDate}.${itemDetails}${metricDetails}${exhibitDetails}`,
        ).slice(0, 2_400),
        ...(earningsExhibit?.url
          ? { attachmentUrl: earningsExhibit.url }
          : {}),
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
  if (kind === "SEC" && !source.feedUrl) return fetchSecSource(source);
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
          const requestTimeout =
            source.feedUrl || kind === "YouTube" ? 25_000 : 15_000;
          const result =
            source.feedTransport === "curl"
              ? await fetchTextWithCurl(candidate, requestTimeout)
              : await fetchText(
                  candidate,
                  requestTimeout,
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
          const configuredFormat = Boolean(source.feedFormat);
          const items = await enrichOfficialFeedItems(
            parseConfiguredFeed(
              result.text,
              source,
              result.finalUrl,
            ),
            kind,
            source,
          );
          if (
            configuredFormat ||
            looksLikeFeed(result.text, result.contentType)
          ) {
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
      const items = await enrichOfficialFeedItems(
        parseFeed(homepage.text, source, homepage.finalUrl),
        kind,
        source,
      );
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
        const items = await enrichOfficialFeedItems(
          parseFeed(result.text, source, result.finalUrl),
          kind,
          source,
        );
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

function configuredDiscoveryItem(item) {
  const source = sourceCatalog.find(
    (candidate) => candidate.id === item.sourceId,
  );
  return Boolean(item.discoveryOnly || source?.discoveryOnly);
}

function directItemUrls(items) {
  return new Set(
    items.flatMap((item) => {
      if (configuredDiscoveryItem(item)) return [];
      const url = canonicalComparisonUrl(item.url);
      return url ? [url] : [];
    }),
  );
}

function cachedGroundedOriginals(items) {
  return new Map(
    items.flatMap((item) => {
      if (!item.groundedFromDiscovery) return [];
      const url = canonicalComparisonUrl(item.url);
      return url ? [[url, item]] : [];
    }),
  );
}

export async function groundDiscoveryOriginals(
  items,
  {
    fetcher = fetchText,
    cachedItems = previousSnapshot.items,
  } = {},
) {
  const directUrls = directItemUrls(items);
  const cachedByUrl = cachedGroundedOriginals(cachedItems);
  const xSourcesByUsername = new Map(
    sourceCatalog.flatMap((source) => {
      try {
        const url = new URL(source.url);
        if (getSourceKind(source.url) !== "X") return [];
        const username = url.pathname.split("/").filter(Boolean)[0];
        return username ? [[username.toLowerCase(), source]] : [];
      } catch {
        return [];
      }
    }),
  );
  const grounded = [];

  for (const item of items) {
    if (
      !configuredDiscoveryItem(item) ||
      (item.discoveryLevel ??
        sourceCatalog.find((source) => source.id === item.sourceId)
          ?.discoveryLevel) !== "A"
    ) {
      continue;
    }
    const urlKey = canonicalComparisonUrl(item.url);
    if (!urlKey || directUrls.has(urlKey)) continue;

    const cached = cachedByUrl.get(urlKey);
    if (cached) {
      grounded.push({ ...cached, fetchedAt: checkedAt });
      directUrls.add(urlKey);
      continue;
    }

    let originalUrl;
    try {
      originalUrl = new URL(item.url);
    } catch {
      continue;
    }
    const xMatch = originalUrl.pathname.match(
      /^\/([^/]+)\/status\/(\d+)/i,
    );
    if (/^(?:www\.)?x\.com$/i.test(originalUrl.hostname) && xMatch) {
      try {
        const response = await fetcher(
          `https://publish.x.com/oembed?url=${encodeURIComponent(
            item.url,
          )}&omit_script=true`,
          12_000,
        );
        const original = parseXOriginalOembed(response.text);
        const source = xSourcesByUsername.get(xMatch[1].toLowerCase());
        if (original && source) {
          grounded.push({
            id: `grounded-x-${xMatch[2]}`,
            sourceId: source.id,
            sourceName: original.authorName,
            sourcePublisher: original.authorName,
            sourceKind: "X",
            title: original.title,
            url: item.url,
            publishedAt: item.publishedAt,
            summary: original.originalText.slice(0, 1_200),
            fetchedAt: checkedAt,
            groundedFromDiscovery: true,
            originalTitleMethod: "official-oembed",
          });
          directUrls.add(urlKey);
        }
      } catch {
        // Keep the discovery item private when the official endpoint is down.
      }
      continue;
    }

    const metadataRule = publicMetadataRule(item.url);
    if (metadataRule) {
      try {
        const response = await fetcher(item.url, 12_000);
        const original = originalFromPublicPageMetadata(
          item,
          response.text,
          metadataRule.publisher,
          metadataRule.sourceId,
        );
        if (original) {
          grounded.push(original);
          directUrls.add(urlKey);
          continue;
        }
      } catch {
        // Fall through to any publisher-URL resolver below.
      }
    }

    const publisherTitle = originalTitleFromPublisherUrl(item.url);
    if (publisherTitle) {
      grounded.push({
        id: `grounded-publisher-url-${createHash("sha256")
          .update(item.url)
          .digest("hex")
          .slice(0, 16)}`,
        sourceId: publisherTitle.sourceId,
        sourceName: publisherTitle.publisher,
        sourcePublisher: publisherTitle.publisher,
        sourceKind: getSourceKind(item.url),
        title: publisherTitle.title,
        url: item.url,
        publishedAt: item.publishedAt,
        summary: publisherTitle.title,
        fetchedAt: checkedAt,
        groundedFromDiscovery: true,
        originalTitleMethod: "publisher-url",
      });
      directUrls.add(urlKey);
    }
  }

  return grounded;
}

function preferDirectItems(items) {
  const byUrl = new Map();
  for (const item of items) {
    const key = canonicalComparisonUrl(item.url) || item.url;
    const existing = byUrl.get(key);
    if (!existing) {
      byUrl.set(key, item);
      continue;
    }
    const existingDiscovery = configuredDiscoveryItem(existing);
    const itemDiscovery = configuredDiscoveryItem(item);
    if (existingDiscovery && !itemDiscovery) {
      byUrl.set(key, {
        ...item,
        discoveredThroughCluster: true,
      });
    } else if (!existingDiscovery && itemDiscovery) {
      byUrl.set(key, {
        ...existing,
        discoveredThroughCluster: true,
      });
    }
  }
  return [...byUrl.values()];
}

export async function main() {
  const sourcesToFetch = selectedSourceIds.size
    ? sourceCatalog.filter((source) => selectedSourceIds.has(source.id))
    : sourceCatalog;
  const sourcesById = new Map(
    sourcesToFetch.map((source) => [source.id, source]),
  );
  const results = await mapWithConcurrency(
    sourcesToFetch,
    concurrency,
    fetchFeedSource,
  );

  const statuses = results.map((result) => result.status);
  const fetchedItems = results.flatMap((result) => result.items);
  const groundedOriginals = await groundDiscoveryOriginals(fetchedItems);
  const items = preferDirectItems([...fetchedItems, ...groundedOriginals])
    .map((item) => {
      const source = sourcesById.get(item.sourceId);
      const previousItem = previousItemsByProcessingKey.get(
        item.versionKey ?? item.url,
      );
      return {
        ...item,
        accessMethod:
          item.accessMethod ??
          (item.groundedFromDiscovery
            ? item.originalTitleMethod
            : source?.secCik
              ? "official-api"
              : "public-feed"),
        publicContentPolicy:
          source?.publicContentPolicy ?? "headline-source-link-only",
        title:
          source?.feedTitleFromDescription && item.summary
            ? item.summary
            : item.title,
        ...(source?.discoveryOnly
          ? {
              discoveryOnly: true,
              discoveryLevel: source.discoveryLevel ?? "A",
            }
          : {}),
        ...(source?.conversationSource
          ? {
              conversationSource: true,
              initialLookbackHours: source.initialLookbackHours ?? 0,
            }
          : {}),
        firstSeenAt:
          previousItem?.firstSeenAt ??
          previousItem?.fetchedAt ??
          checkedAt,
      };
    })
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
    failedSources: statuses.filter((status) => status.status === "error")
      .length,
    items,
    statuses,
  };

  if (!dryRun) {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(
      outputPath,
      `${JSON.stringify(snapshot, null, 2)}\n`,
      "utf8",
    );
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

  return snapshot;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
