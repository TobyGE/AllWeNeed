const HOUR_MS = 60 * 60 * 1_000;
export const EXPLORE_EDITORIAL_FLOOR = 80;

export type SignalHeatStage = "hot" | "warm" | "cooling" | "dormant";
export type SignalHeatProfile = "dynamic" | "explore";

type DatedEvidence = {
  publishedAt?: string | null;
};

type DatedUpdate = {
  addedAt?: string | null;
};

export type SignalHeatInput = {
  score?: number;
  valueScore?: number;
  category?: string;
  eyebrow?: string;
  feedBatchAt?: string | null;
  publishedAt?: string | null;
  updatedAt?: string | null;
  sourceCount?: number;
  sourceNames?: string[];
  sources?: string[];
  evidence?: DatedEvidence[];
  updates?: DatedUpdate[];
};

export type SignalHeat = {
  score: number;
  stage: SignalHeatStage;
  visible: boolean;
  ageHours: number;
  halfLifeHours: number;
  lastActivityAt: string;
};

export type EditoriallyRankedSignal = SignalHeatInput & {
  heat: SignalHeat;
};

export type ReadHistoryEntry = {
  lastViewedAt: string;
  viewCount: number;
};

export function meetsExploreEditorialFloor(
  signal: Pick<SignalHeatInput, "score" | "valueScore">,
) {
  const editorialScore = Number(signal.valueScore ?? signal.score ?? 0);
  return Number.isFinite(editorialScore) &&
    editorialScore >= EXPLORE_EDITORIAL_FLOOR;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function timestamp(value?: string | null) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

function lastActivityTime(signal: SignalHeatInput, now: number) {
  const candidates = [
    signal.feedBatchAt,
    signal.updatedAt,
    signal.publishedAt,
    ...(signal.updates ?? []).map((update) => update.addedAt),
    ...(signal.evidence ?? []).map((evidence) => evidence.publishedAt),
  ]
    .map(timestamp)
    .filter((value): value is number => value !== null && value <= now);
  return candidates.length ? Math.max(...candidates) : now;
}

function dynamicHalfLife(signal: SignalHeatInput, editorialScore: number) {
  let hours = editorialScore >= 90 ? 120 : editorialScore >= 80 ? 96 : 72;
  const context = `${signal.category ?? ""} ${signal.eyebrow ?? ""}`.toLowerCase();
  if (
    /(宏观|美联储|监管|政策|财报|公司|资本|macro|fed|regulation|policy|earnings|company|capital)/u.test(
      context,
    )
  ) {
    hours *= 1.35;
  } else if (/(安全|security|cyber|breach)/u.test(context)) {
    hours *= 1.15;
  }
  return Math.round(hours);
}

function exploreHalfLife(editorialScore: number) {
  if (editorialScore >= 85) return 45 * 24;
  if (editorialScore >= 75) return 35 * 24;
  return 25 * 24;
}

export function calculateSignalHeat(
  signal: SignalHeatInput,
  {
    now,
    profile,
  }: {
    now: string | number | Date;
    profile: SignalHeatProfile;
  },
): SignalHeat {
  const nowTimestamp =
    now instanceof Date
      ? now.getTime()
      : typeof now === "number"
        ? now
        : Date.parse(now);
  const safeNow = Number.isFinite(nowTimestamp) ? nowTimestamp : Date.now();
  const lastActivity = lastActivityTime(signal, safeNow);
  const ageHours = Math.max(0, (safeNow - lastActivity) / HOUR_MS);
  const editorialScore = clamp(
    Number(signal.valueScore ?? signal.score ?? 50),
    0,
    99,
  );
  const sourceCount = Math.max(
    Number(signal.sourceCount ?? 0),
    signal.sourceNames?.length ?? 0,
  );
  const platformCount = new Set(signal.sources ?? []).size;
  const updateCount = signal.updates?.length ?? 0;
  const evidenceCount = signal.evidence?.length ?? 0;
  const corroborationBoost = Math.min(
    10,
    Math.max(0, sourceCount - 1) * 3 +
      Math.max(0, platformCount - 1) * 2,
  );
  const momentumBoost = Math.min(
    10,
    updateCount * 4 + Math.max(0, evidenceCount - sourceCount),
  );
  const peakHeat = clamp(
    editorialScore * 0.82 + corroborationBoost + momentumBoost,
    0,
    99,
  );
  const halfLifeHours =
    profile === "dynamic"
      ? dynamicHalfLife(signal, editorialScore)
      : exploreHalfLife(editorialScore);
  const heatScore = Math.round(
    peakHeat * Math.pow(0.5, ageHours / halfLifeHours),
  );
  const visibilityThreshold = profile === "dynamic" ? 38 : 26;
  const minimumDwellHours = profile === "dynamic" ? 36 : 5 * 24;
  const visible =
    ageHours <= minimumDwellHours || heatScore >= visibilityThreshold;
  const stage: SignalHeatStage =
    heatScore >= 70
      ? "hot"
      : heatScore >= 50
        ? "warm"
        : heatScore >= visibilityThreshold
          ? "cooling"
          : "dormant";

  return {
    score: heatScore,
    stage,
    visible,
    ageHours,
    halfLifeHours,
    lastActivityAt: new Date(lastActivity).toISOString(),
  };
}

export function compareSignalHeat(
  left: SignalHeat,
  right: SignalHeat,
) {
  const heatDifference = right.score - left.score;
  if (heatDifference !== 0) return heatDifference;
  return Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt);
}

export function compareEditorialValue(
  left: EditoriallyRankedSignal,
  right: EditoriallyRankedSignal,
) {
  const leftValue = Number(left.valueScore ?? left.score ?? 0);
  const rightValue = Number(right.valueScore ?? right.score ?? 0);
  const valueDifference = rightValue - leftValue;
  if (valueDifference !== 0) return valueDifference;
  return compareSignalHeat(left.heat, right.heat);
}

function freshnessOpportunityBoost(
  ageHours: number,
  profile: SignalHeatProfile,
) {
  if (profile === "dynamic") {
    if (ageHours <= 2) return 16;
    if (ageHours <= 8) return 13;
    if (ageHours <= 24) return 10;
    if (ageHours <= 48) return 5;
    return 0;
  }

  if (ageHours <= 6) return 10;
  if (ageHours <= 24) return 8;
  if (ageHours <= 48) return 4;
  return 0;
}

export function hasUnreadActivity(
  signal: EditoriallyRankedSignal,
  readEntry?: ReadHistoryEntry,
) {
  if (!readEntry) return true;
  const viewedAt = Date.parse(readEntry.lastViewedAt);
  const lastActivityAt = Date.parse(signal.heat.lastActivityAt);
  if (!Number.isFinite(viewedAt)) return true;
  if (!Number.isFinite(lastActivityAt)) return false;
  return lastActivityAt > viewedAt;
}

export function personalizedEditorialScore(
  signal: EditoriallyRankedSignal,
  {
    profile,
    readEntry,
  }: {
    profile: SignalHeatProfile;
    readEntry?: ReadHistoryEntry;
  },
) {
  const editorialValue = Number(signal.valueScore ?? signal.score ?? 0);
  const freshnessBoost = freshnessOpportunityBoost(
    signal.heat.ageHours,
    profile,
  );
  const readPenalty =
    readEntry && !hasUnreadActivity(signal, readEntry)
      ? 20 + Math.min(12, Math.max(0, readEntry.viewCount - 1) * 4)
      : 0;
  return editorialValue + freshnessBoost - readPenalty;
}

export function comparePersonalizedEditorialValue(
  left: EditoriallyRankedSignal,
  right: EditoriallyRankedSignal,
  {
    profile,
    leftRead,
    rightRead,
  }: {
    profile: SignalHeatProfile;
    leftRead?: ReadHistoryEntry;
    rightRead?: ReadHistoryEntry;
  },
) {
  const rankDifference =
    personalizedEditorialScore(right, {
      profile,
      readEntry: rightRead,
    }) -
    personalizedEditorialScore(left, {
      profile,
      readEntry: leftRead,
    });
  if (rankDifference !== 0) return rankDifference;
  return compareEditorialValue(left, right);
}

function exploreFreshnessBoost(ageHours: number) {
  if (ageHours <= 6) return 8;
  if (ageHours <= 24) return 6;
  if (ageHours <= 72) return 3;
  if (ageHours <= 7 * 24) return 1;
  return 0;
}

export function compareExploreEditorialValue(
  left: EditoriallyRankedSignal,
  right: EditoriallyRankedSignal,
) {
  const leftValue = Number(left.valueScore ?? left.score ?? 0);
  const rightValue = Number(right.valueScore ?? right.score ?? 0);
  const leftRank = leftValue + exploreFreshnessBoost(left.heat.ageHours);
  const rightRank = rightValue + exploreFreshnessBoost(right.heat.ageHours);
  const rankDifference = rightRank - leftRank;
  if (rankDifference !== 0) return rankDifference;

  const valueDifference = rightValue - leftValue;
  if (valueDifference !== 0) return valueDifference;
  return compareSignalHeat(left.heat, right.heat);
}
