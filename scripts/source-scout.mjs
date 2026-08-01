import { readFile, writeFile, mkdir } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { sourceCatalog } from "../app/source-catalog.ts";
import discoveredSources from "../data/discovered-sources.json" with {
  type: "json",
};
import {
  callSubscriptionModelDetailed,
} from "./append-feed-updates.mjs";
import {
  modelReasoningEffort,
  modelTaskInstructions,
} from "./model-prompts.mjs";
import { modelRoutes } from "./model-routing.mjs";
import {
  canonicalSourceUrl,
  configuredIdentitySet,
  evaluateSourceCandidate,
  mergeSourceScoutCandidates,
  normalizeSourceCandidate,
  promoteReadySources,
  sourceIdentityKeys,
} from "./source-scout-store.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const authPath = resolve(homedir(), ".codex/auth.json");
const candidatesPath = resolve(projectRoot, "data/source-candidates.json");
const discoveredPath = resolve(projectRoot, "data/discovered-sources.json");
const radarPath = resolve(projectRoot, "data/daily-radar.json");
const resultPath = resolve(projectRoot, "tmp/source-scout-result.json");
const statePath = resolve(projectRoot, "tmp/source-scout-state.json");
const feedSchedulePath = resolve(projectRoot, "tmp/feed-schedule-state.json");
const scoutIntervalHours = 72;
const modelCooldownHours = 2;
const maxCandidatesPerRun = 8;
const maxProbeBytes = 1_500_000;

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseJsonOutput(value) {
  const unfenced = String(value ?? "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("Source Scout returned no JSON object");
  }
  return JSON.parse(unfenced.slice(start, end + 1));
}

function privateAddress(address) {
  const normalized = address.toLowerCase();
  if (normalized === "::1" || normalized.startsWith("fe80:")) return true;
  if (
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized === "0.0.0.0" ||
    normalized.startsWith("127.") ||
    normalized.startsWith("10.") ||
    normalized.startsWith("192.168.") ||
    normalized.startsWith("169.254.")
  ) {
    return true;
  }
  const match = normalized.match(/^172\.(\d+)\./);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}

export async function assertPublicSourceUrl(value) {
  const canonical = canonicalSourceUrl(value);
  if (!canonical) throw new Error("Only canonical HTTPS URLs are allowed");
  const parsed = new URL(canonical);
  if (
    parsed.hostname === "localhost" ||
    parsed.hostname.endsWith(".local") ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error("Private or credential-bearing URL rejected");
  }
  if (isIP(parsed.hostname) && privateAddress(parsed.hostname)) {
    throw new Error("Private IP rejected");
  }
  const addresses = await lookup(parsed.hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => privateAddress(address))) {
    throw new Error("Hostname does not resolve exclusively to public addresses");
  }
  return canonical;
}

function feedMetrics(body, now) {
  const feedDetected =
    /<(?:rss|feed|rdf:RDF)\b/i.test(body) ||
    /"(?:items|entries|version)"\s*:/i.test(body);
  const itemCount = Math.max(
    (body.match(/<(?:item|entry)\b/gi) ?? []).length,
    (body.match(/"(?:items|entries)"\s*:\s*\[/gi) ?? []).length ? 3 : 0,
  );
  const timestamps = [
    ...(body.match(
      /<(?:pubDate|published|updated|dc:date)>\s*([^<]+)\s*<\//gi,
    ) ?? []),
  ]
    .map((entry) => entry.replace(/^.*?>/, "").replace(/<.*$/, "").trim())
    .map(Date.parse)
    .filter(Number.isFinite);
  const recentBoundary = now - 90 * 24 * 60 * 60 * 1_000;
  return {
    feedDetected,
    itemCount,
    recentItemCount: timestamps.filter(
      (timestamp) => timestamp >= recentBoundary && timestamp <= now + 86_400_000,
    ).length,
    newestPublishedAt: timestamps.length
      ? new Date(Math.max(...timestamps)).toISOString()
      : null,
  };
}

async function probeUrl(value, { feed = false, now = Date.now() } = {}) {
  try {
    const url = await assertPublicSourceUrl(value);
    const response = await fetch(url, {
      headers: {
        accept: feed
          ? "application/atom+xml, application/rss+xml, application/xml, text/xml, application/json, text/html;q=0.8"
          : "text/html, application/xhtml+xml, application/json;q=0.8",
        "user-agent": "AllWeNeed-SourceScout/1.0 (+https://allweneed.info/)",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await response.text()).slice(0, maxProbeBytes);
    return {
      reachable: response.ok,
      status: response.status,
      finalUrl: canonicalSourceUrl(response.url) ?? url,
      contentType: response.headers.get("content-type") ?? "",
      ...(feed ? feedMetrics(body, now) : {}),
    };
  } catch (error) {
    return {
      reachable: false,
      status: null,
      error: error instanceof Error ? error.message : String(error),
      ...(feed
        ? {
            feedDetected: false,
            itemCount: 0,
            recentItemCount: 0,
            newestPublishedAt: null,
          }
        : {}),
    };
  }
}

export async function validateSourceCandidate(
  candidate,
  {
    configuredSources = sourceCatalog,
    discovered = discoveredSources,
    now = Date.now(),
  } = {},
) {
  const identities = configuredIdentitySet(configuredSources, discovered);
  const duplicate = sourceIdentityKeys(candidate).some((value) =>
    identities.has(value),
  );
  const [homepage, feed] = await Promise.all([
    probeUrl(candidate.url, { now }),
    candidate.feedUrl
      ? probeUrl(candidate.feedUrl, { feed: true, now })
      : Promise.resolve({
          reachable: false,
          feedDetected: false,
          itemCount: 0,
          recentItemCount: 0,
          newestPublishedAt: null,
        }),
  ]);
  return evaluateSourceCandidate({
    candidate,
    validation: {
      duplicate,
      homepageReachable: homepage.reachable,
      homepageStatus: homepage.status,
      homepageFinalUrl: homepage.finalUrl ?? null,
      feedReachable: feed.reachable,
      feedStatus: feed.status,
      feedFinalUrl: feed.finalUrl ?? null,
      feedDetected: feed.feedDetected,
      itemCount: feed.itemCount,
      recentItemCount: feed.recentItemCount,
      newestPublishedAt: feed.newestPublishedAt,
      errors: [homepage.error, feed.error].filter(Boolean),
    },
  });
}

function domain(value) {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function deriveCoverageGaps({ radar, configuredSources }) {
  const configuredDomains = new Set(
    configuredSources.flatMap((source) =>
      [domain(source.url), domain(source.feedUrl)].filter(Boolean),
    ),
  );
  const uncovered = new Map();
  for (const signal of radar?.signals ?? []) {
    for (const evidence of signal.evidence ?? []) {
      const host = domain(evidence.url);
      if (!host || configuredDomains.has(host)) continue;
      const entry = uncovered.get(host) ?? {
        domain: host,
        mentions: 0,
        publishers: new Set(),
      };
      entry.mentions += 1;
      if (evidence.sourceName) entry.publishers.add(evidence.sourceName);
      uncovered.set(host, entry);
    }
  }
  const evidenceGaps = [...uncovered.values()]
    .sort((left, right) => right.mentions - left.mentions)
    .slice(0, 15)
    .map((entry) => ({
      type: "uncovered_evidence_domain",
      domain: entry.domain,
      mentions: entry.mentions,
      publishers: [...entry.publishers].slice(0, 4),
    }));
  return [
    {
      type: "standing_priority",
      name: "official AI and core-technology releases",
    },
    {
      type: "standing_priority",
      name: "semiconductor, cloud and infrastructure IR/newsrooms",
    },
    {
      type: "standing_priority",
      name: "regulators, standards bodies and security advisories",
    },
    {
      type: "standing_priority",
      name: "original research and high-signal long-form conversations",
    },
    ...evidenceGaps,
  ];
}

function buildScoutPrompt({ now }) {
  return `You are the upstream Source Scout for All We Need, an AI, core technology,
company and investment intelligence product.

Search the live public web for durable sources. A source is a publisher or
channel that repeatedly produces original material—not a single article and
not an aggregator. Local software will privately remove anything already in the
catalog after your response; do not ask for or infer the existing inventory.

Priority order:
1. official company newsroom, IR, changelog, engineering or research feed;
2. regulator, government, standards body, exchange, court or security advisory;
3. original research institution, repository release stream or dataset;
4. independent analyst with sustained original work;
5. high-signal interview, podcast or YouTube channel.

For every candidate:
- verify the canonical publisher identity and homepage;
- find a public RSS/Atom/JSON/YouTube feed that our crawler can fetch;
- cite two recent canonical content URLs with real publication dates;
- mark official only for a company, government, regulator, standards body,
  university, research institution, or similarly accountable organization;
- independent analysts, newsletters and podcasts are not official even when
  they control their own publication;
- mark aggregator and paywallOnly accurately;
- do not propose X accounts, search pages, tag pages, individual articles,
  copied newsletters, scraping services or unofficial RSS mirrors;
- do not repeat any configured or already proposed source.

Return at most ${maxCandidatesPerRun} candidates. Prefer a smaller set with
strong verification. Today is ${new Date(now).toISOString()}.

Run a balanced search across these public tracks:
- official frontier AI, cloud, semiconductor and developer-platform releases;
- regulators, standards bodies, security advisories and public research;
- original independent technical or investment analysis with a public feed;
- high-signal long-form technology and business conversations.

Return only valid JSON:
{
  "candidates": [
    {
      "name": "Source name",
      "publisher": "Controlling publisher",
      "description": "What original material it repeatedly publishes",
      "url": "https://canonical-homepage",
      "feedUrl": "https://public-rss-atom-json-or-youtube-feed",
      "sourceKind": "YouTube|Podcast|Newsletter|Blog",
      "official": true,
      "primaryMaterial": true,
      "conversationSource": false,
      "paywallOnly": false,
      "aggregator": false,
      "language": "en",
      "topics": ["AI", "semiconductors"],
      "rationale": "The specific coverage gap this closes",
      "evidence": [
        {
          "title": "Recent item",
          "url": "https://canonical-item-url",
          "publisher": "Publisher",
          "publishedAt": "ISO-8601",
          "summary": "What this proves about the source"
        }
      ]
    }
  ]
}`;
}

async function subscriptionAuth() {
  const auth = await readJson(authPath, null);
  const tokens = auth?.tokens ?? {};
  if (!tokens.access_token || !tokens.account_id) {
    throw new Error("ChatGPT subscription auth is unavailable");
  }
  return {
    accessToken: tokens.access_token,
    accountId: tokens.account_id,
  };
}

function scheduledDecision({ state, candidates, feedSchedule, now }) {
  const lastScoutAt = Date.parse(
    state?.lastScoutAt ?? candidates?.generatedAt ?? "",
  );
  if (
    Number.isFinite(lastScoutAt) &&
    now - lastScoutAt < scoutIntervalHours * 3_600_000
  ) {
    return {
      due: false,
      reason: "source_scout_interval",
      nextDueAt: new Date(
        lastScoutAt + scoutIntervalHours * 3_600_000,
      ).toISOString(),
    };
  }
  const lastFullCycleAt = Date.parse(feedSchedule?.lastFullCycleAt ?? "");
  if (
    Number.isFinite(lastFullCycleAt) &&
    now - lastFullCycleAt < modelCooldownHours * 3_600_000
  ) {
    return {
      due: false,
      reason: "global_model_cooldown",
      nextDueAt: new Date(
        lastFullCycleAt + modelCooldownHours * 3_600_000,
      ).toISOString(),
    };
  }
  return { due: true, reason: "due", nextDueAt: null };
}

async function validateCandidates(candidates, context) {
  const results = [];
  for (let index = 0; index < candidates.length; index += 4) {
    results.push(
      ...(await Promise.all(
        candidates
          .slice(index, index + 4)
          .map((candidate) => validateSourceCandidate(candidate, context)),
      )),
    );
  }
  return results;
}

export async function runSourceScout({
  scheduled = false,
  deferMerge = false,
  now = Date.now(),
} = {}) {
  const [radar, currentCandidates, state, feedSchedule] = await Promise.all([
    readJson(radarPath, { signals: [] }),
    readJson(candidatesPath, {
      schemaVersion: 1,
      generatedAt: null,
      candidates: [],
    }),
    readJson(statePath, null),
    readJson(feedSchedulePath, null),
  ]);
  if (scheduled) {
    const decision = scheduledDecision({
      state,
      candidates: currentCandidates,
      feedSchedule,
      now,
    });
    if (!decision.due) {
      const result = { status: "queued", ...decision };
      console.log(JSON.stringify(result, null, 2));
      return result;
    }
  }

  const coverageGaps = deriveCoverageGaps({
    radar,
    configuredSources: sourceCatalog,
  });
  const prompt = buildScoutPrompt({
    now,
  });
  const auth = await subscriptionAuth();
  let completed = null;
  let lastError = null;
  for (const model of modelRoutes.sourceDiscovery) {
    try {
      const response = await callSubscriptionModelDetailed({
        model,
        prompt,
        ...auth,
        instructions: modelTaskInstructions({
          model,
          task: "sourceDiscovery",
          fallbackInstructions:
            "Search for durable, canonical public sources. Verify identity, feed availability and recent original output. Return only the requested JSON.",
        }),
        tools: [
          {
            type: "web_search",
            search_context_size: "low",
            external_web_access: true,
          },
        ],
        toolChoice: "required",
        reasoningEffort: modelReasoningEffort({
          model,
          task: "sourceDiscovery",
          fallbackEffort: "medium",
        }),
        timeoutMs: 240_000,
      });
      const parsed = parseJsonOutput(response.output);
      if (!Array.isArray(parsed.candidates)) {
        throw new Error("Source Scout candidates must be an array");
      }
      completed = {
        model,
        usage: response.usage,
        latencyMs: response.latencyMs,
        candidates: parsed.candidates
          .slice(0, maxCandidatesPerRun)
          .map(normalizeSourceCandidate)
          .filter((candidate) => candidate.name && candidate.url),
      };
      break;
    } catch (error) {
      lastError = error;
      console.warn(
        `${model} Source Scout failed: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  }
  if (!completed) {
    throw lastError ?? new Error("All Source Scout models failed");
  }

  const validated = await validateCandidates(completed.candidates, {
    configuredSources: sourceCatalog,
    discovered: discoveredSources,
    now,
  });
  const generatedAt = new Date(now).toISOString();
  const result = {
    schemaVersion: 1,
    status: "completed",
    generatedAt,
    model: completed.model,
    usage: completed.usage,
    latencyMs: completed.latencyMs,
    coverageGaps,
    candidateCount: validated.length,
    readyCount: validated.filter((candidate) => candidate.status === "ready").length,
    reviewCount: validated.filter((candidate) => candidate.status === "review").length,
    rejectedCount: validated.filter((candidate) => candidate.status === "rejected").length,
    candidates: validated,
  };
  await Promise.all([
    writeJson(resultPath, result),
    writeJson(statePath, {
      schemaVersion: 1,
      lastScoutAt: generatedAt,
      model: completed.model,
      candidateCount: validated.length,
    }),
  ]);

  if (!deferMerge) {
    const merged = mergeSourceScoutCandidates({
      existing: currentCandidates,
      result,
    });
    const promoted = promoteReadySources({
      candidates: merged,
      configuredSources: sourceCatalog,
      discovered: discoveredSources,
      promotedAt: generatedAt,
    });
    await Promise.all([
      writeJson(candidatesPath, promoted.candidates),
      writeJson(discoveredPath, promoted.registry),
    ]);
    result.promotedCount = promoted.promotedIds.length;
    result.promotedIds = promoted.promotedIds;
  }
  console.log(JSON.stringify(result, null, 2));
  return result;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  await runSourceScout({
    scheduled: process.argv.includes("--scheduled"),
    deferMerge: process.argv.includes("--defer-merge"),
  });
}
