"use client";

import { useEffect, useMemo, useState } from "react";
import dailyRadar from "../data/daily-radar.json";
import snapshot from "../data/feed-snapshot.json";
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

type Signal = {
  id: number;
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
  evidence: SignalEvidence[];
  references: SignalReference[];
};

type ExploreSignal = {
  id: string;
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
  evidence: SignalEvidence[];
};

const signals = dailyRadar.signals as Signal[];
const exploreSignals = dailyRadar.exploreSignals as ExploreSignal[];
const coveredKinds = [
  ...new Set(signals.flatMap((signal) => signal.sources)),
];
const exploreKinds = [
  ...new Set(exploreSignals.flatMap((signal) => signal.sourceKinds)),
];

function shortKind(kind: string) {
  if (kind === "YouTube") return "YT";
  if (kind === "Newsletter") return "NL";
  return kind;
}

export default function Home() {
  const [locale, setLocale] = useState<"zh" | "en">("zh");
  const [activeCategory, setActiveCategory] = useState("全部");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<number[]>([1]);
  const [saved, setSaved] = useState<number[]>([]);
  const [following, setFollowing] = useState<string[]>([]);
  const [view, setView] = useState<"brief" | "explore">("brief");
  const [section, setSection] = useState<"radar" | "sources">("radar");
  const [notice, setNotice] = useState("");
  const languageCopy = dailyRadar.translations[locale];
  const t = (zh: string, en: string) => (locale === "zh" ? zh : en);

  useEffect(() => {
    const storedLocale = window.localStorage.getItem("signal-radar-locale");
    if (storedLocale === "zh" || storedLocale === "en") {
      setLocale(storedLocale);
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
    window.localStorage.setItem("signal-radar-locale", locale);
  }, [locale]);

  const localizedSignals = useMemo(
    () =>
      signals.map((signal, index) => {
        const translated = languageCopy.signals[index];
        return {
          ...signal,
          ...translated,
          categoryKey: signal.category,
          evidence: signal.evidence.map((evidence, evidenceIndex) => ({
            ...evidence,
            role: translated.evidence[evidenceIndex]?.role ?? evidence.role,
            takeaway:
              translated.evidence[evidenceIndex]?.takeaway ?? evidence.takeaway,
          })),
        };
      }),
    [languageCopy],
  );

  const localizedExploreSignals = useMemo(
    () =>
      exploreSignals.map((signal, index) => {
        const translated = languageCopy.exploreSignals[index];
        return {
          ...signal,
          ...translated,
          categoryKey: signal.category,
          evidence: signal.evidence.map((evidence, evidenceIndex) => ({
            ...evidence,
            takeaway:
              translated.evidence[evidenceIndex]?.takeaway ?? evidence.takeaway,
          })),
        };
      }),
    [languageCopy],
  );

  const localizedTrends = dailyRadar.trends.map((trend, index) => ({
    ...trend,
    ...languageCopy.trends[index],
  }));
  const localizedDiscoveries = dailyRadar.discoveries.map((item, index) => ({
    ...item,
    ...languageCopy.discoveries[index],
  }));
  const localizedCompanySignals = dailyRadar.companySignals.map((item, index) => {
    const translated = languageCopy.companySignals[index];
    return {
      ...item,
      ...translated,
      evidence: item.evidence.map((evidence, evidenceIndex) => ({
        ...evidence,
        takeaway:
          translated.evidence[evidenceIndex]?.takeaway ?? evidence.takeaway,
      })),
    };
  });

  const radarDateLabel = new Intl.DateTimeFormat(
    locale === "zh" ? "zh-CN" : "en-US",
    {
      year: "numeric",
      month: "long",
      day: "numeric",
      weekday: "long",
      timeZone: "America/New_York",
    },
  )
    .format(new Date(dailyRadar.generatedAt))
    .replace("星期", " · 星期");
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
    return localizedSignals.filter((signal) => {
      const matchesCategory =
        activeCategory === "全部" || signal.categoryKey === activeCategory;
      const matchesQuery =
        !normalized ||
        `${signal.title} ${signal.summary} ${signal.sources.join(" ")} ${signal.sourceNames.join(" ")}`
          .toLowerCase()
          .includes(normalized);
      return matchesCategory && matchesQuery;
    });
  }, [activeCategory, localizedSignals, query]);

  const visibleExploreSignals = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return localizedExploreSignals.filter((signal) => {
      const matchesCategory =
        activeCategory === "全部" || signal.categoryKey === activeCategory;
      const matchesQuery =
        !normalized ||
        `${signal.title} ${signal.thesis} ${signal.whyNow} ${signal.sourceNames.join(" ")}`
          .toLowerCase()
          .includes(normalized);
      return matchesCategory && matchesQuery;
    });
  }, [activeCategory, localizedExploreSignals, query]);

  const activeCategories = useMemo(() => {
    const baseItems = view === "explore" ? exploreSignals : signals;
    const displayItems =
      view === "explore" ? localizedExploreSignals : localizedSignals;
    const labels = new Map<string, string>();
    baseItems.forEach((item, index) => {
      labels.set(item.category, displayItems[index].category);
    });
    return [
      { value: "全部", label: t("全部", "All") },
      ...[...labels].map(([value, label]) => ({ value, label })),
    ];
  }, [locale, localizedExploreSignals, localizedSignals, view]);

  function toggleExpanded(id: number) {
    setExpanded((items) =>
      items.includes(id) ? items.filter((item) => item !== id) : [...items, id],
    );
  }

  function toggleSaved(id: number) {
    setSaved((items) =>
      items.includes(id) ? items.filter((item) => item !== id) : [...items, id],
    );
  }

  function toggleFollowing(name: string) {
    setFollowing((items) =>
      items.includes(name)
        ? items.filter((item) => item !== name)
        : [...items, name],
    );
  }

  function showNotice(message: string) {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 2600);
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
              setView("brief");
              setActiveCategory("全部");
            }}
          >
            <span aria-hidden="true">⌁</span>
            {t("今日 Radar", "Today's Radar")}
            <span className="nav-count">{signals.length}</span>
          </button>
          <button
            className={`nav-item ${section === "radar" && view === "explore" ? "active" : ""}`}
            type="button"
            onClick={() => {
              setSection("radar");
              setView("explore");
              setActiveCategory("全部");
            }}
          >
            <span aria-hidden="true">◎</span>
            {t("探索", "Explore")}
          </button>
          <button
            className={`nav-item ${section === "sources" ? "active" : ""}`}
            type="button"
            onClick={() => setSection("sources")}
          >
            <span aria-hidden="true">◇</span>
            {t("信源库", "Sources")}
            <span className="nav-count">159</span>
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
          <p className="side-label">{t("你的 Radar", "YOUR RADAR")}</p>
          {(locale === "zh"
            ? ["AI & Models", "Agents", "算力 & Chips", "VC 动态"]
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
                  "Topic 管理将在数据接入阶段开放",
                  "Topic management will arrive with data connections",
                ),
              )
            }
          >
            {t("＋ 添加 Topic", "+ Add topic")}
          </button>
        </div>

        <div className="coverage-card">
          <div className="coverage-top">
            <span>{t("真实采集", "LIVE INGEST")}</span>
            <span className="live-dot">{t("已运行", "Running")}</span>
          </div>
          <strong>{snapshot.items.length.toLocaleString()}</strong>
          <p>{t("条真实内容已抓取", "real items fetched")}</p>
          <div className="coverage-grid">
            <span>YT · 23</span>
            <span>Blog · 108</span>
            <span>
              X · {snapshot.needsAuthSources} {t("待授权", "pending auth")}
            </span>
            <span>
              {t("连接", "Live")} · {snapshot.successfulSources}
            </span>
          </div>
        </div>

        <div className="profile">
          <span className="avatar">YQ</span>
          <div>
            <strong>{t("Research 小组", "Research Group")}</strong>
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
                  "搜索事件、公司、人物或 Topic",
                  "Search events, companies, people, or topics",
                )}
                aria-label={t("搜索情报", "Search intelligence")}
              />
              <kbd>⌘ K</kbd>
            </label>
          ) : (
            <div className="source-top-context">
              <span className="live-dot">
                {t("Fetcher 在线", "Fetcher online")}
              </span>
              <span>
                {snapshot.successfulSources} / {snapshot.totalSources}{" "}
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
              {section === "sources" ? "LIVE SNAPSHOT" : "GPT ANALYZED"}
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
                    `今日 Brief 已由 ${dailyRadar.model} 基于真实采集内容生成`,
                    `Today's brief was generated by ${dailyRadar.model} from live source data`,
                  ),
                )
              }
            >
              <span aria-hidden="true">✦</span>
              {t("每日 Brief", "Daily Brief")}
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
              <p className="date-line">{radarDateLabel}</p>
              <h1>
                {view === "brief" ? (
                  <>
                    {t("今天真正需要知道的，", "The only signals")}
                    <br />
                    {locale === "zh" ? (
                      <>
                        只有 <span>{signals.length} 个 signals</span>
                      </>
                    ) : (
                      <>
                        that matter today: <span>{signals.length}</span>
                      </>
                    )}
                  </>
                ) : (
                  <>
                    {t("去 consensus 之外，", "Look beyond consensus.")}
                    <br />
                    {locale === "zh" ? (
                      <>
                        发现 <span>{exploreSignals.length} 个 possibilities</span>
                      </>
                    ) : (
                      <>
                        Explore <span>{exploreSignals.length} possibilities</span>
                      </>
                    )}
                  </>
                )}
              </h1>
              <p className="intro-copy">
                {view === "brief" ? (
                  <>
                    {locale === "zh"
                      ? `从 ${dailyRadar.totalFetchedItemCount.toLocaleString()} 条真实内容中筛选 ${dailyRadar.analyzedItemCount} 条 high-signal 信息并聚类。`
                      : `${dailyRadar.analyzedItemCount} high-relevance items clustered from ${dailyRadar.totalFetchedItemCount.toLocaleString()} live source entries. `}
                    {languageCopy.editorNote}
                  </>
                ) : (
                  <>
                    {t(
                      "不追逐同一条新闻，而是寻找 non-consensus 观点、二阶影响、跨界连接和高风险高潜的 early signals。",
                      "Not another news feed: this view hunts for contrarian ideas, second-order effects, cross-domain connections, and early high-risk signals.",
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
                    : new Set(exploreSignals.map((signal) => signal.category)).size}
                </span>
                <span>
                  {view === "brief"
                    ? t("今日 Signal Quality", "Today's Signal Quality")
                    : t("Explore 主题覆盖", "Explore Coverage")}
                  <small>
                    {view === "brief"
                      ? t(
                          `较 baseline ${
                            dailyRadar.signalQualityChange >= 0 ? "高" : "低"
                          } ${Math.abs(dailyRadar.signalQualityChange)}%`,
                          `${Math.abs(dailyRadar.signalQualityChange)}% ${
                            dailyRadar.signalQualityChange >= 0 ? "above" : "below"
                          } baseline`,
                        )
                      : t(
                          `${exploreSignals.filter((signal) => signal.label === "高风险高潜").length} 条高风险高潜`,
                          `${exploreSignals.filter((signal) => signal.label === "高风险高潜").length} high-risk / high-upside`,
                        )}
                  </small>
                </span>
              </div>
              <div
                className="source-stack"
                aria-label={t("已覆盖平台", "Platforms covered")}
              >
                {(view === "brief" ? coveredKinds : exploreKinds).map((kind) => (
                  <span key={kind}>{shortKind(kind)}</span>
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
                  setView("brief");
                  setActiveCategory("全部");
                }}
              >
                {t("今日 Brief", "Today's Brief")}
              </button>
              <button
                type="button"
                className={view === "explore" ? "selected" : ""}
                onClick={() => {
                  setView("explore");
                  setActiveCategory("全部");
                }}
              >
                {t("Explore 信息流", "Explore Feed")}
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
                    {view === "brief" ? "MUST KNOW" : "DISCOVERY FEED"}
                  </span>
                  <h2>
                    {view === "brief"
                      ? t("必须知道", "Must Know")
                      : t("为你发现的 high-signal 内容", "High-Signal Discoveries")}
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
                        </div>
                        <button
                          type="button"
                          className="signal-title"
                          onClick={() => toggleExpanded(signal.id)}
                          aria-expanded={isExpanded}
                        >
                          <span>{signal.title}</span>
                          <span aria-hidden="true">{isExpanded ? "−" : "＋"}</span>
                        </button>
                        <p className="signal-summary">{signal.summary}</p>

                        {isExpanded && (
                          <div className="signal-analysis">
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
                                        {shortKind(evidence.sourceKind)}
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
                              <span key={source}>{source}</span>
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
                                  : t("收藏此 signal", "Save this signal")
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
                        "换一个关键词或清除 Topic 筛选。",
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
                  {visibleExploreSignals.map((signal, index) => (
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
                      </div>

                      <h3>{signal.title}</h3>
                      <p className="explore-thesis">{signal.thesis}</p>

                      <div className="explore-reasoning">
                        <div>
                          <span>WHY NOW</span>
                          <p>{signal.whyNow}</p>
                        </div>
                        <div className="explore-counterpoint">
                          <span>
                            {t("最强 counterpoint", "STRONGEST COUNTERPOINT")}
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
                          <span>EVIDENCE TRAIL</span>
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
                            <span>{shortKind(evidence.sourceKind)}</span>
                            <div>
                              <strong>{evidence.sourceName}</strong>
                              <p>{evidence.takeaway}</p>
                            </div>
                            <i>↗</i>
                          </a>
                        ))}
                      </div>
                    </article>
                  ))}

                  {visibleExploreSignals.length === 0 && (
                    <div className="empty-state explore-empty">
                      <span>⌁</span>
                      <strong>
                        {t(
                          "这个方向暂时没有 Explore signal",
                          "No Explore signals in this direction",
                        )}
                      </strong>
                      <p>
                        {t(
                          "换一个 Topic 或清除筛选。",
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

            {view === "brief" && (
            <aside className="insight-column">
              <section className="panel trend-panel">
                <div className="panel-heading">
                  <div>
                    <span className="section-kicker">MOMENTUM</span>
                    <h2>{t("正在升温", "Heating Up")}</h2>
                  </div>
                  <button
                    type="button"
                    aria-label={t("查看所有趋势", "View all trends")}
                    onClick={() =>
                      showNotice(
                        t(
                          "完整 trend map 将在下一阶段开放",
                          "The full trend map will arrive in the next phase",
                        ),
                      )
                    }
                  >
                    ↗
                  </button>
                </div>
                <div className="trend-list">
                  {localizedTrends.map((trend) => (
                    <div className="trend-row" key={trend.name}>
                      <div>
                        <strong>{trend.name}</strong>
                        <span>{trend.change}</span>
                      </div>
                      <div className="mini-bars" aria-hidden="true">
                        {trend.bars.map((height, index) => (
                          <i
                            key={`${trend.name}-${index}`}
                            style={{ height: `${height}%` }}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
                <p className="panel-note">
                  {t(
                    "基于讨论速度、跨平台扩散和信源质量综合计算",
                    "Computed from discussion velocity, cross-platform spread, and source quality",
                  )}
                </p>
              </section>

              <section className="panel discovery-panel">
                <div className="panel-heading">
                  <div>
                    <span className="section-kicker">DISCOVERED FOR YOU</span>
                    <h2>{t("新发现", "New Discoveries")}</h2>
                  </div>
                  <span className="new-badge">3 NEW</span>
                </div>
                <div className="discovery-list">
                  {localizedDiscoveries.map((item) => {
                    const isFollowing = following.includes(item.name);
                    return (
                      <article key={item.name}>
                        <span className={`discovery-mark ${item.color}`}>
                          {item.mark}
                        </span>
                        <div>
                          <strong>{item.name}</strong>
                          <p>{item.detail}</p>
                          <small>{item.source}</small>
                        </div>
                        <button
                          type="button"
                          className={isFollowing ? "following" : ""}
                          onClick={() => toggleFollowing(item.name)}
                        >
                          {isFollowing
                            ? t("已追踪", "Following")
                            : t("＋ 追踪", "+ Follow")}
                        </button>
                      </article>
                    );
                  })}
                </div>
              </section>

              <section className="panel thesis-panel">
                <span className="section-kicker">INVESTMENT LENS</span>
                <h2>{t("今日 Investment Thesis", "Today's Investment Thesis")}</h2>
                <blockquote>
                  “{languageCopy.investmentThesis.quote}”
                </blockquote>
                <div className="thesis-footer">
                  <div className="confidence">
                    <span>{t("置信度", "Confidence")}</span>
                    <strong>{languageCopy.investmentThesis.confidence}</strong>
                  </div>
                  <span className="team-avatars">
                    <i>Y</i>
                    <i>L</i>
                    <i>W</i>
                  </span>
                  <span className="team-agree">
                    {t(
                      `${dailyRadar.investmentThesis.evidenceCount} 个证据信源`,
                      `${dailyRadar.investmentThesis.evidenceCount} evidence sources`,
                    )}
                  </span>
                </div>
                <button
                  className="thesis-action"
                  type="button"
                  onClick={() =>
                    showNotice(
                      t(
                        "已加入小组 Research agenda",
                        "Added to the group research agenda",
                      ),
                    )
                  }
                >
                  {t("加入 Research agenda", "Add to research agenda")}
                  <span>→</span>
                </button>
              </section>
            </aside>
            )}
          </div>

          {view === "brief" && (
          <section className="signal-table-section">
            <div className="section-heading">
              <div>
                <span className="section-kicker">CAPITAL & COMPANY SIGNALS</span>
                <h2>
                  {t("投资 & Company Signals", "Investment & Company Signals")}
                </h2>
                <p className="investment-section-copy">
                  {t(
                    "从 product adoption、竞争格局与 platform expansion 中提炼公司级判断；每条都包含 catalyst、反证风险和可追踪指标。",
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
                        <span>{t("Signal 分", "SCORE")}</span>
                      </div>
                    </header>

                    <h4>{item.headline}</h4>

                    <div className="investment-change">
                      <span>{t("发生了什么变化", "WHAT CHANGED")}</span>
                      <p>{item.whatChanged}</p>
                    </div>

                    <div className="investment-read">
                      <span>INVESTMENT READ</span>
                      <p>{item.investmentRead}</p>
                    </div>

                    <div className="investment-checks">
                      <div>
                        <span className="check-icon catalyst">↗</span>
                        <p>
                          <strong>{t("潜在 catalyst", "POTENTIAL CATALYST")}</strong>
                          {item.catalyst}
                        </p>
                      </div>
                      <div>
                        <span className="check-icon risk">!</span>
                        <p>
                          <strong>{t("反证风险", "DISCONFIRMING RISK")}</strong>
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
                        <span>{t("Evidence chain", "EVIDENCE CHAIN")}</span>
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
                            {shortKind(evidence.sourceKind)}
                          </span>
                          <div>
                            <strong>{evidence.sourceName}</strong>
                            <p>{evidence.takeaway}</p>
                          </div>
                          <i>↗</i>
                        </a>
                      ))}
                    </div>

                    <footer className="investment-card-footer">
                      <span className={`stance-badge stance-${stanceTone}`}>
                        {item.stance}
                      </span>
                      <span>
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
              {t(`${analysisTimeLabel} 生成`, `Generated ${analysisTimeLabel}`)}
            </span>
          </footer>
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
