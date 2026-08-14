export const updateIntervalsMinutes = Object.freeze({
  poll: 60,
  fast: 0,
  standard: 240,
  explore: 720,
  conversation: 1_440,
});

export const globalModelCooldownMinutes = 120;
export const globalModelCooldownGraceMinutes = 5;

export const freshnessWindowsHours = Object.freeze({
  fast: 72,
  standard: 168,
  explore: 168,
  conversation: 168,
});

export const updateLaneNames = Object.freeze([
  "fast",
  "standard",
  "explore",
  "conversation",
]);

const authoritativePublisherPattern =
  /\b(?:OpenAI|Anthropic|Google(?: DeepMind)?|Meta|Amazon|AWS|Microsoft|NVIDIA|AMD|Broadcom|TSMC|ASML|Lam Research|KLA|Apple|SpaceX|ByteDance Seed|DeepSeek|Hugging Face|Model Context Protocol|Federal Reserve|SEC|CISA|NIST)\b/iu;

const fastMaterialPattern =
  /\b(?:earnings|results|guidance|revenue|margin|10-q|10-k|8-k|6-k|20-f|acquisition|merger|funding|raises?|launch(?:ed|ing)?|releas(?:e|ed|ing)|introduc(?:e|ed|ing)|available now|general availability|stable release|price|pricing|api|model|gpt(?:-\d[\w.-]*)?|claude|gemini|llama|grok|kimi|deepseek|veo|sora|seedance|security advisory|breach|incident|cve-\d+|vulnerability|rate decision|interest rate|fomc statement|executive order|regulation|enforcement|ban|sanction)\b|(?:财报|业绩|指引|营收|利润率|收购|合并|融资|正式发布|正式上线|推出|开放API|价格|降价|安全公告|漏洞|攻击|事故|利率决定|监管决定|行政令|制裁)/iu;

const standardEventPattern =
  /\b(?:update|changelog|preview|beta|research|paper|benchmark|repository|open source|partnership|contract|data center|semiconductor|chip|cloud|robot|cybersecurity|monetary policy|inflation|testimony)\b|(?:更新|预览|公测|研究|论文|基准|开源|合作|合同|数据中心|半导体|芯片|云计算|机器人|网络安全|货币政策|通胀|证词)/iu;

function parseTime(value) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

function candidateText(item) {
  return [
    item.sourceName,
    item.sourcePublisher,
    item.title,
    item.summary,
  ]
    .filter(Boolean)
    .join(" ");
}

function publisherTime(item) {
  const parsed = parseTime(item?.publishedAt);
  return parsed;
}

export function isFastLaneCandidate(item, now = Date.now()) {
  if (item?.conversationSource) return false;
  const nowTime = typeof now === "number" ? now : Date.parse(now);
  const publishedAt = publisherTime(item);
  if (
    !Number.isFinite(nowTime) ||
    publishedAt === null ||
    publishedAt > nowTime + 60 * 60 * 1_000 ||
    nowTime - publishedAt > freshnessWindowsHours.fast * 60 * 60 * 1_000
  ) {
    return false;
  }
  const text = candidateText(item);
  const material = fastMaterialPattern.test(text);
  if (!material) return false;
  if (["Fed", "SEC"].includes(item?.sourceKind)) return true;
  if (item?.discoveryOnly) {
    return item.discoveryLevel === "A";
  }
  return authoritativePublisherPattern.test(
    `${item?.sourcePublisher ?? ""} ${item?.sourceName ?? ""}`,
  );
}

export function candidateUpdateLane(item, now = Date.now()) {
  if (item?.conversationSource) return "conversation";
  if (isFastLaneCandidate(item, now)) return "fast";
  if (
    ["Fed", "SEC"].includes(item?.sourceKind) ||
    standardEventPattern.test(candidateText(item))
  ) {
    return "standard";
  }
  return "explore";
}

export function candidateFreshnessDecision(item, now = Date.now()) {
  const nowTime = typeof now === "number" ? now : Date.parse(now);
  if (!Number.isFinite(nowTime)) throw new Error("Invalid freshness time");
  const lane = candidateUpdateLane(item, nowTime);
  const publishedAt = publisherTime(item);
  const maxAgeHours = freshnessWindowsHours[lane];
  if (publishedAt === null) {
    return {
      eligible: false,
      lane,
      reason: "missing_publisher_timestamp",
      ageHours: null,
      maxAgeHours,
    };
  }
  const ageHours = (nowTime - publishedAt) / 3_600_000;
  if (ageHours < -1) {
    return {
      eligible: false,
      lane,
      reason: "publisher_timestamp_in_future",
      ageHours,
      maxAgeHours,
    };
  }
  if (ageHours > maxAgeHours) {
    return {
      eligible: false,
      lane,
      reason: "outside_freshness_window",
      ageHours,
      maxAgeHours,
    };
  }
  return {
    eligible: true,
    lane,
    reason: "fresh",
    ageHours: Math.max(0, ageHours),
    maxAgeHours,
  };
}

function laneLastProcessedAt(scheduleState, lane, fallback) {
  return (
    parseTime(scheduleState?.laneProcessedAt?.[lane]) ??
    parseTime(scheduleState?.lastFullCycleAt) ??
    parseTime(fallback)
  );
}

function oldestFirstSeenAt(items, now) {
  return Math.min(
    ...items.map(
      (item) =>
        parseTime(item.firstSeenAt ?? item.fetchedAt ?? item.publishedAt) ??
        now,
    ),
  );
}

function laneDueAt({ lane, items, now, scheduleState, fallback }) {
  if (!items.length) return null;
  if (lane === "fast") return now;
  const intervalMs = updateIntervalsMinutes[lane] * 60_000;
  const lastProcessedAt =
    laneLastProcessedAt(scheduleState, lane, fallback) ??
    oldestFirstSeenAt(items, now);
  const scheduledAt = lastProcessedAt + intervalMs;
  const maximumWaitAt = oldestFirstSeenAt(items, now) + intervalMs;
  return Math.min(scheduledAt, maximumWaitAt);
}

export function buildUpdatePlan({
  candidates,
  now = Date.now(),
  scheduleState = null,
  fallbackLastCycleAt = null,
}) {
  const nowTime = typeof now === "number" ? now : Date.parse(now);
  if (!Number.isFinite(nowTime)) throw new Error("Invalid planning time");
  const grouped = Object.fromEntries(
    updateLaneNames.map((lane) => [lane, []]),
  );
  for (const candidate of candidates) {
    grouped[candidateUpdateLane(candidate, nowTime)].push(candidate);
  }

  const dueAt = Object.fromEntries(
    updateLaneNames.map((lane) => [
      lane,
      laneDueAt({
        lane,
        items: grouped[lane],
        now: nowTime,
        scheduleState,
        fallback: fallbackLastCycleAt,
      }),
    ]),
  );
  const lanesDueBySchedule = updateLaneNames.filter(
    (lane) => dueAt[lane] !== null && dueAt[lane] <= nowTime,
  );
  const lastFullCycleAt =
    parseTime(scheduleState?.lastFullCycleAt) ??
    parseTime(fallbackLastCycleAt);
  const nextModelEligibleAt =
    lastFullCycleAt === null
      ? null
      : lastFullCycleAt + globalModelCooldownMinutes * 60_000;
  const cooldownReleaseAt =
    nextModelEligibleAt === null
      ? null
      : nextModelEligibleAt - globalModelCooldownGraceMinutes * 60_000;
  const modelCooldownActive =
    lanesDueBySchedule.length > 0 &&
    cooldownReleaseAt !== null &&
    cooldownReleaseAt > nowTime;
  const dueLanes = modelCooldownActive ? [] : lanesDueBySchedule;
  const futureDueTimes = Object.values(dueAt).filter(
    (value) => value !== null && value > nowTime,
  );
  if (modelCooldownActive) futureDueTimes.push(cooldownReleaseAt);
  const nextDueAt = futureDueTimes.length
    ? new Date(Math.min(...futureDueTimes)).toISOString()
    : null;

  return {
    plannedAt: new Date(nowTime).toISOString(),
    pollIntervalMinutes: updateIntervalsMinutes.poll,
    candidateCount: candidates.length,
    laneCounts: Object.fromEntries(
      updateLaneNames.map((lane) => [lane, grouped[lane].length]),
    ),
    dueLanes,
    modelCooldownActive,
    shouldRunFullCycle: dueLanes.length > 0,
    reason:
      dueLanes.length > 0
        ? `Process due lanes: ${dueLanes.join(", ")}`
        : modelCooldownActive
          ? `Candidates are queued by the global model cooldown until ${new Date(nextModelEligibleAt).toISOString()}`
        : candidates.length
          ? `Candidates are queued until ${nextDueAt}`
          : "No unseen candidates",
    nextDueAt,
    lanes: Object.fromEntries(
      updateLaneNames.map((lane) => [
        lane,
        grouped[lane].map((item) => ({
          sourceId: item.sourceId,
          sourceName: item.sourceName,
          title: item.title,
          url: item.url,
          firstSeenAt:
            item.firstSeenAt ?? item.fetchedAt ?? item.publishedAt ?? null,
        })),
      ]),
    ),
  };
}
