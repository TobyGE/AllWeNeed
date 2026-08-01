import assert from "node:assert/strict";
import test from "node:test";
import { buildEventGraph } from "../scripts/event-graph.mjs";
import {
  appendQualityRecord,
  compareEditorialAssignments,
  shouldRunShadowEvaluation,
} from "../scripts/shadow-evaluation.mjs";

test("event graph connects source, claim, event and article", () => {
  const graph = buildEventGraph({
    generatedAt: "2026-08-01T12:00:00.000Z",
    radar: {
      signals: [
        {
          id: 7,
          title: "A model ships",
          editorialBucket: "dynamic",
          evidence: [
            {
              sourceName: "Official",
              sourceKind: "Blog",
              title: "Release",
              url: "https://example.com/release",
              takeaway: "The API is generally available.",
            },
          ],
          updates: [
            {
              addedAt: "2026-08-01T11:00:00.000Z",
              title: "Economics changed",
              summary: "Pricing changes the original adoption thesis.",
              changeType: "thesis_change",
              revisionRequired: true,
              thesisImpact: "The original adoption thesis needs revision.",
              evidence: [],
            },
          ],
        },
      ],
    },
    conversations: { items: [] },
  });

  assert.equal(graph.counts.sources, 1);
  assert.equal(graph.counts.claims, 1);
  assert.equal(graph.counts.events, 1);
  assert.equal(graph.counts.articles, 1);
  assert.equal(graph.counts.revisionsRequired, 1);
  assert.equal(graph.edges.some((edge) => edge.relation === "supports"), true);
  assert.equal(
    graph.edges.some((edge) => edge.relation === "rendered_as"),
    true,
  );
});

test("shadow evaluation is deterministic and measures editorial agreement", () => {
  const first = shouldRunShadowEvaluation({ seed: "same", rate: 0.5 });
  const second = shouldRunShadowEvaluation({ seed: "same", rate: 0.5 });
  assert.equal(first, second);
  assert.equal(shouldRunShadowEvaluation({ seed: "x", rate: 0 }), false);
  assert.equal(shouldRunShadowEvaluation({ seed: "x", rate: 1 }), true);

  const comparison = compareEditorialAssignments(
    {
      feedStories: [{ bucket: "dynamic", signal: { evidence: [{ ref: "N1" }] } }],
      ignored: [{ ref: "N2" }],
    },
    {
      feedStories: [{ bucket: "dynamic", signal: { evidence: [{ ref: "N1" }] } }],
      existingUpdates: [
        { existingSignalId: 5, update: { evidence: [{ ref: "N2" }] } },
      ],
    },
    ["N1", "N2"],
  );
  assert.equal(comparison.agreedCount, 1);
  assert.equal(comparison.agreementRate, 0.5);

  const history = appendQualityRecord(
    { records: [] },
    { completedAt: "2026-08-01T12:00:00.000Z", comparison },
  );
  assert.equal(history.records.length, 1);
});
