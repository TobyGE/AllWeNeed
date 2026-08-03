"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import conversations from "../data/conversations.json";
import dailyRadar from "../data/daily-radar.json";
import snapshot from "../data/feed-snapshot.json";
import liveFeed from "../data/live-feed.json";
import {
  trackAnalyticsEvent,
  trackPageView,
} from "./analytics";
import { ArticleView } from "./article-view";
import {
  FontSizeControl,
  type FontSizePreference,
} from "./font-size-control";
import {
  calculateSignalHeat,
  compareSignalHeat,
  formatExposureAge,
  isAdaptiveBackfill,
  meetsExploreEditorialFloor,
  selectAdaptiveFeedItems,
  type SignalHeat,
} from "./signal-heat";
import { getSourceKind, publicSourceCatalog } from "./source-catalog";
import { SourceLibrary } from "./source-library";

type SignalReference = {
  sourceName: string;
  sourceKind: string;
  title: string;
  titleZh?: string;
  url: string;
  publishedAt: string | null;
};

type SignalEvidence = SignalReference & {
  role: string;
  takeaway: string;
};

type SignalUpdate = {
  addedAt: string;
  title: string;
  summary: string;
  evidence: SignalEvidence[];
};

type Signal = {
  id: number;
  editorialBucket: "dynamic" | "explore" | "archive";
  permanent?: boolean;
  feedBatchAt?: string;
  publishedAt?: string | null;
  updatedAt?: string | null;
  category: string;
  eyebrow: string;
  title: string;
  summary: string;
  why: string;
  impact: string;
  shiftFrom: string;
  shiftTo: string;
  crossValidation: string;
  validationType: "跨平台验证" | "多账号验证" | "单一来源";
  sources: string[];
  sourceNames: string[];
  sourceCount: number;
  age: string;
  score: number;
  tone: "orange" | "blue" | "green";
  article?: {
    lead: string;
    sections: Array<{
      heading: string;
      body: string;
    }>;
    outlook: string;
  };
  updates?: SignalUpdate[];
  evidence: SignalEvidence[];
  references: SignalReference[];
};

type ExploreSignal = {
  id: string;
  feedBatchAt: string;
  valueScore: number;
  relatedSignalId?: number;
  category: string;
  label: string;
  title: string;
  thesis: string;
  whyNow: string;
  counterpoint: string;
  horizon: string;
  confidence: string;
  validationType: "跨平台验证" | "多账号验证" | "单一来源";
  sourceNames: string[];
  sourceKinds: string[];
  sourceCount: number;
  tone: "violet" | "cyan" | "amber" | "coral";
  crossValidation?: string;
  article?: {
    lead: string;
    sections: Array<{
      heading: string;
      body: string;
    }>;
    outlook: string;
  };
  evidence: SignalEvidence[];
};

type Conversation = {
  id: string;
  feedBatchAt?: string;
  videoId: string;
  sourceName: string;
  sourceKind: string;
  originalTitle: string;
  url: string;
  publishedAt: string;
  durationMinutes: number;
  guest: string;
  categoryZh: string;
  categoryEn: string;
  titleZh: string;
  titleEn: string;
  dekZh: string;
  dekEn: string;
  whyListenZh: string;
  whyListenEn: string;
  takeawaysZh: string[];
  takeawaysEn: string[];
  counterpointZh: string;
  counterpointEn: string;
  articleZh: {
    lead: string;
    sections: Array<{ heading: string; body: string }>;
    outlook: string;
  };
  articleEn: {
    lead: string;
    sections: Array<{ heading: string; body: string }>;
    outlook: string;
  };
};

type LiveStreamItem = {
  id: string;
  sourceId: number;
  sourceName: string;
  sourcePublisher?: string;
  sourceKind: string;
  title: string;
  url: string;
  publishedAt: string | null;
  summary: string;
  fetchedAt: string;
  firstSeenAt?: string;
  activityAt: string;
  categoryKey: string;
  category: string;
  discoveredThroughCluster: boolean;
  prominence: "lead" | "river";
};

type RadarView = "live" | "brief" | "explore" | "conversations";
type AppSection = "radar" | "sources";

type SiteSection = RadarView | "sources";

function basePathFromPathname(pathname: string) {
  return pathname === "/intelligence" || pathname.startsWith("/intelligence/")
    ? "/intelligence"
    : "";
}

function sectionPath(
  target: SiteSection,
  pathname =
    typeof window === "undefined" ? "/" : window.location.pathname,
) {
  const base = basePathFromPathname(pathname);
  if (target === "brief") return `${base}/`;
  return `${base}/${target}/`;
}

function routeFromPathname(pathname: string): {
  view: RadarView;
  section: AppSection;
} {
  const normalized = pathname.replace(/\/+$/, "");
  if (normalized.endsWith("/live")) {
    return { view: "live", section: "radar" };
  }
  if (normalized.endsWith("/explore")) {
    return { view: "explore", section: "radar" };
  }
  if (normalized.endsWith("/conversations")) {
    return { view: "conversations", section: "radar" };
  }
  if (normalized.endsWith("/sources")) {
    return { view: "brief", section: "sources" };
  }
  return { view: "brief", section: "radar" };
}

function pathForView(view: RadarView) {
  return sectionPath(view);
}

const signals = dailyRadar.signals as Signal[];
const allDynamicSignals = signals.filter(
  (signal) => signal.editorialBucket === "dynamic",
);
const curatedExploreSignals = dailyRadar.exploreSignals as ExploreSignal[];
const coveredKinds = [
  ...new Set(allDynamicSignals.flatMap((signal) => signal.sources)),
];

const configuredKindCounts = publicSourceCatalog.reduce<Record<string, number>>(
  (counts, source) => {
    const kind = getSourceKind(source.url);
    counts[kind] = (counts[kind] ?? 0) + 1;
    return counts;
  },
  {},
);
const publicSourceIds = new Set(publicSourceCatalog.map((source) => source.id));
const publicSnapshotItems = snapshot.items.filter((item) =>
  publicSourceIds.has(item.sourceId),
);
const publicStatuses = snapshot.statuses.filter((status) =>
  publicSourceIds.has(status.sourceId),
);
const publicSuccessfulSources = publicStatuses.filter((status) =>
  ["ok", "empty"].includes(status.status),
).length;
const publicNeedsAuthSources = publicStatuses.filter(
  (status) => status.status === "needs_auth",
).length;
function shortKind(kind: string, locale: "zh" | "en") {
  if (locale === "zh") {
    if (kind === "Newsletter") return "简报";
    if (kind === "Fed") return "美联储";
    if (kind === "SEC") return "SEC";
    if (kind === "Blog") return "博客";
    return kind;
  }
  if (kind === "YouTube") return "YT";
  if (kind === "Newsletter") return "NL";
  if (kind === "Fed") return "Fed";
  if (kind === "SEC") return "SEC";
  return kind;
}

function StoryLinkIcon() {
  return <span className="story-link-icon" aria-hidden="true" />;
}

function heatLabel(heat: SignalHeat, locale: "zh" | "en") {
  const labels = {
    hot: locale === "zh" ? "高热" : "High heat",
    warm: locale === "zh" ? "关注" : "Active",
    cooling: locale === "zh" ? "降温" : "Cooling",
    dormant: locale === "zh" ? "沉寂" : "Dormant",
  };
  return `${labels[heat.stage]} ${heat.score}`;
}

function formatLiveAge(activityAt: string, now: string, locale: "zh" | "en") {
  const ageMinutes = Math.max(
    0,
    Math.floor((Date.parse(now) - Date.parse(activityAt)) / 60_000),
  );
  if (ageMinutes < 1) return locale === "zh" ? "刚刚" : "Just now";
  if (ageMinutes < 60) {
    return locale === "zh" ? `${ageMinutes} 分钟前` : `${ageMinutes}m ago`;
  }
  const ageHours = Math.floor(ageMinutes / 60);
  if (ageHours < 24) {
    return locale === "zh" ? `${ageHours} 小时前` : `${ageHours}h ago`;
  }
  const ageDays = Math.floor(ageHours / 24);
  return locale === "zh" ? `${ageDays} 天前` : `${ageDays}d ago`;
}

export default function Home() {
  const initialRoute =
    typeof window === "undefined"
      ? { view: "brief" as RadarView, section: "radar" as AppSection }
      : routeFromPathname(window.location.pathname);
  const [locale, setLocale] = useState<"zh" | "en">("en");
  const [localePreferenceReady, setLocalePreferenceReady] = useState(false);
  const [fontSize, setFontSize] = useState<FontSizePreference>("medium");
  const [activeCategory, setActiveCategory] = useState("全部");
  const [query, setQuery] = useState("");
  const [saved, setSaved] = useState<number[]>([]);
  const [view, setView] = useState<RadarView>(initialRoute.view);
  const [section, setSection] = useState<AppSection>(initialRoute.section);
  const [notice, setNotice] = useState("");
  const [articleId, setArticleId] = useState<string | null>(null);
  const [routeReady, setRouteReady] = useState(false);
  const [heatNow, setHeatNow] = useState(dailyRadar.generatedAt);
  const [isMobileLayout, setIsMobileLayout] = useState(false);
  const lastTrackedPath = useRef<string | null>(null);
  const languageCopy = dailyRadar.translations[locale];
  const t = (zh: string, en: string) => (locale === "zh" ? zh : en);

  useEffect(() => {
    try {
      const storedLocale = window.localStorage.getItem("all-we-need-locale");
      if (storedLocale === "zh" || storedLocale === "en") {
        setLocale(storedLocale);
      }
    } finally {
      setLocalePreferenceReady(true);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const storedFontSize = window.localStorage.getItem(
        "all-we-need-font-size",
      );
      const initialFontSize: FontSizePreference =
        storedFontSize === "medium" ||
        storedFontSize === "large" ||
        storedFontSize === "xlarge"
          ? storedFontSize
          : "medium";
      setFontSize(initialFontSize);
      document.documentElement.dataset.fontSize = initialFontSize;
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!localePreferenceReady) return;
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
    window.localStorage.setItem("all-we-need-locale", locale);
  }, [locale, localePreferenceReady]);

  useEffect(() => {
    if (articleId) return;
    document.title =
      section === "sources"
        ? locale === "zh"
          ? "信源库 — All We Need"
          : "Sources — All We Need"
        : view === "explore"
          ? locale === "zh"
            ? "探索 — All We Need"
            : "Explore — All We Need"
          : view === "live"
            ? locale === "zh"
              ? "动态 — All We Need"
              : "Live — All We Need"
          : view === "conversations"
            ? locale === "zh"
              ? "播客 — All We Need"
              : "Podcasts — All We Need"
            : locale === "zh"
              ? "All We Need — AI 科技投资情报"
              : "All We Need — AI, Tech & Investment Intelligence";
  }, [articleId, locale, section, view]);

  useEffect(() => {
    const refreshHeatClock = () => setHeatNow(new Date().toISOString());
    const initialTimer = window.setTimeout(refreshHeatClock, 0);
    const timer = window.setInterval(refreshHeatClock, 15 * 60 * 1_000);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 700px)");
    const syncLayout = () => setIsMobileLayout(media.matches);
    const initialTimer = window.setTimeout(syncLayout, 0);
    media.addEventListener("change", syncLayout);
    return () => {
      window.clearTimeout(initialTimer);
      media.removeEventListener("change", syncLayout);
    };
  }, []);

  useEffect(() => {
    const readLocation = () => {
      const route = routeFromPathname(window.location.pathname);
      const value = new URLSearchParams(window.location.search).get("article");
      setView(route.view);
      setSection(route.section);
      setArticleId(value || null);
      setActiveCategory("全部");
      setQuery("");
      setRouteReady(true);
    };
    readLocation();
    window.addEventListener("popstate", readLocation);
    return () => window.removeEventListener("popstate", readLocation);
  }, []);

  const localizedSignals = useMemo(
    () =>
      signals.map((signal, index) => {
          const translated = languageCopy.signals[index];
          const translatedUpdates = (
            translated as typeof translated & {
              updates?: Array<{
                addedAt: string;
                title: string;
                summary: string;
                evidence: Array<{ role: string; takeaway: string }>;
              }>;
            }
          ).updates;
          return {
            ...signal,
            ...translated,
            categoryKey: signal.category,
            heat: calculateSignalHeat(signal, {
              now: heatNow,
              profile:
                signal.editorialBucket === "explore" ? "explore" : "dynamic",
            }),
            article: translated.article
              ? {
                  ...signal.article,
                  ...translated.article,
                  sections:
                    translated.article.sections ??
                    signal.article?.sections ??
                    [],
                }
              : signal.article,
            evidence: signal.evidence.map((evidence, evidenceIndex) => ({
              ...evidence,
              role: translated.evidence[evidenceIndex]?.role ?? evidence.role,
              takeaway:
                translated.evidence[evidenceIndex]?.takeaway ??
                evidence.takeaway,
            })),
            updates: signal.updates?.map((update, updateIndex) => {
              const translatedUpdate = translatedUpdates?.[updateIndex];
              return {
                ...update,
                ...translatedUpdate,
                evidence: update.evidence.map((evidence, evidenceIndex) => ({
                  ...evidence,
                  role:
                    translatedUpdate?.evidence[evidenceIndex]?.role ??
                    evidence.role,
                  takeaway:
                    translatedUpdate?.evidence[evidenceIndex]?.takeaway ??
                    evidence.takeaway,
                })),
              };
            }),
          };
        }),
    [heatNow, languageCopy],
  );

  const localizedDynamicSignals = useMemo(
    () =>
      selectAdaptiveFeedItems(
        localizedSignals.filter(
          (signal) => signal.editorialBucket === "dynamic",
        ),
        "dynamic",
      ),
    [localizedSignals],
  );

  const liveStreamItems = useMemo(() => {
    const nowMs = Date.parse(heatNow);
    const windowStartMs = nowMs - 6 * 60 * 60 * 1_000;
    const futureToleranceMs = nowMs + 60 * 60 * 1_000;

    return liveFeed.items
      .map(
        (item): LiveStreamItem => ({
          ...item,
          title: locale === "zh" ? item.titleZh ?? item.title : item.title,
          summary: "",
          firstSeenAt: item.firstSeenAt ?? undefined,
          activityAt: item.publishedAt,
          categoryKey: item.sourceKind,
          category:
            locale === "zh"
              ? shortKind(item.sourceKind, locale)
              : item.sourceKind,
          prominence: item.prominence as "lead" | "river",
        }),
      )
      .filter((item) => {
        const activityAtMs = Date.parse(item.activityAt);
        return (
          Number.isFinite(activityAtMs) &&
          activityAtMs >= windowStartMs &&
          activityAtMs <= futureToleranceMs
        );
      });
  }, [heatNow, locale]);

  const localizedCuratedExploreSignals = useMemo(
    () =>
      curatedExploreSignals.map((signal, index) => {
        const translated = languageCopy.exploreSignals[index];
        return {
          ...signal,
          ...translated,
          categoryKey: signal.category,
          heat: calculateSignalHeat(signal, {
            now: heatNow,
            profile: "explore",
          }),
          crossValidation:
            translated.crossValidation ?? signal.crossValidation ?? "",
          article: translated.article
            ? {
                ...signal.article,
                ...translated.article,
                sections:
                  translated.article.sections ?? signal.article?.sections ?? [],
              }
            : signal.article,
          evidence: signal.evidence.map((evidence, evidenceIndex) => ({
            ...evidence,
            takeaway:
              translated.evidence[evidenceIndex]?.takeaway ?? evidence.takeaway,
          })),
        };
      }),
    [heatNow, languageCopy],
  );

  const localizedExploreSignals = useMemo(() => {
    const tones: ExploreSignal["tone"][] = [
      "violet",
      "cyan",
      "amber",
      "coral",
    ];
    const storySignals = localizedSignals
      .filter((signal) => signal.editorialBucket === "explore")
      .map((signal, index) => ({
        id: String(signal.id),
        category: signal.category,
        categoryKey: signal.categoryKey,
        label: signal.eyebrow,
        title: signal.title,
        thesis: signal.summary,
        whyNow: signal.why,
        counterpoint: signal.impact,
        horizon: locale === "zh" ? "持续追踪" : "Ongoing",
        confidence:
          signal.score >= 90
            ? locale === "zh"
              ? "高"
              : "High"
            : signal.score >= 80
              ? locale === "zh"
                ? "中高"
                : "Medium-high"
              : locale === "zh"
                ? "中"
                : "Medium",
        validationType: signal.validationType,
        feedBatchAt: signal.feedBatchAt ?? "",
        valueScore: signal.score,
        heat: signal.heat,
        sourceNames: signal.sourceNames,
        sourceKinds: signal.sources,
        sourceCount: signal.sourceCount,
        tone: tones[index % tones.length],
        crossValidation: signal.crossValidation,
        article: signal.article,
        evidence: signal.evidence,
      }));
    const linkedCuratedIds = new Set<string>();
    const mergedStorySignals = storySignals.map((signal) => {
      const relatedCurated = localizedCuratedExploreSignals.filter(
        (curated) => curated.relatedSignalId === Number(signal.id),
      );
      relatedCurated.forEach((curated) => linkedCuratedIds.add(curated.id));
      const mergedEvidence = [
        ...signal.evidence,
        ...relatedCurated.flatMap((curated) => curated.evidence),
      ].filter(
        (evidence, index, items) =>
          items.findIndex((item) => item.url === evidence.url) === index,
      );
      const sourceNames = [
        ...new Set(mergedEvidence.map((evidence) => evidence.sourceName)),
      ];
      return {
        ...signal,
        valueScore: Math.max(
          signal.valueScore,
          ...relatedCurated.map((curated) => curated.valueScore),
        ),
        heat: [signal.heat, ...relatedCurated.map((curated) => curated.heat)]
          .sort(compareSignalHeat)
          .at(0) ?? signal.heat,
        sourceNames,
        sourceKinds: [
          ...new Set(mergedEvidence.map((evidence) => evidence.sourceKind)),
        ],
        sourceCount: sourceNames.length,
        crossValidation: [
          signal.crossValidation,
          ...relatedCurated.map((curated) => curated.crossValidation),
        ]
          .filter(Boolean)
          .join(" "),
        evidence: mergedEvidence,
      };
    });
    const storyEvidenceUrls = new Set(
      mergedStorySignals.flatMap((signal) =>
        signal.evidence.map((evidence) => evidence.url),
      ),
    );
    const deduplicatedCurated = localizedCuratedExploreSignals.filter(
      (signal) =>
        !linkedCuratedIds.has(signal.id) &&
        !signal.evidence.some((evidence) =>
          storyEvidenceUrls.has(evidence.url),
        ),
    );
    return [...mergedStorySignals, ...deduplicatedCurated];
  }, [locale, localizedCuratedExploreSignals, localizedSignals]);

  const activeExploreSignals = useMemo(
    () => {
      const qualified = localizedExploreSignals.filter(
        (signal) =>
          meetsExploreEditorialFloor(signal),
      );
      return selectAdaptiveFeedItems(qualified, "explore");
    },
    [localizedExploreSignals],
  );

  const exploreKinds = useMemo(
    () => [
      ...new Set(
        activeExploreSignals.flatMap((signal) => signal.sourceKinds),
      ),
    ],
    [activeExploreSignals],
  );

  const localizedCompanySignals = dailyRadar.companySignals.map((item, index) => {
    const translated = languageCopy.companySignals[index];
    const localizedItem = {
      ...item,
      ...translated,
      evidence: item.evidence.map((evidence, evidenceIndex) => ({
        ...evidence,
        takeaway:
          translated.evidence[evidenceIndex]?.takeaway ?? evidence.takeaway,
      })),
    };
    const fallbackArticle = {
      lead: `${localizedItem.whatChanged} ${localizedItem.investmentRead}`,
      sections: [
        {
          heading: t("变化发生在哪里", "Where the change is happening"),
          body: localizedItem.whatChanged,
        },
        {
          heading: t("如何理解这家公司", "How to read the company"),
          body: localizedItem.investmentRead,
        },
        {
          heading: t("催化因素与反证", "Catalysts and disconfirming evidence"),
          body: t(
            `潜在催化因素是${localizedItem.catalyst}。需要警惕的反证是${localizedItem.risk}。`,
            `The potential catalyst is ${localizedItem.catalyst}. The key disconfirming risk is ${localizedItem.risk}.`,
          ),
        },
      ],
      outlook: localizedItem.watchNext,
    };
    return {
      ...localizedItem,
      id: `company-${index}`,
      article: localizedItem.article ?? fallbackArticle,
    };
  });
  const localizedConversations = useMemo(() => {
    const localized = (conversations.items as Conversation[]).map(
      (item, index) => {
        const isChinese = locale === "zh";
        return {
          ...item,
          valueScore: Math.max(80, 94 - Math.floor(index / 2)),
          heat: calculateSignalHeat(
            {
              ...item,
              feedBatchAt: item.feedBatchAt ?? conversations.generatedAt,
            },
            {
              now: heatNow,
              profile: "conversation",
            },
          ),
          categoryKey: item.categoryZh,
          category: isChinese ? item.categoryZh : item.categoryEn,
          title: isChinese ? item.titleZh : item.titleEn,
          dek: isChinese ? item.dekZh : item.dekEn,
          whyListen: isChinese ? item.whyListenZh : item.whyListenEn,
          takeaways: isChinese ? item.takeawaysZh : item.takeawaysEn,
          counterpoint: isChinese
            ? item.counterpointZh
            : item.counterpointEn,
          article: isChinese ? item.articleZh : item.articleEn,
        };
      },
    );
    return localized;
  }, [heatNow, locale]);
  const activeConversations = useMemo(
    () =>
      selectAdaptiveFeedItems(localizedConversations, "conversation"),
    [localizedConversations],
  );
  const trendSignals = useMemo(
    () =>
      activeExploreSignals
        .filter((signal) => signal.sourceCount >= 2)
        .slice(0, 4),
    [activeExploreSignals],
  );
  const discoverySignals = useMemo(() => {
    const trendIds = new Set(trendSignals.map((signal) => signal.id));
    return activeExploreSignals
      .filter(
        (signal) => !trendIds.has(signal.id) && signal.sourceCount >= 2,
      )
      .slice(0, 3);
  }, [activeExploreSignals, trendSignals]);
  const leadCompanySignal = useMemo(
    () =>
      [...localizedCompanySignals].sort(
        (left, right) => right.score - left.score,
      )[0],
    [localizedCompanySignals],
  );

  useEffect(() => {
    if (!routeReady) return;

    const exploreArticle = localizedExploreSignals.find(
      (signal) => signal.id === articleId,
    );
    const companyArticle = localizedCompanySignals.find(
      (signal) => signal.id === articleId,
    );
    const conversationArticle = localizedConversations.find(
      (item) => item.id === articleId,
    );
    const dynamicArticle = localizedSignals.find(
      (signal) => String(signal.id) === articleId,
    );
    const activeArticle =
      conversationArticle ?? exploreArticle ?? companyArticle ?? dynamicArticle;
    const contentType = exploreArticle
      ? "explore"
      : companyArticle
        ? "company"
        : conversationArticle
          ? "conversation"
          : dynamicArticle
            ? "dynamic"
            : section === "sources"
              ? "sources"
              : view === "live"
                ? "live"
              : view === "brief"
                ? "index"
                : view;
    const title =
      activeArticle &&
      ("title" in activeArticle
        ? activeArticle.title
        : "headline" in activeArticle
          ? activeArticle.headline
          : null);
    const path = `${window.location.pathname}${window.location.search}`;

    if (lastTrackedPath.current === path) return;
    lastTrackedPath.current = path;

    trackPageView({
      path,
      title: title ?? "All We Need",
      language: locale,
      contentType,
    });

    if (activeArticle && title) {
      trackAnalyticsEvent("article_open", {
        article_id: String(activeArticle.id),
        article_title: title,
        content_type: contentType,
        language: locale,
      });
    }
  }, [
    articleId,
    locale,
    routeReady,
    localizedConversations,
    section,
    view,
  ]);

  const analysisTimeLabel = new Intl.DateTimeFormat(
    locale === "zh" ? "zh-CN" : "en-US",
    {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "America/New_York",
    },
  ).format(new Date(dailyRadar.generatedAt));
  const liveScanTimeLabel = new Intl.DateTimeFormat(
    locale === "zh" ? "zh-CN" : "en-US",
    {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "America/New_York",
    },
  ).format(new Date(liveFeed.generatedAt));

  const visibleSignals = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return localizedDynamicSignals.filter((signal) => {
      const matchesCategory =
        activeCategory === "全部" || signal.categoryKey === activeCategory;
      const matchesQuery =
        !normalized ||
        `${signal.title} ${signal.summary} ${signal.sources.join(" ")} ${signal.sourceNames.join(" ")}`
          .toLowerCase()
          .includes(normalized);
      return matchesCategory && matchesQuery;
    });
  }, [activeCategory, localizedDynamicSignals, query]);

  const visibleLiveItems = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return liveStreamItems.filter((item) => {
      const matchesCategory =
        activeCategory === "全部" || item.categoryKey === activeCategory;
      const matchesQuery =
        !normalized ||
        `${item.title} ${item.sourceName} ${item.sourcePublisher ?? ""} ${item.sourceKind}`
          .toLowerCase()
          .includes(normalized);
      return matchesCategory && matchesQuery;
    });
  }, [activeCategory, liveStreamItems, query]);

  const liveLeadItems = useMemo(() => {
    return visibleLiveItems
      .slice(0, 10);
  }, [visibleLiveItems]);

  const visibleExploreSignals = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return activeExploreSignals.filter((signal) => {
      const matchesCategory =
        activeCategory === "全部" || signal.categoryKey === activeCategory;
      const matchesQuery =
        !normalized ||
        `${signal.title} ${signal.thesis} ${signal.whyNow} ${signal.sourceNames.join(" ")}`
          .toLowerCase()
          .includes(normalized);
      return matchesCategory && matchesQuery;
    });
  }, [activeCategory, activeExploreSignals, query]);

  const visibleConversations = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return activeConversations.filter((item) => {
      const matchesCategory =
        activeCategory === "全部" || item.categoryKey === activeCategory;
      const matchesQuery =
        !normalized ||
        `${item.title} ${item.dek} ${item.guest} ${item.sourceName} ${item.originalTitle}`
          .toLowerCase()
          .includes(normalized);
      return matchesCategory && matchesQuery;
    });
  }, [activeCategory, activeConversations, query]);

  const activeCategories = useMemo(() => {
    const displayItems =
      view === "live"
        ? liveStreamItems
        : view === "explore"
        ? activeExploreSignals
        : view === "conversations"
          ? activeConversations
          : localizedDynamicSignals;
    const labels = new Map<string, string>();
    displayItems.forEach((item) => {
      labels.set(item.categoryKey, item.category);
    });
    return [
      { value: "全部", label: t("全部", "All") },
      ...[...labels].map(([value, label]) => ({ value, label })),
    ];
  }, [
    activeExploreSignals,
    activeConversations,
    liveStreamItems,
    locale,
    localizedDynamicSignals,
    view,
  ]);

  function resetFeedFilters() {
    setActiveCategory("全部");
    setQuery("");
  }

  function pushSectionPath(pathname: string) {
    const url = new URL(window.location.href);
    url.pathname = pathname;
    url.search = "";
    if (
      window.location.pathname !== url.pathname ||
      window.location.search !== url.search
    ) {
      window.history.pushState({}, "", url);
    }
    setArticleId(null);
  }

  function switchView(nextView: RadarView) {
    resetFeedFilters();
    setView(nextView);
    setSection("radar");
    pushSectionPath(pathForView(nextView));
  }

  function switchToSources() {
    resetFeedFilters();
    setSection("sources");
    pushSectionPath(sectionPath("sources"));
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  function exploreMore() {
    switchView("explore");
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  function briefMore() {
    switchView("brief");
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  function conversationsMore() {
    switchView("conversations");
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  function toggleSaved(id: number) {
    setSaved((items) =>
      items.includes(id) ? items.filter((item) => item !== id) : [...items, id],
    );
  }

  function showNotice(message: string) {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 2600);
  }

  function changeFontSize(nextFontSize: FontSizePreference) {
    setFontSize(nextFontSize);
    document.documentElement.dataset.fontSize = nextFontSize;
    window.localStorage.setItem("all-we-need-font-size", nextFontSize);
    trackAnalyticsEvent("font_size_change", {
      font_size: nextFontSize,
      language: locale,
    });
  }

  function openArticle(id: number | string) {
    const normalizedId = String(id);
    const url = new URL(window.location.href);
    url.searchParams.set("article", normalizedId);
    window.history.pushState({}, "", url);
    setArticleId(normalizedId);
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  function closeArticle() {
    const url = new URL(window.location.href);
    url.searchParams.delete("article");
    window.history.replaceState({}, "", url);
    setArticleId(null);
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  const activeConversationArticle = localizedConversations.find(
    (item) => item.id === articleId,
  );
  if (activeConversationArticle) {
    return (
      <ArticleView
        signal={{
          id: activeConversationArticle.id,
          publishedAt: activeConversationArticle.publishedAt,
          originalTitle: activeConversationArticle.originalTitle,
          guest: activeConversationArticle.guest,
          durationMinutes: activeConversationArticle.durationMinutes,
          category: activeConversationArticle.category,
          eyebrow: t("本周精选", "WEEKLY PICK"),
          title: activeConversationArticle.title,
          summary: activeConversationArticle.dek,
          why: activeConversationArticle.whyListen,
          impact: activeConversationArticle.counterpoint,
          crossValidation: activeConversationArticle.whyListen,
          validationType: "单一来源",
          sourceCount: 1,
          article: activeConversationArticle.article,
          evidence: [
            {
              sourceName: activeConversationArticle.sourceName,
              sourceKind: activeConversationArticle.sourceKind,
              title: activeConversationArticle.originalTitle,
              url: activeConversationArticle.url,
              publishedAt: activeConversationArticle.publishedAt,
              role: t("完整节目", "Full episode"),
              takeaway: activeConversationArticle.whyListen,
            },
          ],
        }}
        locale={locale}
        generatedAt={conversations.generatedAt}
        kind="conversation"
        fontSize={fontSize}
        onLocaleChange={setLocale}
        onFontSizeChange={changeFontSize}
        onBack={closeArticle}
      />
    );
  }

  const activeExploreArticle = localizedExploreSignals.find(
    (signal) => signal.id === articleId,
  );
  if (activeExploreArticle) {
    return (
      <ArticleView
        signal={{
          id: activeExploreArticle.id,
          category: activeExploreArticle.category,
          eyebrow: activeExploreArticle.label,
          title: activeExploreArticle.title,
          summary: activeExploreArticle.thesis,
          why: activeExploreArticle.whyNow,
          impact: activeExploreArticle.counterpoint,
          crossValidation:
            activeExploreArticle.crossValidation ??
            activeExploreArticle.thesis,
          validationType: activeExploreArticle.validationType,
          sourceCount: activeExploreArticle.sourceCount,
          confidence: activeExploreArticle.confidence,
          article: activeExploreArticle.article,
          evidence: activeExploreArticle.evidence,
        }}
        locale={locale}
        generatedAt={dailyRadar.generatedAt}
        kind="explore"
        fontSize={fontSize}
        onLocaleChange={setLocale}
        onFontSizeChange={changeFontSize}
        onBack={closeArticle}
      />
    );
  }
  const activeCompanyArticle = localizedCompanySignals.find(
    (signal) => signal.id === articleId,
  );
  if (activeCompanyArticle) {
    return (
      <ArticleView
        signal={{
          id: activeCompanyArticle.id,
          category: t("投资与公司信号", "Investment & Company Signals"),
          eyebrow: activeCompanyArticle.signalType,
          title: activeCompanyArticle.headline,
          summary: activeCompanyArticle.whatChanged,
          why: activeCompanyArticle.investmentRead,
          impact: activeCompanyArticle.risk,
          crossValidation:
            activeCompanyArticle.crossValidation ??
            activeCompanyArticle.evidence
              .map(
                (evidence) =>
                  `${evidence.sourceName}: ${evidence.takeaway}`,
              )
              .join(" "),
          validationType: activeCompanyArticle.validationType as
            | "跨平台验证"
            | "多账号验证"
            | "单一来源",
          sourceCount: activeCompanyArticle.sourceCount,
          score: activeCompanyArticle.score,
          article: activeCompanyArticle.article,
          evidence: activeCompanyArticle.evidence,
        }}
        locale={locale}
        generatedAt={dailyRadar.generatedAt}
        kind="company"
        fontSize={fontSize}
        onLocaleChange={setLocale}
        onFontSizeChange={changeFontSize}
        onBack={closeArticle}
      />
    );
  }
  const activeArticle = localizedSignals.find(
    (signal) => String(signal.id) === articleId,
  );
  if (activeArticle) {
    return (
      <ArticleView
        signal={activeArticle}
        locale={locale}
        generatedAt={dailyRadar.generatedAt}
        fontSize={fontSize}
        onLocaleChange={setLocale}
        onFontSizeChange={changeFontSize}
        onBack={closeArticle}
      />
    );
  }

  return (
    <main className={`app-shell view-${view}`}>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            A
          </span>
          <span>All We Need</span>
        </div>

        <nav className="side-nav" aria-label={t("主要导航", "Primary navigation")}>
          <a
            className={`nav-item ${section === "radar" && view === "live" ? "active" : ""}`}
            href={sectionPath("live")}
            onClick={(event) => {
              event.preventDefault();
              switchView("live");
            }}
          >
            <span aria-hidden="true">◉</span>
            {t("动态", "Live")}
            <span className="nav-count">{liveStreamItems.length}</span>
          </a>
          <a
            className={`nav-item ${section === "radar" && view === "brief" ? "active" : ""}`}
            href={sectionPath("brief")}
            onClick={(event) => {
              event.preventDefault();
              switchView("brief");
            }}
          >
            <span aria-hidden="true">⌁</span>
            {t("焦点", "Focus")}
            <span className="nav-count">{localizedDynamicSignals.length}</span>
          </a>
          <a
            className={`nav-item ${section === "radar" && view === "explore" ? "active" : ""}`}
            href={sectionPath("explore")}
            onClick={(event) => {
              event.preventDefault();
              switchView("explore");
            }}
          >
            <span aria-hidden="true">◎</span>
            {t("探索", "Explore")}
            <span className="nav-count">{activeExploreSignals.length}</span>
          </a>
          <a
            className={`nav-item ${section === "radar" && view === "conversations" ? "active" : ""}`}
            href={sectionPath("conversations")}
            onClick={(event) => {
              event.preventDefault();
              switchView("conversations");
            }}
          >
            <span aria-hidden="true">◌</span>
            {t("播客", "Podcasts")}
            <span className="nav-count">{activeConversations.length}</span>
          </a>
          <a
            className={`nav-item ${section === "sources" ? "active" : ""}`}
            href={sectionPath("sources")}
            onClick={(event) => {
              event.preventDefault();
              switchToSources();
            }}
          >
            <span aria-hidden="true">◇</span>
            {t("信源库", "Sources")}
          </a>
          <button
            className="nav-item"
            type="button"
            onClick={() =>
              showNotice(
                t(
                  `已收藏 ${saved.length} 条情报`,
                  `${saved.length} signals saved`,
                ),
              )
            }
          >
            <span aria-hidden="true">☆</span>
            {t("已收藏", "Saved")}
            {saved.length > 0 && <span className="nav-count">{saved.length}</span>}
          </button>
        </nav>

        <div className="side-section">
          <p className="side-label">{t("你的雷达", "YOUR RADAR")}</p>
          {(locale === "zh"
            ? ["AI 与模型", "智能体", "算力与芯片", "VC 动态"]
            : ["AI & Models", "Agents", "Compute & Chips", "Venture"]
          ).map(
            (item, index) => (
              <button className="topic-item" type="button" key={item}>
                <span className={`topic-dot dot-${index + 1}`} />
                {item}
              </button>
            ),
          )}
          <button
            className="add-topic"
            type="button"
            onClick={() =>
              showNotice(
                t(
                  "主题管理将在数据接入阶段开放",
                  "Topic management will arrive with data connections",
                ),
              )
            }
          >
            {t("＋ 添加主题", "+ Add topic")}
          </button>
        </div>

        <div className="coverage-card">
          <div className="coverage-top">
            <span>{t("真实采集", "LIVE INGEST")}</span>
            <span className="live-dot">{t("已运行", "Running")}</span>
          </div>
          <strong>{publicSnapshotItems.length.toLocaleString()}</strong>
          <p>{t("条真实内容已抓取", "real items fetched")}</p>
          <div className="coverage-grid">
            <span>YouTube · {configuredKindCounts.YouTube ?? 0}</span>
            <span>
              {t("博客", "Blog")} · {configuredKindCounts.Blog ?? 0}
            </span>
            <span>
              {t("美联储", "Fed")} · {configuredKindCounts.Fed ?? 0}
            </span>
            <span>SEC · {configuredKindCounts.SEC ?? 0}</span>
            <span>
              X · {publicNeedsAuthSources} {t("待授权", "pending auth")}
            </span>
            <span>
              {t("连接", "Live")} · {publicSuccessfulSources}
            </span>
          </div>
        </div>

        <div className="profile">
          <span className="avatar">YQ</span>
          <div>
            <strong>{t("研究小组", "Research Group")}</strong>
            <span>{t("3 位成员", "3 members")}</span>
          </div>
          <button
            type="button"
            aria-label={t("打开账户设置", "Open account settings")}
            onClick={() =>
              showNotice(
                t(
                  "账户与成员设置尚未接入",
                  "Account and member settings are not connected yet",
                ),
              )
            }
          >
            •••
          </button>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="mobile-brand">
            <span className="brand-mark">A</span>
            <span>All We Need</span>
          </div>
          {section === "radar" ? (
            <label className="search">
              <span aria-hidden="true">⌕</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={
                  view === "conversations"
                    ? t(
                        "搜索节目、嘉宾或主题",
                        "Search shows, guests, or topics",
                      )
                    : t(
                        "搜索事件、公司、人物或主题",
                        "Search events, companies, people, or topics",
                      )
                }
                aria-label={t("搜索情报", "Search intelligence")}
              />
              <kbd>⌘ K</kbd>
            </label>
          ) : (
            <div className="source-top-context">
              <span className="live-dot">
                {t("抓取器在线", "Fetcher online")}
              </span>
              <span>
                {publicSuccessfulSources} / {publicSourceCatalog.length}{" "}
                {t("个来源已连接", "sources connected")}
              </span>
            </div>
          )}
          <div className="top-actions">
            <div
              className="language-switch"
              role="group"
              aria-label={t("语言切换", "Language switcher")}
            >
              <button
                type="button"
                className={locale === "zh" ? "selected" : ""}
                aria-pressed={locale === "zh"}
                onClick={() => setLocale("zh")}
              >
                中文
              </button>
              <button
                type="button"
                className={locale === "en" ? "selected" : ""}
                aria-pressed={locale === "en"}
                onClick={() => setLocale("en")}
              >
                EN
              </button>
            </div>
            <FontSizeControl
              value={fontSize}
              locale={locale}
              onChange={changeFontSize}
            />
          </div>
        </header>

        <div className="content">
          {section === "sources" ? (
            <SourceLibrary locale={locale} onNotice={showNotice} />
          ) : (
            <>
          <section className="page-intro">
            <div>
              <p className="date-line">
                {view === "conversations"
                  ? t(
                      "本周精选 · 从公开对谈中提炼值得带走的判断",
                      "This week’s picks · The ideas worth carrying forward",
                    )
                  : view === "live"
                    ? t(
                        `实时采集 · 最近扫描 ${liveScanTimeLabel}`,
                        `Live ingest · Last scanned ${liveScanTimeLabel}`,
                      )
                  : t(
                      `持续更新 · 最近更新 ${analysisTimeLabel}`,
                      `Continuous feed · Updated ${analysisTimeLabel}`,
                    )}
              </p>
              <h1>
                {view === "live" ? (
                  <>
                    {t("信息正在发生，", "See it as it happens.")}
                    <br />
                    {locale === "zh" ? (
                      <>
                        最近 6 小时{" "}
                        <span>{liveStreamItems.length} 条动态</span>
                      </>
                    ) : (
                      <>
                        <span>{liveStreamItems.length} updates</span> in the last
                        6 hours
                      </>
                    )}
                  </>
                ) : view === "brief" ? (
                  <>
                    {t("真正值得关注的变化，", "The shifts that matter,")}
                    <br />
                    {locale === "zh" ? (
                      <>
                        已形成{" "}
                        <span>{localizedDynamicSignals.length} 条动态</span>
                      </>
                    ) : (
                      <>
                        worth watching:{" "}
                        <span>{localizedDynamicSignals.length} updates</span>
                      </>
                    )}
                  </>
                ) : view === "explore" ? (
                  <>
                    {t("去共识之外，", "Look beyond consensus.")}
                    <br />
                    {locale === "zh" ? (
                      <>
                        发现 <span>{activeExploreSignals.length} 种可能</span>
                      </>
                    ) : (
                      <>
                        Explore{" "}
                        <span>{activeExploreSignals.length} possibilities</span>
                      </>
                    )}
                  </>
                ) : (
                  <>
                    {t("本周值得听的播客，", "The week’s best podcasts,")}
                    <br />
                    {locale === "zh" ? (
                      <>
                        已压缩成{" "}
                        <span>{activeConversations.length} 份精读</span>
                      </>
                    ) : (
                      <>
                        distilled into{" "}
                        <span>{activeConversations.length} sharp notes</span>
                      </>
                    )}
                  </>
                )}
              </h1>
              <p className="intro-copy">
                {view === "live" ? (
                  <>
                    {t(
                      "来自公开一手信源的连续时间线。按发布时间倒序，只做轻量去重；需要判断和验证的内容会进入焦点。",
                      "A continuous timeline from public original sources, ordered by publication time with lightweight deduplication. The items that warrant judgment and verification graduate into Focus.",
                    )}
                  </>
                ) : view === "brief" ? (
                  <>
                    {t(
                      "将分散的信息噪声压缩为少数值得判断的变化，让事实、共识与转折在同一条脉络中显现。",
                      "Distilling a fragmented information landscape into a small set of consequential shifts—where facts, consensus, and inflection points resolve into one coherent view.",
                    )}
                  </>
                ) : view === "explore" ? (
                  <>
                    {t(
                      "在共识尚未成形之处，辨认结构性张力、隐性因果，以及足以重估未来的微弱先兆。",
                      "Mapping the terrain before consensus forms: structural tensions, hidden causal chains, and faint signals capable of repricing the future.",
                    )}
                  </>
                ) : (
                  <>
                    {t(
                      "跳过冗长铺垫，直接进入受访者的核心判断、论证细节与最强反方；想深入时，再回到完整节目。",
                      "Skip the long runway and go straight to each speaker’s central claim, supporting detail, and strongest counterpoint—then return to the full program when it earns your time.",
                    )}
                  </>
                )}
              </p>
            </div>
            <div className="brief-score">
              <div>
                <span className="score-ring">
                  {view === "live"
                    ? liveStreamItems.length
                    : view === "brief"
                    ? dailyRadar.signalQuality
                    : view === "explore"
                      ? new Set(
                          activeExploreSignals.map(
                            (signal) => signal.categoryKey,
                          ),
                        ).size
                      : activeConversations.length}
                </span>
                <span>
                  {view === "live"
                    ? t("6 小时信息流", "6-hour live stream")
                    : view === "brief"
                    ? t("当前信号质量", "Current Signal Quality")
                    : view === "explore"
                      ? t("探索主题覆盖", "Explore Coverage")
                      : t("本周播客精选", "Weekly Podcast Picks")}
                  <small>
                    {view === "live"
                      ? t(
                          `${new Set(liveStreamItems.map((item) => item.sourceName)).size} 个活跃来源`,
                          `${new Set(liveStreamItems.map((item) => item.sourceName)).size} active sources`,
                        )
                      : view === "brief"
                      ? t(
                          `较基准 ${
                            dailyRadar.signalQualityChange >= 0 ? "高" : "低"
                          } ${Math.abs(dailyRadar.signalQualityChange)}%`,
                          `${Math.abs(dailyRadar.signalQualityChange)}% ${
                            dailyRadar.signalQualityChange >= 0 ? "above" : "below"
                          } baseline`,
                        )
                      : view === "explore"
                        ? t(
                            `${activeExploreSignals.length} 个持续追踪方向`,
                            `${activeExploreSignals.length} ongoing directions`,
                          )
                        : t(
                            `${activeConversations.length} 份完整字幕精读`,
                            `${activeConversations.length} full-transcript reads`,
                          )}
                  </small>
                </span>
              </div>
              <div
                className="source-stack"
                aria-label={t("已覆盖平台", "Platforms covered")}
              >
                {(view === "brief"
                  ? coveredKinds
                  : view === "live"
                    ? [...new Set(liveStreamItems.map((item) => item.sourceKind))]
                  : view === "explore"
                    ? exploreKinds
                    : locale === "zh"
                      ? ["访谈", "Podcast", "长对话"]
                      : ["Interviews", "Podcasts", "Long-form"]
                ).map((kind) => (
                  <span key={kind}>{shortKind(kind, locale)}</span>
                ))}
              </div>
            </div>
          </section>

          <div className="view-row">
            <div
              className="view-switch"
              aria-label={t("内容视图", "Content view")}
            >
              <a
                className={view === "live" ? "selected" : ""}
                href={sectionPath("live")}
                onClick={(event) => {
                  event.preventDefault();
                  switchView("live");
                }}
              >
                {t("动态", "Live")}
              </a>
              <a
                className={view === "brief" ? "selected" : ""}
                href={sectionPath("brief")}
                onClick={(event) => {
                  event.preventDefault();
                  switchView("brief");
                }}
              >
                {t("焦点", "Focus")}
              </a>
              <a
                className={view === "explore" ? "selected" : ""}
                href={sectionPath("explore")}
                onClick={(event) => {
                  event.preventDefault();
                  switchView("explore");
                }}
              >
                {t("探索", "Explore Feed")}
              </a>
              <a
                className={view === "conversations" ? "selected" : ""}
                href={sectionPath("conversations")}
                onClick={(event) => {
                  event.preventDefault();
                  switchView("conversations");
                }}
              >
                {t("播客", "Podcasts")}
              </a>
            </div>
            <div
              className="category-filters"
              aria-label={t("主题筛选", "Topic filters")}
            >
              {activeCategories.map((category) => (
                <button
                  type="button"
                  key={category.value}
                  className={
                    activeCategory === category.value ? "selected" : ""
                  }
                  onClick={() => setActiveCategory(category.value)}
                >
                  {category.label}
                </button>
              ))}
            </div>
          </div>

          <div
            className={`dashboard-grid ${
              view === "live"
                ? "live-layout"
                : view === "explore"
                ? "explore-layout"
                : view === "conversations"
                  ? "conversation-layout"
                  : ""
            }`}
          >
            <section className="feed-column">
              <div className="section-heading">
                <div>
                  <span className="section-kicker">
                    {view === "live"
                      ? t("持续采集", "LIVE WIRE")
                      : view === "brief"
                      ? t("持续更新", "LIVE FEED")
                      : view === "explore"
                        ? t("探索发现", "DISCOVERY FEED")
                        : t("本周精选", "THIS WEEK’S PICKS")}
                  </span>
                  <h2>
                    {view === "live"
                      ? t("刚刚发生", "Just in")
                      : view === "brief"
                      ? t("关键焦点", "Key Focus")
                      : view === "explore"
                        ? t(
                            "为你发现的高信号内容",
                            "High-Signal Discoveries",
                          )
                        : t("本周值得听什么", "What’s worth listening to")}
                  </h2>
                </div>
                <span className="result-count">
                  {view === "live"
                    ? t(
                        `${visibleLiveItems.length} 条原始更新`,
                        `${visibleLiveItems.length} source updates`,
                      )
                    : view === "brief"
                    ? t(
                        `${visibleSignals.length} 个事件簇`,
                        `${visibleSignals.length} event clusters`,
                      )
                    : view === "explore"
                      ? t(
                          `${visibleExploreSignals.length} 个探索方向`,
                          `${visibleExploreSignals.length} directions`,
                        )
                      : t(
                          `${visibleConversations.length} 期精选`,
                          `${visibleConversations.length} selected`,
                        )}
                </span>
              </div>

              {view === "live" ? (
                <div className="live-wire">
                  {liveLeadItems.length > 0 && (
                    <section className="live-lead-section">
                      <div className="live-band-heading">
                        <span className="live-pulse" aria-hidden="true" />
                        <strong>{t("正在发生", "Happening now")}</strong>
                      </div>
                      <div className="live-lead-grid">
                        {liveLeadItems.map((item) => (
                          <article className="live-lead-item" key={item.id}>
                            <div>
                              <time dateTime={item.activityAt}>
                                {formatLiveAge(
                                  item.activityAt,
                                  heatNow,
                                  locale,
                                )}
                              </time>
                              <span>{item.sourceName}</span>
                              {item.discoveredThroughCluster && (
                                <em>{t("多源跟进", "Clustered")}</em>
                              )}
                            </div>
                            <a
                              href={item.url}
                              target="_blank"
                              rel="noreferrer"
                              onClick={() =>
                                trackAnalyticsEvent("live_item_open", {
                                  source_id: item.sourceId,
                                  source_name: item.sourceName,
                                  source_kind: item.sourceKind,
                                  item_url: item.url,
                                  language: locale,
                                  placement: "happening_now",
                                })
                              }
                            >
                              <span>{item.title}</span>
                              <StoryLinkIcon />
                            </a>
                          </article>
                        ))}
                      </div>
                    </section>
                  )}

                  {visibleLiveItems.length === 0 && (
                    <div className="empty-state">
                      <span>⌕</span>
                      <strong>
                        {t("没有找到匹配的动态", "No matching live updates")}
                      </strong>
                      <p>
                        {t(
                          "换一个关键词或清除来源筛选。",
                          "Try another keyword or clear the source filter.",
                        )}
                      </p>
                      <button
                        type="button"
                        onClick={() => {
                          setQuery("");
                          setActiveCategory("全部");
                        }}
                      >
                        {t("清除筛选", "Clear filters")}
                      </button>
                    </div>
                  )}

                </div>
              ) : view === "brief" ? (
              <div className="signal-list">
                {visibleSignals.map((signal, index) => {
                  const isSaved = saved.includes(signal.id);
                  return (
                    <article
                      className={`signal-card tone-${signal.tone}`}
                      key={signal.id}
                    >
                      <div className="rank">0{index + 1}</div>
                      <div className="signal-content">
                        <div className="signal-meta">
                          <span className="eyebrow">{signal.eyebrow}</span>
                          <span>{signal.category}</span>
                          <span>·</span>
                          <span>
                            {formatExposureAge(signal.heat.ageHours, locale)}
                          </span>
                          {isAdaptiveBackfill(signal.heat, "dynamic") && (
                            <span className="adaptive-backfill">
                              {t("精选回看", "Selected replay")}
                            </span>
                          )}
                          <span
                            className="heat-status"
                            data-stage={signal.heat.stage}
                          >
                            {heatLabel(signal.heat, locale)}
                          </span>
                        </div>
                        <a
                          href={`?article=${signal.id}`}
                          className="signal-title"
                          onClick={(event) => {
                            event.preventDefault();
                            openArticle(signal.id);
                          }}
                        >
                          <span>{signal.title}</span>
                          <StoryLinkIcon />
                        </a>
                        <p className="signal-summary">{signal.summary}</p>

                        <div className="signal-footer">
                          <div className="source-pills">
                            {signal.sources.map((source) => (
                              <span key={source}>
                                {shortKind(source, locale)}
                              </span>
                            ))}
                            <small>
                              {t(
                                `${signal.validationType} · ${signal.sourceCount} 个独立账号`,
                                `${
                                  signal.validationType === "跨平台验证"
                                    ? "Cross-platform"
                                    : signal.validationType === "多账号验证"
                                      ? "Multi-source"
                                      : "Single source"
                                } · ${signal.sourceCount} independent sources`,
                              )}
                            </small>
                          </div>
                          <div className="card-actions">
                            <span className="signal-score">
                              <i style={{ width: `${signal.score}%` }} />
                              {signal.score}
                            </span>
                            <button
                              type="button"
                              className={isSaved ? "saved" : ""}
                              aria-label={
                                isSaved
                                  ? t("取消收藏", "Remove from saved")
                                  : t("收藏此信号", "Save this signal")
                              }
                              onClick={() => toggleSaved(signal.id)}
                            >
                              {isSaved ? "★" : "☆"}
                            </button>
                          </div>
                        </div>
                      </div>
                    </article>
                  );
                })}

                {visibleSignals.length === 0 && (
                  <div className="empty-state">
                    <span>⌕</span>
                    <strong>
                      {t("没有找到匹配的情报", "No matching intelligence")}
                    </strong>
                    <p>
                      {t(
                        "换一个关键词或清除主题筛选。",
                        "Try another keyword or clear the topic filter.",
                      )}
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        setQuery("");
                        setActiveCategory("全部");
                      }}
                    >
                      {t("清除筛选", "Clear filters")}
                    </button>
                  </div>
                )}

              </div>
              ) : view === "explore" ? (
                <div className="explore-grid">
                  {visibleExploreSignals.map((signal, index) => {
                    return (
                      <article
                        className={`explore-card explore-tone-${signal.tone} ${
                          index === 0 ? "explore-featured" : ""
                        }`}
                        key={signal.id}
                      >
                        <div className="explore-card-top">
                          <span className="explore-number">0{index + 1}</span>
                          <span className="explore-category">{signal.category}</span>
                          <span className="explore-label">{signal.label}</span>
                          <time
                            className="explore-exposure-time"
                            dateTime={signal.heat.lastActivityAt}
                            title={new Intl.DateTimeFormat(
                              locale === "zh" ? "zh-CN" : "en-US",
                              {
                                year: "numeric",
                                month: "short",
                                day: "numeric",
                                hour: "2-digit",
                                minute: "2-digit",
                                timeZone: "America/New_York",
                              },
                            ).format(new Date(signal.heat.lastActivityAt))}
                          >
                            {formatExposureAge(signal.heat.ageHours, locale)}
                          </time>
                          {isAdaptiveBackfill(signal.heat, "explore") && (
                            <span className="adaptive-backfill">
                              {t("精选回看", "Selected replay")}
                            </span>
                          )}
                          <span
                            className="heat-status"
                            data-stage={signal.heat.stage}
                          >
                            {heatLabel(signal.heat, locale)}
                          </span>
                        </div>

                        <h3>
                          <a
                            href={`?article=${signal.id}`}
                            onClick={(event) => {
                              event.preventDefault();
                              openArticle(signal.id);
                            }}
                          >
                            <span>{signal.title}</span>
                            <StoryLinkIcon />
                          </a>
                        </h3>
                        <p className="explore-thesis">{signal.thesis}</p>
                      </article>
                    );
                  })}

                  {visibleExploreSignals.length === 0 && (
                    <div className="empty-state explore-empty">
                      <span>⌁</span>
                      <strong>
                        {t(
                          "这个方向暂时没有探索信号",
                          "No Explore signals in this direction",
                        )}
                      </strong>
                      <p>
                        {t(
                          "换一个主题或清除筛选。",
                          "Try another topic or clear the filters.",
                        )}
                      </p>
                      <button
                        type="button"
                        onClick={() => {
                          setQuery("");
                          setActiveCategory("全部");
                        }}
                      >
                        {t("清除筛选", "Clear filters")}
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="conversation-grid">
                  {visibleConversations.map((item, index) => {
                    const publishedLabel = new Intl.DateTimeFormat(
                      locale === "zh" ? "zh-CN" : "en-US",
                      {
                        month: "short",
                        day: "numeric",
                        timeZone: "America/New_York",
                      },
                    ).format(new Date(item.publishedAt));
                    return (
                      <article
                        className={`conversation-card ${
                          index === 0 ? "conversation-featured" : ""
                        }`}
                        key={item.id}
                      >
                        <div className="conversation-card-head">
                          <span className="conversation-rank">
                            {String(index + 1).padStart(2, "0")}
                          </span>
                          <span className="conversation-category">
                            {item.category}
                          </span>
                          <span>{item.sourceName}</span>
                          <span>·</span>
                          <time dateTime={item.publishedAt}>{publishedLabel}</time>
                          {isAdaptiveBackfill(item.heat, "conversation") && (
                            <span className="adaptive-backfill">
                              {t("精选回看", "Selected replay")}
                            </span>
                          )}
                          <span className="conversation-duration">
                            {item.durationMinutes} min
                          </span>
                        </div>

                        <h3>
                          <a
                            href={`?article=${item.id}`}
                            onClick={(event) => {
                              event.preventDefault();
                              openArticle(item.id);
                            }}
                          >
                            <span>{item.title}</span>
                            <StoryLinkIcon />
                          </a>
                        </h3>
                        <p className="conversation-dek">{item.dek}</p>
                        <div className="conversation-speaker">
                          <span>{t("对谈人", "WITH")}</span>
                          <strong>{item.guest}</strong>
                        </div>

                        <footer className="conversation-card-actions">
                          <a
                            href={`?article=${item.id}`}
                            onClick={(event) => {
                              event.preventDefault();
                              openArticle(item.id);
                            }}
                          >
                            {t("阅读精读", "Read notes")}
                            <span aria-hidden="true">→</span>
                          </a>
                        </footer>
                      </article>
                    );
                  })}

                  {visibleConversations.length === 0 && (
                    <div className="empty-state conversation-empty">
                      <span>◌</span>
                      <strong>
                        {t(
                          "没有找到匹配的播客",
                          "No matching podcasts",
                        )}
                      </strong>
                      <p>
                        {t(
                          "换一个主题、嘉宾或节目名称。",
                          "Try another topic, guest, or show.",
                        )}
                      </p>
                      <button
                        type="button"
                        onClick={() => {
                          setQuery("");
                          setActiveCategory("全部");
                        }}
                      >
                        {t("清除筛选", "Clear filters")}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </section>

            {view === "brief" && !isMobileLayout && (
            <aside className="insight-column">
              <section className="panel trend-panel">
                <div className="panel-heading">
                  <div>
                    <span className="section-kicker">
                      {t("趋势假设", "EMERGING SHIFTS")}
                    </span>
                    <h2>{t("正在形成的变化", "Changes Taking Shape")}</h2>
                  </div>
                  <span className="analysis-method-badge">
                    {t("仅多源", "MULTI-SOURCE")}
                  </span>
                </div>
                <div className="trend-list">
                  {trendSignals.map((signal) => (
                    <article className="trend-row" key={signal.id}>
                      <div className="trend-row-heading">
                        <strong>{signal.title}</strong>
                        <span>{signal.label}</span>
                      </div>
                      <p>{signal.whyNow}</p>
                      <small>
                        {t(
                          `${signal.sourceCount} 个独立信源 · ${signal.horizon}`,
                          `${signal.sourceCount} independent sources · ${signal.horizon}`,
                        )}
                      </small>
                    </article>
                  ))}
                </div>
                <p className="panel-note">
                  {t(
                    "只收录至少两个独立信源支撑、且具备可验证后续指标的方向。",
                    "Only directions supported by at least two independent sources and a falsifiable next check.",
                  )}
                </p>
              </section>

              <section className="panel discovery-panel">
                <div className="panel-heading">
                  <div>
                    <span className="section-kicker">
                      {t("为你发现", "DISCOVERED FOR YOU")}
                    </span>
                    <h2>{t("值得展开的判断", "Ideas Worth Opening")}</h2>
                  </div>
                  <span className="new-badge">
                    {t(
                      `${discoverySignals.length} 个精选`,
                      `${discoverySignals.length} CURATED`,
                    )}
                  </span>
                </div>
                <div className="discovery-list">
                  {discoverySignals.map((signal, index) => (
                      <article key={signal.id}>
                        <span className={`discovery-mark tone-${signal.tone}`}>
                          0{index + 1}
                        </span>
                        <div>
                          <strong>
                            <a
                              href={`?article=${signal.id}`}
                              onClick={(event) => {
                                event.preventDefault();
                                openArticle(signal.id);
                              }}
                            >
                              {signal.title}
                            </a>
                          </strong>
                          <p>{signal.thesis}</p>
                          <small>
                            {t(
                              `${signal.category} · ${signal.sourceCount} 个信源`,
                              `${signal.category} · ${signal.sourceCount} sources`,
                            )}
                          </small>
                        </div>
                        <button
                          type="button"
                          onClick={() => openArticle(signal.id)}
                        >
                          {t("阅读", "Read")}
                        </button>
                      </article>
                  ))}
                </div>
              </section>

              {leadCompanySignal && (
                <section className="panel thesis-panel">
                <span className="section-kicker">
                  {t("投资视角", "INVESTMENT LENS")}
                </span>
                <h2>{t("首要公司变量", "Primary Company Variable")}</h2>
                <blockquote>
                  “{leadCompanySignal.headline}”
                </blockquote>
                <p className="thesis-summary">
                  {leadCompanySignal.investmentRead.length > 180
                    ? `${leadCompanySignal.investmentRead.slice(0, 180)}…`
                    : leadCompanySignal.investmentRead}
                </p>
                <div className="thesis-footer">
                  <div className="confidence">
                    <span>{t("公司信号分", "Company signal score")}</span>
                    <strong>{leadCompanySignal.score}/100</strong>
                  </div>
                  <span className="team-agree">
                    {t(
                      `${leadCompanySignal.sourceCount} 个独立信源 · ${leadCompanySignal.signalType}`,
                      `${leadCompanySignal.sourceCount} independent sources · ${leadCompanySignal.signalType}`,
                    )}
                  </span>
                </div>
                <button
                  className="thesis-action"
                  type="button"
                  onClick={() => openArticle(leadCompanySignal.id)}
                >
                  {t("查看完整公司判断", "Open the full company read")}
                  <span>→</span>
                </button>
              </section>
              )}
            </aside>
            )}
          </div>

          {view === "brief" && !isMobileLayout && (
          <section className="signal-table-section">
            <div className="section-heading">
              <div>
                <span className="section-kicker">
                  {t("资本与公司信号", "CAPITAL & COMPANY SIGNALS")}
                </span>
                <h2>
                  {t("投资与公司信号", "Investment & Company Signals")}
                </h2>
                <p className="investment-section-copy">
                  {t(
                    "从产品采用、竞争格局与平台扩张中提炼公司级判断；每条都包含催化因素、反证风险和可追踪指标。",
                    "Company-level reads distilled from product adoption, competitive dynamics, and platform expansion—each with catalysts, disconfirming risks, and trackable indicators.",
                  )}
                </p>
              </div>
              <span className="investment-method">
                {t(
                  `${dailyRadar.companySignals.length} 个高确信度观察`,
                  `${dailyRadar.companySignals.length} high-conviction observations`,
                )}
              </span>
            </div>
            <div className="investment-board">
              {localizedCompanySignals.map((item, index) => {
                const baseStance = dailyRadar.companySignals[index].stance;
                const stanceTone =
                  baseStance === "偏积极"
                    ? "positive"
                    : baseStance === "风险"
                      ? "risk"
                      : baseStance === "分化"
                        ? "split"
                        : "watch";
                return (
                  <article
                    className={`investment-card stance-${stanceTone}`}
                    key={item.entity}
                  >
                    <header className="investment-card-head">
                      <span className="investment-rank">0{index + 1}</span>
                      <div>
                        <span className="investment-type">{item.signalType}</span>
                        <h3>{item.entity}</h3>
                      </div>
                      <div className="investment-score">
                        <strong>{item.score}</strong>
                        <span>{t("信号分", "SCORE")}</span>
                      </div>
                    </header>

                    <h4>
                      <a
                        href={`?article=${item.id}`}
                        onClick={(event) => {
                          event.preventDefault();
                          openArticle(item.id);
                        }}
                      >
                        <span>{item.headline}</span>
                        <StoryLinkIcon />
                      </a>
                    </h4>

                    <div className="investment-change">
                      <span>{t("发生了什么变化", "WHAT CHANGED")}</span>
                      <p>{item.whatChanged}</p>
                    </div>

                    <footer className="investment-card-footer">
                      <span className={`stance-badge stance-${stanceTone}`}>
                        {item.stance}
                      </span>
                      <span className="investment-disclaimer">
                        {t(
                          "非投资建议 · 持续验证",
                          "Not investment advice · Ongoing validation",
                        )}
                      </span>
                    </footer>
                  </article>
                );
              })}
            </div>
          </section>
          )}

          <footer className="footer">
            <span>
              <i className="status-dot" />{" "}
              {view === "live"
                ? t(
                    `${liveFeed.successfulSources} 个信源在线 · 最近 6 小时 ${liveStreamItems.length} 条`,
                    `${liveFeed.successfulSources} sources online · ${liveStreamItems.length} items in 6 hours`,
                  )
                : view === "conversations"
                ? t(
                    `完整字幕精读完成 · 本周精选 ${activeConversations.length} 期`,
                    `Full-transcript review complete · ${activeConversations.length} weekly picks`,
                  )
                : t(
                    `GPT 分析完成 · 基于 ${dailyRadar.analyzedItemCount} 条高相关内容`,
                    `GPT analysis complete · ${dailyRadar.analyzedItemCount} high-relevance items`,
                  )}
            </span>
            <span>
              {view === "live"
                ? t(
                    `无模型实时流 · 扫描于 ${liveScanTimeLabel}`,
                    `Model-free live stream · Scanned ${liveScanTimeLabel}`,
                  )
                : <>
              {view === "conversations"
                ? conversations.model
                : dailyRadar.model}{" "}
              ·{" "}
              {t(
                view === "conversations"
                  ? "本周版本"
                  : `最近更新 ${analysisTimeLabel}`,
                view === "conversations"
                  ? "This week’s edition"
                  : `Updated ${analysisTimeLabel}`,
              )}
              </>
              }
            </span>
          </footer>

          {view === "live" && visibleLiveItems.length > 0 && (
            <section className="explore-more-cta live-to-focus-cta explore-more-page-end">
              <div>
                <span className="explore-more-kicker">
                  {t("从信息到判断", "FROM FLOW TO JUDGMENT")}
                </span>
                <h3>
                  {t(
                    "看完刚刚发生了什么，再看哪些变化真正值得记住",
                    "You’ve seen what just happened. Now see which shifts are worth remembering.",
                  )}
                </h3>
                <p>
                  {t(
                    "进入焦点，查看经过交叉验证、合并同类项和编辑判断后的关键事件。",
                    "Move into Focus for the consequential events that survived cross-validation, clustering, and editorial judgment.",
                  )}
                </p>
              </div>
              <div className="explore-more-actions">
                <a
                  href={sectionPath("brief")}
                  onClick={(event) => {
                    event.preventDefault();
                    briefMore();
                  }}
                >
                  <span>{t("查看焦点", "Open Focus")}</span>
                  <i aria-hidden="true">→</i>
                </a>
                <a
                  className="conversation-more-button"
                  href={sectionPath("explore")}
                  onClick={(event) => {
                    event.preventDefault();
                    exploreMore();
                  }}
                >
                  <span>{t("探索更多", "Explore")}</span>
                  <i aria-hidden="true">→</i>
                </a>
              </div>
            </section>
          )}

          {view === "brief" && visibleSignals.length > 0 && (
            <section className="explore-more-cta explore-more-page-end">
              <div>
                <span className="explore-more-kicker">
                  {t("焦点之外", "BEYOND FOCUS")}
                </span>
                <h3>
                  {t(
                    "看完发生了什么，再去看接下来可能发生什么",
                    "You’ve seen what changed. Now explore what may come next.",
                  )}
                </h3>
                <p>
                  {t(
                    "进入探索，发现非共识判断、二阶影响与仍在形成中的早期信号。",
                    "Move into Explore for non-consensus theses, second-order effects, and early signals still taking shape.",
                  )}
                </p>
              </div>
              <div className="explore-more-actions">
                <a
                  href={sectionPath("explore")}
                  onClick={(event) => {
                    event.preventDefault();
                    exploreMore();
                  }}
                >
                  <span>{t("探索更多", "Explore more")}</span>
                  <i aria-hidden="true">→</i>
                </a>
                <a
                  className="conversation-more-button"
                  href={sectionPath("conversations")}
                  onClick={(event) => {
                    event.preventDefault();
                    conversationsMore();
                  }}
                >
                  <span>{t("精选播客", "Podcasts")}</span>
                  <i aria-hidden="true">→</i>
                </a>
              </div>
            </section>
          )}

          {view === "explore" && visibleExploreSignals.length > 0 && (
            <section className="explore-more-cta conversation-bridge-cta explore-more-page-end">
              <div>
                <span className="explore-more-kicker">
                  {t("观点之后", "BEYOND THE THESIS")}
                </span>
                <h3>
                  {t(
                    "看完我们的判断，再听一遍当事人如何思考",
                    "You’ve read the thesis. Now hear how the people doing the work think.",
                  )}
                </h3>
                <p>
                  {t(
                    "进入精选播客，用几分钟读完本周高质量访谈、播客与长对话的核心论点。",
                    "Open curated podcasts and absorb the week’s best interviews and long-form discussions in minutes.",
                  )}
                </p>
              </div>
              <div className="explore-more-actions">
                <a
                  href={sectionPath("conversations")}
                  onClick={(event) => {
                    event.preventDefault();
                    conversationsMore();
                  }}
                >
                  <span>{t("精选播客", "Podcasts")}</span>
                  <i aria-hidden="true">→</i>
                </a>
                <a
                  className="conversation-more-button"
                  href={sectionPath("brief")}
                  onClick={(event) => {
                    event.preventDefault();
                    briefMore();
                  }}
                >
                  <span>{t("焦点", "Focus")}</span>
                  <i aria-hidden="true">→</i>
                </a>
              </div>
            </section>
          )}

          {view === "conversations" && visibleConversations.length > 0 && (
            <section className="explore-more-cta conversation-page-bridge-cta explore-more-page-end">
              <div>
                <span className="explore-more-kicker">
                  {t("节目之外", "BEYOND THE EPISODE")}
                </span>
                <h3>
                  {t(
                    "听完当事人的思考，再回到正在变化的事实与更大胆的判断",
                    "After hearing how they think, return to what is changing and what may come next.",
                  )}
                </h3>
                <p>
                  {t(
                    "焦点追踪真正重要的事件；探索连接非共识观点、二阶影响与仍在形成中的早期信号。",
                    "Focus tracks consequential events; Explore connects non-consensus views, second-order effects, and early signals still taking shape.",
                  )}
                </p>
              </div>
              <div className="explore-more-actions">
                <a
                  href={sectionPath("explore")}
                  onClick={(event) => {
                    event.preventDefault();
                    exploreMore();
                  }}
                >
                  <span>{t("探索更多", "Explore more")}</span>
                  <i aria-hidden="true">→</i>
                </a>
                <a
                  className="conversation-more-button"
                  href={sectionPath("brief")}
                  onClick={(event) => {
                    event.preventDefault();
                    briefMore();
                  }}
                >
                  <span>{t("焦点", "Focus")}</span>
                  <i aria-hidden="true">→</i>
                </a>
              </div>
            </section>
          )}
            </>
          )}
        </div>
      </section>

      {notice && (
        <div className="toast" role="status">
          <span>✓</span>
          {notice}
        </div>
      )}
    </main>
  );
}
