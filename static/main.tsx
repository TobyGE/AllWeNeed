import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import conversationsUrl from "../data/conversations.json?url";
import dailyRadarUrl from "../data/daily-radar.json?url";
import snapshotUrl from "../data/feed-snapshot.json?url";
import liveFeedUrl from "../data/live-feed.json?url";
import trafficSummaryUrl from "../data/traffic-summary.json?url";
import "../app/globals.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("All We Need root element is missing");
}

async function fetchJson(url: string) {
  const response = await fetch(url, { cache: "force-cache" });
  if (!response.ok) {
    throw new Error(`All We Need data request failed: ${response.status}`);
  }
  return response.json();
}

async function bootstrap() {
  const [conversations, dailyRadar, snapshot, liveFeed, trafficSummary] =
    await Promise.all([
      fetchJson(conversationsUrl),
      fetchJson(dailyRadarUrl),
      fetchJson(snapshotUrl),
      fetchJson(liveFeedUrl),
      fetchJson(trafficSummaryUrl),
    ]);
  globalThis.__ALL_WE_NEED_DATA__ = {
    conversations,
    dailyRadar,
    snapshot,
    liveFeed,
    trafficSummary,
  };
  const { default: Home } = await import("../app/page");
  createRoot(root).render(
    <StrictMode>
      <Home />
    </StrictMode>,
  );
}

void bootstrap().catch((error) => {
  console.error(error);
  root.dataset.loadFailed = "true";
});
