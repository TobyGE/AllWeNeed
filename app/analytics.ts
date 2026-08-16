const GA_MEASUREMENT_ID = "G-8R17J8CJ1W";
const PRODUCTION_HOSTS = new Set([
  "allweneed.info",
  "www.allweneed.info",
  "yingqiangge.github.io",
]);
const INTERNAL_TRAFFIC_KEY = "all-we-need-internal-traffic";

type AnalyticsParameters = Record<
  string,
  string | number | boolean | undefined
>;

declare global {
  interface Navigator {
    globalPrivacyControl?: boolean;
  }

  interface Window {
    dataLayer?: unknown[][];
    gtag?: (...args: unknown[]) => void;
    signalRadarAnalyticsReady?: boolean;
    signalRadarInternalTraffic?: boolean;
  }
}

function internalTrafficDisabled() {
  if (typeof window === "undefined") return false;
  if (window.signalRadarInternalTraffic) return true;
  try {
    return window.localStorage.getItem(INTERNAL_TRAFFIC_KEY) === "true";
  } catch {
    return false;
  }
}

function analyticsAllowed() {
  return (
    typeof window !== "undefined" &&
    PRODUCTION_HOSTS.has(window.location.hostname) &&
    !internalTrafficDisabled()
  );
}

export function initializeAnalytics() {
  if (!analyticsAllowed() || window.signalRadarAnalyticsReady) return false;

  window.dataLayer = window.dataLayer ?? [];
  window.gtag =
    window.gtag ??
    ((...args: unknown[]) => {
      window.dataLayer?.push(args);
    });

  window.gtag("consent", "default", {
    analytics_storage: window.navigator.globalPrivacyControl
      ? "denied"
      : "granted",
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
  });
  window.gtag("js", new Date());
  window.gtag("config", GA_MEASUREMENT_ID, {
    anonymize_ip: true,
    send_page_view: false,
  });
  window.signalRadarAnalyticsReady = true;
  return true;
}

export function trackPageView({
  path,
  title,
  language,
  contentType,
}: {
  path: string;
  title: string;
  language: "zh" | "en";
  contentType:
    | "index"
    | "dynamic"
    | "explore"
    | "company"
    | "conversation"
    | "conversations"
    | "sources";
}) {
  if (!initializeAnalytics()) {
    if (!analyticsAllowed()) return;
  }

  window.gtag?.("event", "page_view", {
    page_location: new URL(path, window.location.origin).href,
    page_path: path,
    page_title: title,
    language,
    content_type: contentType,
  });
}

export function trackAnalyticsEvent(
  eventName: string,
  parameters: AnalyticsParameters,
) {
  if (!initializeAnalytics()) {
    if (!analyticsAllowed()) return;
  }
  window.gtag?.("event", eventName, parameters);
}
