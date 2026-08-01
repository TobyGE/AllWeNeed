import { createHash } from "node:crypto";

function stableId(prefix, value) {
  return `${prefix}_${createHash("sha256")
    .update(String(value))
    .digest("hex")
    .slice(0, 16)}`;
}

function sourceKey(evidence) {
  return evidence?.url || `${evidence?.sourceName}:${evidence?.title}`;
}

function pushUnique(collection, seen, item) {
  const key = `${item.type}:${item.id}`;
  if (seen.has(key)) return;
  seen.add(key);
  collection.push(item);
}

export function buildEventGraph({
  radar,
  conversations,
  generatedAt = new Date().toISOString(),
}) {
  const nodes = [];
  const edges = [];
  const nodeIds = new Set();
  const edgeIds = new Set();
  const revisionQueue = [];

  function addNode(node) {
    pushUnique(nodes, nodeIds, node);
  }

  function addEdge(from, to, relation, metadata = {}) {
    const id = stableId("edge", `${from}|${relation}|${to}`);
    if (edgeIds.has(id)) return;
    edgeIds.add(id);
    edges.push({ id, from, to, relation, ...metadata });
  }

  function addEvidence(eventId, evidence, context) {
    const sourceId = stableId("source", sourceKey(evidence));
    const claimText =
      evidence?.takeaway || evidence?.title || evidence?.summary || "Evidence";
    const claimId = stableId(
      "claim",
      `${eventId}|${sourceKey(evidence)}|${claimText}`,
    );
    addNode({
      id: sourceId,
      type: "source",
      title: evidence?.sourceName || "Unknown source",
      url: evidence?.url ?? null,
      sourceKind: evidence?.sourceKind ?? null,
      publishedAt: evidence?.publishedAt ?? null,
    });
    addNode({
      id: claimId,
      type: "claim",
      title: claimText,
      role: evidence?.role ?? "Support",
      addedAt: context.addedAt ?? null,
    });
    addEdge(sourceId, claimId, "supports");
    addEdge(claimId, eventId, context.relation ?? "evidence_for", {
      updateTitle: context.updateTitle ?? null,
    });
  }

  for (const signal of radar?.signals ?? []) {
    const eventId = stableId("event", `signal:${signal.id}`);
    const articleId = stableId("article", `signal:${signal.id}:base`);
    addNode({
      id: eventId,
      type: "event",
      signalId: signal.id,
      title: signal.title,
      bucket: signal.editorialBucket,
      valueScore: signal.score ?? null,
      publishedAt: signal.publishedAt ?? signal.feedBatchAt ?? null,
      updatedAt: signal.updatedAt ?? null,
    });
    addNode({
      id: articleId,
      type: "article",
      signalId: signal.id,
      title: signal.title,
      version: 1,
      publishedAt: signal.feedBatchAt ?? signal.publishedAt ?? null,
    });
    addEdge(eventId, articleId, "rendered_as");
    for (const evidence of signal.evidence ?? []) {
      addEvidence(eventId, evidence, {
        relation: "evidence_for",
        addedAt: signal.feedBatchAt ?? signal.publishedAt,
      });
    }
    for (const update of signal.updates ?? []) {
      const updateId = stableId(
        "update",
        `${signal.id}|${update.addedAt}|${update.title}`,
      );
      addNode({
        id: updateId,
        type: "update",
        signalId: signal.id,
        title: update.title,
        summary: update.summary,
        addedAt: update.addedAt,
        changeType: update.changeType ?? "progress",
        thesisImpact: update.thesisImpact ?? null,
        revisionRequired: Boolean(update.revisionRequired),
      });
      addEdge(updateId, eventId, "updates");
      for (const evidence of update.evidence ?? []) {
        addEvidence(eventId, evidence, {
          relation: "update_evidence_for",
          addedAt: update.addedAt,
          updateTitle: update.title,
        });
      }
      if (update.revisionRequired || update.changeType === "thesis_change") {
        revisionQueue.push({
          signalId: signal.id,
          eventId,
          updateId,
          title: signal.title,
          updateTitle: update.title,
          thesisImpact: update.thesisImpact ?? update.summary,
          detectedAt: update.addedAt,
          status: "needs_editorial_revision",
        });
      }
    }
  }

  for (const conversation of conversations?.items ?? []) {
    const eventId = stableId("event", `conversation:${conversation.id}`);
    const articleId = stableId(
      "article",
      `conversation:${conversation.id}:base`,
    );
    addNode({
      id: eventId,
      type: "event",
      conversationId: conversation.id,
      title: conversation.titleZh,
      bucket: "conversation",
      publishedAt: conversation.publishedAt ?? conversation.feedBatchAt ?? null,
    });
    addNode({
      id: articleId,
      type: "article",
      conversationId: conversation.id,
      title: conversation.titleZh,
      version: 1,
      publishedAt: conversation.feedBatchAt ?? conversation.publishedAt ?? null,
    });
    addEdge(eventId, articleId, "rendered_as");
    if (conversation.url) {
      addEvidence(
        eventId,
        {
          sourceName: conversation.sourceName,
          sourceKind: conversation.sourceKind,
          title: conversation.originalTitle,
          url: conversation.url,
          publishedAt: conversation.publishedAt,
          role: "对谈",
          takeaway: conversation.dekZh,
        },
        {
          relation: "conversation_source_for",
          addedAt: conversation.feedBatchAt ?? conversation.publishedAt,
        },
      );
    }
  }

  return {
    schemaVersion: 1,
    generatedAt,
    counts: {
      sources: nodes.filter((node) => node.type === "source").length,
      claims: nodes.filter((node) => node.type === "claim").length,
      events: nodes.filter((node) => node.type === "event").length,
      articles: nodes.filter((node) => node.type === "article").length,
      updates: nodes.filter((node) => node.type === "update").length,
      edges: edges.length,
      revisionsRequired: revisionQueue.length,
    },
    revisionQueue,
    nodes,
    edges,
  };
}
