import { createHash } from "node:crypto";

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function canonicalSourceUrl(value) {
  const raw = text(value);
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  parsed.hash = "";
  for (const key of [...parsed.searchParams.keys()]) {
    if (
      /^utm_/i.test(key) ||
      ["ref", "source", "campaign", "mc_cid", "mc_eid"].includes(
        key.toLowerCase(),
      )
    ) {
      parsed.searchParams.delete(key);
    }
  }
  parsed.hostname = parsed.hostname.toLowerCase();
  parsed.pathname = parsed.pathname.replace(/\/{2,}/g, "/");
  if (parsed.pathname !== "/") parsed.pathname = parsed.pathname.replace(/\/$/, "");
  parsed.searchParams.sort();
  return parsed.toString();
}

export function sourceCandidateId(candidate) {
  const identity =
    canonicalSourceUrl(candidate.feedUrl) ??
    canonicalSourceUrl(candidate.url) ??
    `${text(candidate.publisher)}:${text(candidate.name)}`.toLowerCase();
  return `source-${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`;
}

function uniqueStrings(values) {
  return [
    ...new Set(
      (Array.isArray(values) ? values : [])
        .map(text)
        .filter(Boolean),
    ),
  ];
}

function normalizedEvidence(values) {
  return (Array.isArray(values) ? values : [])
    .map((item) => ({
      title: text(item?.title),
      url: canonicalSourceUrl(item?.url),
      publisher: text(item?.publisher),
      publishedAt: text(item?.publishedAt) || null,
      summary: text(item?.summary),
    }))
    .filter((item) => item.title && item.url)
    .slice(0, 4);
}

export function normalizeSourceCandidate(raw) {
  const url = canonicalSourceUrl(raw?.url ?? raw?.homepageUrl);
  const feedUrl = canonicalSourceUrl(raw?.feedUrl ?? raw?.proposedFeedUrl);
  const candidate = {
    name: text(raw?.name),
    publisher: text(raw?.publisher || raw?.name),
    description: text(raw?.description),
    url,
    feedUrl,
    sourceKind: [
      "YouTube",
      "Podcast",
      "Newsletter",
      "Blog",
    ].includes(raw?.sourceKind)
      ? raw.sourceKind
      : "Blog",
    official: raw?.official === true,
    primaryMaterial: raw?.primaryMaterial !== false,
    conversationSource: raw?.conversationSource === true,
    paywallOnly: raw?.paywallOnly === true,
    aggregator: raw?.aggregator === true,
    language: text(raw?.language) || "en",
    topics: uniqueStrings(raw?.topics).slice(0, 8),
    rationale: text(raw?.rationale),
    evidence: normalizedEvidence(raw?.evidence),
  };
  return {
    ...candidate,
    id: sourceCandidateId(candidate),
  };
}

function normalizedIdentityName(value) {
  return text(value)
    .toLowerCase()
    .replace(/[^a-z0-9\u3400-\u9fff]+/gu, "");
}

function publisherBrand(value) {
  return text(value)
    .toLowerCase()
    .replace(
      /\b(?:incorporated|corporation|company|limited|inc|corp|llc|ltd)\b/gu,
      " ",
    )
    .replace(
      /\b(?:official|the|ai|blog|podcast|newsletter|channel|sec|filings)\b/gu,
      " ",
    )
    .replace(/[^a-z0-9\u3400-\u9fff]+/gu, "");
}

export function sourceIdentityKeys(source, { configured = false } = {}) {
  const keys = [];
  for (const value of [source.url, source.feedUrl]) {
    const canonical = canonicalSourceUrl(value);
    if (canonical) keys.push(`url:${canonical}`);
  }
  for (const value of [source.name, source.publisher]) {
    const normalized = normalizedIdentityName(value);
    if (normalized) keys.push(`name:${normalized}`);
  }
  const brand = publisherBrand(source.publisher || source.name);
  if (brand && (!configured || !source.feedUrl)) {
    keys.push(`brand:${brand}`);
  }
  return [...new Set(keys)];
}

function existingIdentities(configuredSources, discoveredSources) {
  const identities = new Set();
  for (const source of [
    ...(configuredSources ?? []),
    ...(discoveredSources?.sources ?? []),
  ]) {
    sourceIdentityKeys(source, { configured: true }).forEach((key) =>
      identities.add(key),
    );
  }
  return identities;
}

export function candidateScore(candidate, validation) {
  let score = 0;
  if (candidate.official) score += 25;
  if (candidate.primaryMaterial) score += 15;
  if (validation.homepageReachable) score += 10;
  if (validation.feedReachable && validation.feedDetected) score += 25;
  if (validation.itemCount >= 3) score += 10;
  if (validation.recentItemCount >= 2) score += 10;
  if (candidate.evidence.length >= 2) score += 5;
  if (candidate.aggregator) score -= 35;
  if (candidate.paywallOnly) score -= 25;
  if (validation.duplicate) score = 0;
  return Math.max(0, Math.min(100, score));
}

export function evaluateSourceCandidate({
  candidate,
  validation,
}) {
  const score = candidateScore(candidate, validation);
  const reasons = [];
  if (validation.duplicate) reasons.push("already_configured");
  if (!candidate.url) reasons.push("missing_canonical_homepage");
  if (!validation.homepageReachable) reasons.push("homepage_unreachable");
  if (!candidate.feedUrl) reasons.push("missing_public_feed");
  if (!validation.feedReachable || !validation.feedDetected) {
    reasons.push("feed_unavailable");
  }
  if (validation.recentItemCount < 2) reasons.push("insufficient_recent_activity");
  if (!candidate.official && candidate.evidence.length < 2) {
    reasons.push("insufficient_independent_evidence");
  }
  if (candidate.aggregator) reasons.push("aggregator");
  if (candidate.paywallOnly) reasons.push("paywall_only");

  const rejected =
    validation.duplicate ||
    !candidate.url ||
    (!validation.homepageReachable && !validation.feedReachable) ||
    candidate.aggregator;
  const healthyPublicFeed =
    !rejected &&
    candidate.primaryMaterial &&
    !candidate.aggregator &&
    !candidate.paywallOnly &&
    validation.homepageReachable &&
    validation.feedReachable &&
    validation.feedDetected &&
    validation.itemCount >= 3 &&
    validation.recentItemCount >= 2;
  const officialReady =
    healthyPublicFeed &&
    candidate.official &&
    score >= 85;
  const independentReady =
    healthyPublicFeed &&
    !candidate.official &&
    candidate.evidence.length >= 2 &&
    score >= 75;
  const ready = officialReady || independentReady;
  return {
    ...candidate,
    score,
    status: rejected ? "rejected" : ready ? "ready" : "review",
    reasons,
    validation,
  };
}

export function mergeSourceScoutCandidates({
  existing,
  result,
}) {
  const previous = new Map(
    (existing?.candidates ?? []).map((candidate) => [candidate.id, candidate]),
  );
  const seenAt = result.generatedAt ?? new Date().toISOString();
  for (const candidate of result.candidates ?? []) {
    const prior = previous.get(candidate.id);
    previous.set(candidate.id, {
      ...prior,
      ...candidate,
      ...(prior?.status === "promoted"
        ? {
            status: "promoted",
            promotedAt: prior.promotedAt,
          }
        : {}),
      firstSeenAt: prior?.firstSeenAt ?? seenAt,
      lastSeenAt: seenAt,
    });
  }
  return {
    schemaVersion: 1,
    generatedAt: seenAt,
    model: result.model ?? existing?.model ?? null,
    coverageGaps: result.coverageGaps ?? existing?.coverageGaps ?? [],
    candidates: [...previous.values()].sort(
      (left, right) =>
        Number(right.score ?? 0) - Number(left.score ?? 0) ||
        String(right.lastSeenAt ?? "").localeCompare(
          String(left.lastSeenAt ?? ""),
        ),
    ),
  };
}

export function promoteReadySources({
  candidates,
  configuredSources,
  discovered,
  promotedAt,
}) {
  const identities = existingIdentities(configuredSources, discovered);
  const existing = [...(discovered?.sources ?? [])];
  let nextId = Math.max(
    9_999,
    ...existing.map((source) => Number(source.id) || 0),
  ) + 1;
  const promotedIds = [];
  const duplicateIds = [];

  for (const candidate of candidates.candidates ?? []) {
    if (candidate.status !== "ready") continue;
    const identitiesToCheck = sourceIdentityKeys(candidate);
    if (identitiesToCheck.some((value) => identities.has(value))) {
      duplicateIds.push(candidate.id);
      continue;
    }
    existing.push({
      id: nextId++,
      name: candidate.name,
      publisher: candidate.publisher,
      description: candidate.description,
      url: candidate.url,
      feedUrl: candidate.feedUrl,
      ...(candidate.conversationSource
        ? { conversationSource: true, initialLookbackHours: 48 }
        : {}),
      discoveredBy: "source-scout",
      promotedAt,
    });
    promotedIds.push(candidate.id);
    identitiesToCheck.forEach((value) => identities.add(value));
  }

  return {
    registry: {
      schemaVersion: 1,
      updatedAt: promotedIds.length
        ? promotedAt
        : discovered?.updatedAt ?? null,
      sources: existing,
    },
    candidates: {
      ...candidates,
      candidates: (candidates.candidates ?? []).map((candidate) =>
        promotedIds.includes(candidate.id)
          ? {
              ...candidate,
              status: "promoted",
              promotedAt,
            }
          : duplicateIds.includes(candidate.id)
            ? {
                ...candidate,
                score: 0,
                status: "rejected",
                reasons: [
                  ...new Set([
                    ...(candidate.reasons ?? []),
                    "already_configured",
                  ]),
                ],
                validation: {
                  ...(candidate.validation ?? {}),
                  duplicate: true,
                },
              }
          : candidate,
      ),
    },
    promotedIds,
  };
}

export function configuredIdentitySet(configuredSources, discoveredSources) {
  return existingIdentities(configuredSources, discoveredSources);
}
