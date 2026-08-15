export type RuntimeData = {
  conversations: typeof import("../data/conversations.json").default;
  dailyRadar: typeof import("../data/daily-radar.json").default;
  snapshot: typeof import("../data/feed-snapshot.json").default;
  liveFeed: typeof import("../data/live-feed.json").default;
  trafficSummary: typeof import("../data/traffic-summary.json").default;
};

export async function loadRuntimeData(): Promise<RuntimeData> {
  const [conversations, dailyRadar, snapshot, liveFeed, trafficSummary] =
    await Promise.all([
      import("../data/conversations.json").then((module) => module.default),
      import("../data/daily-radar.json").then((module) => module.default),
      import("../data/feed-snapshot.json").then((module) => module.default),
      import("../data/live-feed.json").then((module) => module.default),
      import("../data/traffic-summary.json").then((module) => module.default),
    ]);
  return { conversations, dailyRadar, snapshot, liveFeed, trafficSummary };
}
