import { createHash } from "node:crypto";

export function shouldRunShadowEvaluation({
  seed,
  rate = Number(process.env.SIGNAL_RADAR_SHADOW_RATE ?? 0.1),
}) {
  const boundedRate = Math.max(0, Math.min(1, Number(rate) || 0));
  if (boundedRate === 0) return false;
  if (boundedRate === 1) return true;
  const sample = Number.parseInt(
    createHash("sha256").update(String(seed)).digest("hex").slice(0, 8),
    16,
  );
  return sample / 0xffffffff < boundedRate;
}

function assignments(raw) {
  const assigned = new Map();
  for (const story of raw?.feedStories ?? []) {
    for (const evidence of story?.signal?.evidence ?? []) {
      assigned.set(evidence.ref, `story:${story.bucket}`);
    }
  }
  for (const update of raw?.existingUpdates ?? []) {
    for (const evidence of update?.update?.evidence ?? []) {
      assigned.set(evidence.ref, `update:${update.existingSignalId}`);
    }
  }
  for (const ignored of raw?.ignored ?? []) {
    assigned.set(ignored.ref, "ignored");
  }
  return assigned;
}

export function compareEditorialAssignments(primary, shadow, candidateRefs) {
  const primaryAssignments = assignments(primary);
  const shadowAssignments = assignments(shadow);
  const details = candidateRefs.map((ref) => {
    const primaryDisposition = primaryAssignments.get(ref) ?? "missing";
    const shadowDisposition = shadowAssignments.get(ref) ?? "missing";
    return {
      ref,
      primaryDisposition,
      shadowDisposition,
      agreed: primaryDisposition === shadowDisposition,
    };
  });
  const agreed = details.filter((detail) => detail.agreed).length;
  return {
    candidateCount: details.length,
    agreedCount: agreed,
    agreementRate: details.length ? agreed / details.length : 1,
    details,
  };
}

export function appendQualityRecord(history, record, limit = 100) {
  return {
    schemaVersion: 1,
    updatedAt: record.completedAt,
    records: [...(history?.records ?? []), record].slice(-limit),
  };
}
