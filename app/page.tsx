"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dailyRadar from "../data/daily-radar.json";
import snapshot from "../data/feed-snapshot.json";
import {
  trackAnalyticsEvent,
  trackPageView,
} from "./analytics";
import { ArticleView } from "./article-view";
import {
  calculateSignalHeat,
  compareEditorialValue,
  compareSignalHeat,
  meetsExploreEditorialFloor,
  type SignalHeat,
} from "./signal-heat";
import { getSourceKind, publicSourceCatalog } from "./source-catalog";
import { SourceLibrary } from "./source-library";

type SignalReference = {
  sourceName: string;
  sourceKind: string;
  title: string;
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

const signals = dailyRadar.signals as Signal[];
const allDynamicSignals = signals.filter(
  (signal) => signal.editorialBucket === "dynamic",
);
const curatedExploreSignals = dailyRadar.exploreSignals as ExploreSignal[];
const coveredKinds = [
  ...new Set(allDynamicSignals.flatMap((signal) => signal.sources)),
];

function compareEditorialOrder(
  left: Signal & { heat: SignalHeat },
  right: Signal & { heat: SignalHeat },
) {
  return compareEditorialValue(left, right);
}

function compareExploreOrder(
  left: Pick<ExploreSignal, "feedBatchAt" | "valueScore"> & {
    heat: SignalHeat;
  },
  right: Pick<ExploreSignal, "feedBatchAt" | "valueScore"> & {
    heat: SignalHeat;
  },
) {
  return compareEditorialValue(left, right);
}

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

export default function Home() {
  const [locale, setLocale] = useState<"zh" | "en">("zh");
  const [activeCategory, setActiveCategory] = useState("全部");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<number[]>([]);
  const [expandedExplore, setExpandedExplore] = useState<string[]>([]);
  const [expandedCompany, setExpandedCompany] = useState<string[]>([]);
  const [saved, setSaved] = useState<number[]>([]);
  const [view, setView] = useState<"brief" | "explore">("brief");
  const [section, setSection] = useState<"radar" | "sources">("radar");
  const [notice, setNotice] = useState("");
  const [articleId, setArticleId] = useState<string | null>(null);
  const [routeReady, setRouteReady] = useState(false);
  const [heatNow, setHeatNow] = useState(dailyRadar.generatedAt);
  const [mobileAnalysisInExplore, setMobileAnalysisInExplore] = useState(false);
  const lastTrackedPath = useRef<string | null>(null);
  const languageCopy = dailyRadar.translations[locale];
  const t = (zh: string, en: string) => (locale === "zh" ? zh : en);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const storedLocale = window.localStorage.getItem("signal-radar-locale");
      if (storedLocale === "zh" || storedLocale === "en") {
        setLocale(storedLocale);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
    window.localStorage.setItem("signal-radar-locale", locale);
  }, [locale]);

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
    const syncLayout = () => setMobileAnalysisInExplore(media.matches);
    const initialTimer = window.setTimeout(syncLayout, 0);
    media.addEventListener("change", syncLayout);
    return () => {
      window.clearTimeout(initialTimer);
      media.removeEventListener("change", syncLayout);
    };
  }, []);

  useEffect(() => {
    const readArticleId = () => {
      const value = new URLSearchParams(window.location.search).get("article");
      setArticleId(value || null);
      setRouteReady(true);
    };
    readArticleId();
    window.addEventListener("popstate", readArticleId);
    return () => window.removeEventListener("popstate", readArticleId);
  }, []);

  const localizedSignals = useMemo(
    () =>
      signals
        .map((signal, index) => {
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
        })
        .sort(compareEditorialOrder),
    [heatNow, languageCopy],
  );

  const localizedDynamicSignals = useMemo(
    () =>
      localizedSignals.filter(
        (signal) =>
          signal.editorialBucket === "dynamic" && signal.heat.visible,
      ),
    [localizedSignals],
  );

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
    return [...mergedStorySignals, ...deduplicatedCurated].sort(
      compareExploreOrder,
    );
  }, [locale, localizedCuratedExploreSignals, localizedSignals]);

  const activeExploreSignals = useMemo(
    () =>
      localizedExploreSignals.filter(
        (signal) =>
          meetsExploreEditorialFloor(signal) && signal.heat.visible,
      ),
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
    const dynamicArticle = localizedSignals.find(
      (signal) => String(signal.id) === articleId,
    );
    const activeArticle = exploreArticle ?? companyArticle ?? dynamicArticle;
    const contentType = exploreArticle
      ? "explore"
      : companyArticle
        ? "company"
        : dynamicArticle
          ? "dynamic"
          : "index";
    const title =
      activeArticle &&
      ("title" in activeArticle
        ? activeArticle.title
        : "headline" in activeArticle
          ? activeArticle.headline
          : null);
    const path = activeArticle
      ? `/intelligence/?article=${encodeURIComponent(String(activeArticle.id))}`
      : "/intelligence/";

    if (lastTrackedPath.current === path) return;
    lastTrackedPath.current = path;

    trackPageView({
      path,
      title: title ?? "Signal Radar",
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
  }, [articleId, locale, routeReady]);

  const analysisTimeLabel = new Intl.DateTimeFormat(
    locale === "zh" ? "zh-CN" : "en-US",
    {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "America/New_York",
    },
  ).format(new Date(dailyRadar.generatedAt));

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

  const activeCategories = useMemo(() => {
    const displayItems =
      view === "explore"
        ? activeExploreSignals
        : localizedDynamicSignals;
    const labels = new Map<string, string>();
    displayItems.forEach((item) => {
      labels.set(item.categoryKey, item.category);
    });
    return [
      { value: "全部", label: t("全部", "All") },
      ...[...labels].map(([value, label]) => ({ value, label })),
    ];
  }, [activeExploreSignals, locale, localizedDynamicSignals, view]);

  function toggleExpanded(id: number) {
    setExpanded((items) =>
      items.includes(id) ? items.filter((item) => item !== id) : [...items, id],
    );
  }

  function toggleExpandedExplore(id: string) {
    setExpandedExplore((items) =>
      items.includes(id) ? items.filter((item) => item !== id) : [...items, id],
    );
  }

  function toggleExpandedCompany(id: string) {
    setExpandedCompany((items) =>
      items.includes(id) ? items.filter((item) => item !== id) : [...items, id],
    );
  }

  function switchView(nextView: "brief" | "explore") {
    setView(nextView);
    setExpanded([]);
    setExpandedExplore([]);
    setExpandedCompany([]);
  }

  function exploreMore() {
    switchView("explore");
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
    window.history.pushState({}, "", url);
    setArticleId(null);
    window.scrollTo({ top: 0, behavior: "instant" });
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
        onLocaleChange={setLocale}
        onBack={() => {
          switchView("explore");
          closeArticle();
        }}
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
        onLocaleChange={setLocale}
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
        onLocaleChange={setLocale}
        onBack={closeArticle}
      />
    );
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            S
          </span>
          <span>Signal Radar</span>
        </div>

        <nav className="side-nav" aria-label={t("主要导航", "Primary navigation")}>
          <button
            className={`nav-item ${section === "radar" && view === "brief" ? "active" : ""}`}
            type="button"
            onClick={() => {
              setSection("radar");
              switchView("brief");
              setActiveCategory("全部");
            }}
          >
            <span aria-hidden="true">⌁</span>
            {t("最新动态", "Latest Updates")}
            <span className="nav-count">{localizedDynamicSignals.length}</span>
          </button>
          <button
            className={`nav-item ${section === "radar" && view === "explore" ? "active" : ""}`}
            type="button"
            onClick={() => {
              setSection("radar");
              switchView("explore");
              setActiveCategory("全部");
            }}
          >
            <span aria-hidden="true">◎</span>
            {t("探索", "Explore")}
            <span className="nav-count">{activeExploreSignals.length}</span>
          </button>
          <button
            className={`nav-item ${section === "sources" ? "active" : ""}`}
            type="button"
            onClick={() => setSection("sources")}
          >
            <span aria-hidden="true">◇</span>
            {t("信源库", "Sources")}
          </button>
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
            <span className="brand-mark">S</span>
            <span>Signal Radar</span>
          </div>
          {section === "radar" ? (
            <label className="search">
              <span aria-hidden="true">⌕</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t(
                  "搜索事件、公司、人物或主题",
                  "Search events, companies, people, or topics",
                )}
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
            <span className="demo-label">
              {section === "sources"
                ? t("实时快照", "LIVE SNAPSHOT")
                : t("GPT 已分析", "GPT ANALYZED")}
            </span>
            <button
              className="icon-button"
              type="button"
              aria-label={t("查看通知", "View notifications")}
              onClick={() =>
                showNotice(t("目前没有新的通知", "No new notifications"))
              }
            >
              ♢
              <span className="notification-dot" />
            </button>
            <button
              className="digest-button"
              type="button"
              onClick={() =>
                showNotice(
                  t(
                    `Radar Feed 已由 ${dailyRadar.model} 基于真实采集内容持续更新`,
                    `The Radar Feed is continuously updated by ${dailyRadar.model} from live source data`,
                  ),
                )
              }
            >
              <span aria-hidden="true">✦</span>
              {t("持续更新", "Live Feed")}
            </button>
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
                {t(
                  `持续更新 · 最近更新 ${analysisTimeLabel}`,
                  `Continuous feed · Updated ${analysisTimeLabel}`,
                )}
              </p>
              <h1>
                {view === "brief" ? (
                  <>
                    {t("值得关注的最新变化，", "The latest changes")}
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
                ) : (
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
                )}
              </h1>
              <p className="intro-copy">
                {view === "brief" ? (
                  <>
                    {t(
                      "将分散的信息噪声压缩为少数值得判断的变化，让事实、共识与转折在同一条脉络中显现。",
                      "Distilling a fragmented information landscape into a small set of consequential shifts—where facts, consensus, and inflection points resolve into one coherent view.",
                    )}
                  </>
                ) : (
                  <>
                    {t(
                      "在共识尚未成形之处，辨认结构性张力、隐性因果，以及足以重估未来的微弱先兆。",
                      "Mapping the terrain before consensus forms: structural tensions, hidden causal chains, and faint signals capable of repricing the future.",
                    )}
                  </>
                )}
              </p>
            </div>
            <div className="brief-score">
              <div>
                <span className="score-ring">
                  {view === "brief"
                    ? dailyRadar.signalQuality
                    : new Set(
                        activeExploreSignals.map(
                          (signal) => signal.categoryKey,
                        ),
                      ).size}
                </span>
                <span>
                  {view === "brief"
                    ? t("当前信号质量", "Current Signal Quality")
                    : t("探索主题覆盖", "Explore Coverage")}
                  <small>
                    {view === "brief"
                      ? t(
                          `较基准 ${
                            dailyRadar.signalQualityChange >= 0 ? "高" : "低"
                          } ${Math.abs(dailyRadar.signalQualityChange)}%`,
                          `${Math.abs(dailyRadar.signalQualityChange)}% ${
                            dailyRadar.signalQualityChange >= 0 ? "above" : "below"
                          } baseline`,
                        )
                      : t(
                          `${activeExploreSignals.length} 个持续追踪方向`,
                          `${activeExploreSignals.length} ongoing directions`,
                        )}
                  </small>
                </span>
              </div>
              <div
                className="source-stack"
                aria-label={t("已覆盖平台", "Platforms covered")}
              >
                {(view === "brief" ? coveredKinds : exploreKinds).map((kind) => (
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
              <button
                type="button"
                className={view === "brief" ? "selected" : ""}
                onClick={() => {
                  switchView("brief");
                  setActiveCategory("全部");
                }}
              >
                {t("最新动态", "Latest Updates")}
              </button>
              <button
                type="button"
                className={view === "explore" ? "selected" : ""}
                onClick={() => {
                  switchView("explore");
                  setActiveCategory("全部");
                }}
              >
                {t("探索", "Explore Feed")}
              </button>
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
              view === "explore" ? "explore-layout" : ""
            }`}
          >
            <section className="feed-column">
              <div className="section-heading">
                <div>
                  <span className="section-kicker">
                    {view === "brief"
                      ? t("持续更新", "LIVE FEED")
                      : t("探索发现", "DISCOVERY FEED")}
                  </span>
                  <h2>
                    {view === "brief"
                      ? t("最新信号", "Latest Signals")
                      : t("为你发现的高信号内容", "High-Signal Discoveries")}
                  </h2>
                </div>
                <span className="result-count">
                  {view === "brief"
                    ? t(
                        `${visibleSignals.length} 个事件簇`,
                        `${visibleSignals.length} event clusters`,
                      )
                    : t(
                        `${visibleExploreSignals.length} 个探索方向`,
                        `${visibleExploreSignals.length} directions`,
                      )}
                </span>
              </div>

              {view === "brief" ? (
              <div className="signal-list">
                {visibleSignals.map((signal, index) => {
                  const isExpanded = expanded.includes(signal.id);
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
                            {locale === "zh"
                              ? signal.age
                              : signal.age
                                  .replace("刚刚", "Just now")
                                  .replace("时间未知", "Time unknown")
                                  .replace(" 小时前", "h ago")
                                  .replace(" 天前", "d ago")}
                          </span>
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

                        {isExpanded && (
                          <div
                            className="signal-analysis"
                            id={`brief-preview-${signal.id}`}
                          >
                            {signal.updates?.length ? (
                              <div className="feed-update-list">
                                <span className="analysis-label">
                                  {t("最新进展", "LATEST UPDATES")}
                                </span>
                                {signal.updates.slice(0, 3).map((update) => (
                                  <article
                                    className="feed-update"
                                    key={`${update.addedAt}-${update.title}`}
                                  >
                                    <div>
                                      <strong>{update.title}</strong>
                                      <time dateTime={update.addedAt}>
                                        {new Intl.DateTimeFormat(
                                          locale === "zh" ? "zh-CN" : "en-US",
                                          {
                                            month: "short",
                                            day: "numeric",
                                            hour: "2-digit",
                                            minute: "2-digit",
                                            timeZone: "America/New_York",
                                          },
                                        ).format(new Date(update.addedAt))}
                                      </time>
                                    </div>
                                    <p>{update.summary}</p>
                                  </article>
                                ))}
                              </div>
                            ) : null}
                            <div className="signal-shift">
                              <div>
                                <span>{t("此前", "BEFORE")}</span>
                                <strong>{signal.shiftFrom}</strong>
                              </div>
                              <i aria-hidden="true">→</i>
                              <div>
                                <span>{t("现在", "NOW")}</span>
                                <strong>{signal.shiftTo}</strong>
                              </div>
                            </div>
                            <div>
                              <span className="analysis-label">
                                {t("为什么重要", "WHY IT MATTERS")}
                              </span>
                              <p>{signal.why}</p>
                            </div>
                            <div>
                              <span className="analysis-label">
                                {t("可能影响", "POTENTIAL IMPACT")}
                              </span>
                              <p>{signal.impact}</p>
                            </div>
                            <div className="validation-summary">
                              <span className="analysis-label">
                                {t(
                                  signal.validationType,
                                  signal.validationType === "跨平台验证"
                                    ? "Cross-platform validation"
                                    : signal.validationType === "多账号验证"
                                      ? "Multi-source validation"
                                      : "Single source",
                                )}
                              </span>
                              <p>{signal.crossValidation}</p>
                            </div>
                            <div className="evidence-block">
                              <div className="evidence-heading">
                                <span className="analysis-label">
                                  {t(
                                    `结论依据 · ${signal.evidence.length} 个账号`,
                                    `EVIDENCE · ${signal.evidence.length} sources`,
                                  )}
                                </span>
                                <small>
                                  {t("点击查看原始内容", "Open original content")}
                                </small>
                              </div>
                              <div className="evidence-widget-grid">
                                {signal.evidence.map((evidence, evidenceIndex) => (
                                  <a
                                    href={evidence.url}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="evidence-widget"
                                    key={evidence.url}
                                    title={evidence.title}
                                  >
                                    <div className="evidence-widget-top">
                                      <span className="evidence-number">
                                        0{evidenceIndex + 1}
                                      </span>
                                      <span className="evidence-platform">
                                        {shortKind(evidence.sourceKind, locale)}
                                      </span>
                                      <span className="evidence-role">
                                        {evidence.role}
                                      </span>
                                    </div>
                                    <strong>{evidence.sourceName}</strong>
                                    <p>{evidence.takeaway}</p>
                                    <footer>
                                      <span>{evidence.title}</span>
                                      <i>↗</i>
                                    </footer>
                                  </a>
                                ))}
                              </div>
                            </div>
                          </div>
                        )}

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
                            <button
                              type="button"
                              className="analysis-toggle"
                              onClick={() => toggleExpanded(signal.id)}
                              aria-expanded={isExpanded}
                              aria-controls={`brief-preview-${signal.id}`}
                            >
                              {isExpanded
                                ? t("收起", "Collapse")
                                : t("预览", "Preview")}
                            </button>
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
              ) : (
                <div className="explore-grid">
                  {visibleExploreSignals.map((signal, index) => {
                    const isExpanded = expandedExplore.includes(signal.id);
                    return (
                      <article
                        className={`explore-card explore-tone-${signal.tone} ${
                          index === 0 ? "explore-featured" : ""
                        } ${isExpanded ? "explore-expanded" : ""}`}
                        key={signal.id}
                      >
                        <div className="explore-card-top">
                          <span className="explore-number">0{index + 1}</span>
                          <span className="explore-category">{signal.category}</span>
                          <span className="explore-label">{signal.label}</span>
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

                        {isExpanded && (
                          <div
                            className="explore-preview"
                            id={`explore-preview-${signal.id}`}
                          >
                            <div className="explore-reasoning">
                              <div>
                                <span>{t("为什么是现在", "WHY NOW")}</span>
                                <p>{signal.whyNow}</p>
                              </div>
                              <div className="explore-counterpoint">
                                <span>
                                  {t(
                                    "最强反方观点",
                                    "STRONGEST COUNTERPOINT",
                                  )}
                                </span>
                                <p>{signal.counterpoint}</p>
                              </div>
                            </div>

                            <div className="explore-metrics">
                              <span>
                                <small>{t("时间跨度", "HORIZON")}</small>
                                <strong>{signal.horizon}</strong>
                              </span>
                              <span>
                                <small>{t("置信度", "CONFIDENCE")}</small>
                                <strong>{signal.confidence}</strong>
                              </span>
                              <span>
                                <small>{t("验证状态", "VALIDATION")}</small>
                                <strong>
                                  {t(
                                    signal.validationType,
                                    signal.validationType === "跨平台验证"
                                      ? "Cross-platform"
                                      : signal.validationType === "多账号验证"
                                        ? "Multi-source"
                                        : "Single source",
                                  )}
                                </strong>
                              </span>
                            </div>

                            <div className="explore-evidence">
                              <div>
                                <span>{t("证据路径", "EVIDENCE TRAIL")}</span>
                                <small>
                                  {t(
                                    `${signal.sourceCount} 个独立账号`,
                                    `${signal.sourceCount} independent sources`,
                                  )}
                                </small>
                              </div>
                              {signal.evidence.map((evidence) => (
                                <a
                                  href={evidence.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  key={evidence.url}
                                >
                                  <span>
                                    {shortKind(evidence.sourceKind, locale)}
                                  </span>
                                  <div>
                                    <strong>{evidence.sourceName}</strong>
                                    <p>{evidence.takeaway}</p>
                                  </div>
                                  <i>↗</i>
                                </a>
                              ))}
                            </div>
                          </div>
                        )}

                        <div className="explore-card-actions">
                          <button
                            type="button"
                            className="analysis-toggle"
                            onClick={() => toggleExpandedExplore(signal.id)}
                            aria-expanded={isExpanded}
                            aria-controls={`explore-preview-${signal.id}`}
                          >
                            {isExpanded
                              ? t("收起", "Collapse")
                              : t("预览", "Preview")}
                          </button>
                        </div>
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
              )}
            </section>

            {((view === "brief" && !mobileAnalysisInExplore) ||
              (view === "explore" && mobileAnalysisInExplore)) && (
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

          {((view === "brief" && !mobileAnalysisInExplore) ||
            (view === "explore" && mobileAnalysisInExplore)) && (
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
                const isExpanded = expandedCompany.includes(item.id);
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

                    {isExpanded && (
                      <div
                        className="investment-preview"
                        id={`company-preview-${item.id}`}
                      >
                        <div className="investment-read">
                          <span>{t("投资解读", "INVESTMENT READ")}</span>
                          <p>{item.investmentRead}</p>
                        </div>

                        <div className="investment-checks">
                          <div>
                            <span className="check-icon catalyst">↗</span>
                            <p>
                              <strong>
                                {t("潜在催化因素", "POTENTIAL CATALYST")}
                              </strong>
                              {item.catalyst}
                            </p>
                          </div>
                          <div>
                            <span className="check-icon risk">!</span>
                            <p>
                              <strong>
                                {t("反证风险", "DISCONFIRMING RISK")}
                              </strong>
                              {item.risk}
                            </p>
                          </div>
                        </div>

                        <div className="investment-watch">
                          <span>{t("下一步观察", "WATCH NEXT")}</span>
                          <p>{item.watchNext}</p>
                        </div>

                        <div className="investment-evidence">
                          <div className="investment-evidence-head">
                            <span>{t("证据链", "EVIDENCE CHAIN")}</span>
                            <small>
                              {t(
                                `${item.validationType} · ${item.sourceCount} 个账号`,
                                `${
                                  item.validationType === "跨平台验证"
                                    ? "Cross-platform"
                                    : "Multi-source"
                                } · ${item.sourceCount} sources`,
                              )}
                            </small>
                          </div>
                          {item.evidence.map((evidence) => (
                            <a
                              href={evidence.url}
                              target="_blank"
                              rel="noreferrer"
                              key={evidence.url}
                            >
                              <span className="investment-source-mark">
                                {shortKind(evidence.sourceKind, locale)}
                              </span>
                              <div>
                                <strong>{evidence.sourceName}</strong>
                                <p>{evidence.takeaway}</p>
                              </div>
                              <i>↗</i>
                            </a>
                          ))}
                        </div>
                      </div>
                    )}

                    <footer className="investment-card-footer">
                      <span className={`stance-badge stance-${stanceTone}`}>
                        {item.stance}
                      </span>
                      <button
                        type="button"
                        className="analysis-toggle"
                        onClick={() => toggleExpandedCompany(item.id)}
                        aria-expanded={isExpanded}
                        aria-controls={`company-preview-${item.id}`}
                      >
                        {isExpanded
                          ? t("收起", "Collapse")
                          : t("预览", "Preview")}
                      </button>
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
              {t(
                `GPT 分析完成 · 基于 ${dailyRadar.analyzedItemCount} 条高相关内容`,
                `GPT analysis complete · ${dailyRadar.analyzedItemCount} high-relevance items`,
              )}
            </span>
            <span>
              {dailyRadar.model} ·{" "}
              {t(
                `最近更新 ${analysisTimeLabel}`,
                `Updated ${analysisTimeLabel}`,
              )}
            </span>
          </footer>

          {view === "brief" && visibleSignals.length > 0 && (
            <section className="explore-more-cta explore-more-page-end">
              <div>
                <span className="explore-more-kicker">
                  {t("动态之外", "BEYOND THE FEED")}
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
              <button type="button" onClick={exploreMore}>
                <span>{t("探索更多", "Explore more")}</span>
                <i aria-hidden="true">→</i>
              </button>
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
