const GA_MEASUREMENT_ID = "G-6KK2W66GZC";
const PRODUCTION_HOSTS = new Set([
  "allweneed.info",
  "www.allweneed.info",
  "yingqiangge.github.io",
]);

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
  }
}

function analyticsAllowed() {
  return (
    typeof window !== "undefined" &&
    PRODUCTION_HOSTS.has(window.location.hostname) &&
    !window.navigator.globalPrivacyControl
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

  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`;
  script.dataset.signalRadarAnalytics = "true";
  document.head.appendChild(script);

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
    | "sources"
    | "control";
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
