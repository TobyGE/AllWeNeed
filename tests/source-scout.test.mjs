import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalSourceUrl,
  evaluateSourceCandidate,
  mergeSourceScoutCandidates,
  normalizeSourceCandidate,
  promoteReadySources,
  configuredIdentitySet,
  sourceIdentityKeys,
} from "../scripts/source-scout-store.mjs";

function verifiedCandidate(overrides = {}) {
  return normalizeSourceCandidate({
    name: "Example Research",
    publisher: "Example Research",
    description: "Official original research and product releases.",
    url: "https://example.org/research/",
    feedUrl: "https://example.org/research/feed.xml",
    sourceKind: "Blog",
    official: true,
    primaryMaterial: true,
    topics: ["AI"],
    evidence: [
      {
        title: "Release one",
        url: "https://example.org/research/one",
        publisher: "Example Research",
        publishedAt: "2026-07-30T12:00:00.000Z",
        summary: "Official release.",
      },
      {
        title: "Release two",
        url: "https://example.org/research/two",
        publisher: "Example Research",
        publishedAt: "2026-07-24T12:00:00.000Z",
        summary: "Official research update.",
      },
    ],
    ...overrides,
  });
}

test("canonicalizes Scout URLs and removes tracking identity noise", () => {
  assert.equal(
    canonicalSourceUrl(
      "https://EXAMPLE.org/research/?utm_source=x&ref=home#latest",
    ),
    "https://example.org/research",
  );
  assert.equal(canonicalSourceUrl("http://example.org/feed"), null);
});

test("auto-ready requires an official primary source with a healthy recent feed", () => {
  const evaluated = evaluateSourceCandidate({
    candidate: verifiedCandidate(),
    validation: {
      duplicate: false,
      homepageReachable: true,
      feedReachable: true,
      feedDetected: true,
      itemCount: 12,
      recentItemCount: 4,
    },
  });
  assert.equal(evaluated.score, 100);
  assert.equal(evaluated.status, "ready");

  const independent = evaluateSourceCandidate({
    candidate: verifiedCandidate({ official: false }),
    validation: evaluated.validation,
  });
  assert.equal(independent.status, "review");
});

test("rejects aggregators and existing catalog identities", () => {
  const duplicate = evaluateSourceCandidate({
    candidate: verifiedCandidate({ aggregator: true }),
    validation: {
      duplicate: true,
      homepageReachable: true,
      feedReachable: true,
      feedDetected: true,
      itemCount: 20,
      recentItemCount: 10,
    },
  });
  assert.equal(duplicate.status, "rejected");
  assert.equal(duplicate.score, 0);
  assert.ok(duplicate.reasons.includes("already_configured"));
  assert.ok(duplicate.reasons.includes("aggregator"));
});

test("cross-entry identity detects a publisher already configured without a feed", () => {
  const configured = [
    {
      id: 1,
      name: "SemiAnalysis",
      description: "Existing publisher entry.",
      url: "https://semianalysis.com",
    },
    {
      id: 2,
      name: "GitHub AI & ML",
      description: "Existing category feed.",
      url: "https://github.blog/ai-and-ml",
      feedUrl: "https://github.blog/ai-and-ml/feed",
    },
  ];
  const identities = configuredIdentitySet(configured, { sources: [] });
  assert.equal(
    sourceIdentityKeys(
      verifiedCandidate({
        name: "SemiAnalysis Newsletter",
        publisher: "SemiAnalysis",
        url: "https://newsletter.semianalysis.com",
        feedUrl: "https://newsletter.semianalysis.com/feed",
      }),
    ).some((key) => identities.has(key)),
    true,
  );
  assert.equal(
    sourceIdentityKeys(
      verifiedCandidate({
        name: "GitHub Changelog",
        publisher: "GitHub, Inc.",
        url: "https://github.blog/changelog",
        feedUrl: "https://github.blog/changelog/feed",
      }),
    ).some((key) => identities.has(key)),
    false,
  );
});

test("promotes only ready sources and keeps promotion idempotent", () => {
  const ready = {
    ...verifiedCandidate(),
    score: 100,
    status: "ready",
  };
  const first = promoteReadySources({
    candidates: {
      schemaVersion: 1,
      generatedAt: "2026-08-01T12:00:00.000Z",
      candidates: [ready],
    },
    configuredSources: [],
    discovered: { schemaVersion: 1, sources: [] },
    promotedAt: "2026-08-01T12:00:00.000Z",
  });
  assert.equal(first.registry.sources.length, 1);
  assert.equal(first.candidates.candidates[0].status, "promoted");

  const second = promoteReadySources({
    candidates: first.candidates,
    configuredSources: [],
    discovered: first.registry,
    promotedAt: "2026-08-02T12:00:00.000Z",
  });
  assert.equal(second.registry.sources.length, 1);
  assert.deepEqual(second.promotedIds, []);
});

test("a ready cross-entry duplicate is rejected instead of left ready", () => {
  const candidate = {
    ...verifiedCandidate({
      name: "SemiAnalysis Newsletter",
      publisher: "SemiAnalysis",
      url: "https://newsletter.semianalysis.com",
      feedUrl: "https://newsletter.semianalysis.com/feed",
    }),
    score: 100,
    status: "ready",
    validation: { duplicate: false },
  };
  const result = promoteReadySources({
    candidates: { schemaVersion: 1, candidates: [candidate] },
    configuredSources: [
      {
        id: 1,
        name: "SemiAnalysis",
        url: "https://semianalysis.com",
      },
    ],
    discovered: { schemaVersion: 1, sources: [] },
    promotedAt: "2026-08-01T12:00:00.000Z",
  });
  assert.equal(result.registry.sources.length, 0);
  assert.equal(result.candidates.candidates[0].status, "rejected");
  assert.equal(result.candidates.candidates[0].validation.duplicate, true);
});

test("a repeated Scout result cannot demote an already promoted source", () => {
  const candidate = verifiedCandidate();
  const merged = mergeSourceScoutCandidates({
    existing: {
      schemaVersion: 1,
      generatedAt: "2026-08-01T00:00:00.000Z",
      candidates: [
        {
          ...candidate,
          score: 100,
          status: "promoted",
          promotedAt: "2026-08-01T00:00:00.000Z",
        },
      ],
    },
    result: {
      generatedAt: "2026-08-02T00:00:00.000Z",
      model: "gpt-5.6-terra",
      candidates: [{ ...candidate, score: 95, status: "ready" }],
    },
  });
  assert.equal(merged.candidates[0].status, "promoted");
  assert.equal(
    merged.candidates[0].promotedAt,
    "2026-08-01T00:00:00.000Z",
  );
});
