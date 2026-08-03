"use client";

import { useEffect } from "react";
import {
  FontSizeControl,
  type FontSizePreference,
} from "./font-size-control";

type Locale = "zh" | "en";

function basePathFromPathname(pathname: string) {
  return pathname === "/intelligence" || pathname.startsWith("/intelligence/")
    ? "/intelligence"
    : "";
}

type ArticleSection = {
  heading: string;
  body: string;
};

type ArticleEvidence = {
  sourceName: string;
  sourceKind: string;
  title: string;
  url: string;
  publishedAt: string | null;
  role: string;
  takeaway: string;
};

export type ArticleSignal = {
  id: number | string;
  publishedAt?: string | null;
  updatedAt?: string | null;
  originalTitle?: string;
  guest?: string;
  durationMinutes?: number;
  category: string;
  eyebrow: string;
  title: string;
  summary: string;
  why: string;
  impact: string;
  crossValidation: string;
  validationType: "跨平台验证" | "多账号验证" | "单一来源";
  sourceCount: number;
  score?: number;
  confidence?: string;
  article?: {
    lead: string;
    sections: ArticleSection[];
    outlook: string;
  };
  updates?: Array<{
    addedAt: string;
    title: string;
    summary: string;
    evidence: ArticleEvidence[];
  }>;
  evidence: ArticleEvidence[];
};

function shortKind(kind: string, locale: Locale) {
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

function fallbackArticle(signal: ArticleSignal, locale: Locale) {
  return {
    lead: signal.summary,
    sections: [
      {
        heading: locale === "zh" ? "发生了什么" : "What happened",
        body: signal.crossValidation,
      },
      {
        heading: locale === "zh" ? "为什么重要" : "Why it matters",
        body: signal.why,
      },
      {
        heading: locale === "zh" ? "可能带来的变化" : "Potential impact",
        body: signal.impact,
      },
    ],
    outlook: signal.impact,
  };
}

export function ArticleView({
  signal,
  locale,
  generatedAt,
  kind = "brief",
  fontSize,
  onLocaleChange,
  onFontSizeChange,
  onBack,
}: {
  signal: ArticleSignal;
  locale: Locale;
  generatedAt: string;
  kind?: "brief" | "explore" | "company" | "conversation";
  fontSize: FontSizePreference;
  onLocaleChange: (locale: Locale) => void;
  onFontSizeChange: (fontSize: FontSizePreference) => void;
  onBack: () => void;
}) {
  const t = (zh: string, en: string) => (locale === "zh" ? zh : en);
  const isExplore = kind === "explore";
  const isCompany = kind === "company";
  const isConversation = kind === "conversation";
  const basePath =
    typeof window === "undefined"
      ? ""
      : basePathFromPathname(window.location.pathname);
  const returnHref = isExplore
    ? `${basePath}/explore/`
    : isConversation
      ? `${basePath}/conversations/`
      : `${basePath}/`;
  const article = signal.article ?? fallbackArticle(signal, locale);
  useEffect(() => {
    const previousTitle = document.title;
    document.title = `${signal.title} — All We Need`;
    return () => {
      document.title = previousTitle;
    };
  }, [signal.title]);
  const articleTimestamp =
    signal.updatedAt ??
    signal.publishedAt ??
    signal.evidence
      .map((item) => item.publishedAt)
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ??
    generatedAt;
  const dateLabel = new Intl.DateTimeFormat(
    locale === "zh" ? "zh-CN" : "en-US",
    {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "America/New_York",
    },
  ).format(new Date(articleTimestamp));

  return (
    <main className="article-page">
      <header className="article-topbar">
        <a
          className="article-brand"
          href={returnHref}
          onClick={(event) => {
            event.preventDefault();
            onBack();
          }}
        >
          <span className="brand-mark" aria-hidden="true">
            A
          </span>
          <span>All We Need</span>
        </a>
        <div className="article-top-actions">
          <div
            className="language-switch"
            role="group"
            aria-label={t("语言切换", "Language switcher")}
          >
            <button
              type="button"
              className={locale === "zh" ? "selected" : ""}
              aria-pressed={locale === "zh"}
              onClick={() => onLocaleChange("zh")}
            >
              中文
            </button>
            <button
              type="button"
              className={locale === "en" ? "selected" : ""}
              aria-pressed={locale === "en"}
              onClick={() => onLocaleChange("en")}
            >
              EN
            </button>
          </div>
          <FontSizeControl
            value={fontSize}
            locale={locale}
            onChange={onFontSizeChange}
          />
          <span className="article-edition">
            {isExplore
              ? t("EXPLORE 探索稿", "EXPLORE ESSAY")
              : isCompany
                ? t("CAPITAL 公司稿", "CAPITAL & COMPANY")
                : isConversation
                  ? t("PODCAST 播客笔记", "PODCAST NOTES")
                  : t("RADAR 编辑稿", "RADAR EDITORIAL")}
          </span>
        </div>
      </header>

      <article className="article-layout">
        <nav className="article-breadcrumb" aria-label={t("面包屑", "Breadcrumb")}>
          <a
            href={returnHref}
            onClick={(event) => {
              event.preventDefault();
              onBack();
            }}
          >
            {isExplore
              ? t("探索", "Explore")
              : isCompany
                ? t("投资与公司信号", "Investment & Company Signals")
                : isConversation
                  ? t("播客", "Podcasts")
                  : t("焦点", "Focus")}
          </a>
          <span>/</span>
          <span>{signal.category}</span>
        </nav>

        <header className="article-hero">
          <div className="article-kickers">
            <span>{signal.eyebrow}</span>
            <span>{signal.category}</span>
            <span>{dateLabel}</span>
          </div>
          <h1>{signal.title}</h1>
          <p className="article-lead">{article.lead}</p>
          <div className="article-meta">
            {isConversation ? (
              <>
                <span>{signal.guest}</span>
                <span>
                  {t(
                    `约 ${signal.durationMinutes ?? 0} 分钟`,
                    `About ${signal.durationMinutes ?? 0} min`,
                  )}
                </span>
              </>
            ) : (
              <>
                <span>
                  {t(
                    `${signal.validationType} · ${signal.sourceCount} 个独立来源`,
                    `${signal.sourceCount} independent sources`,
                  )}
                </span>
                <span>
                  {isExplore
                    ? t(
                        `探索置信度 · ${signal.confidence ?? "观察中"}`,
                        `Explore confidence · ${signal.confidence ?? "Watching"}`,
                      )
                    : `${t(
                        isCompany ? "公司信号分" : "信号置信度",
                        isCompany
                          ? "Company signal score"
                          : "Signal confidence",
                      )} ${signal.score}/100`}
                </span>
              </>
            )}
          </div>
        </header>

        <div className="article-body-grid">
          <div className="article-copy">
            {signal.updates?.length ? (
              <section className="article-updates">
                <span className="article-section-number">
                  {t("更新", "UPDATES")}
                </span>
                <h2>{t("最新进展", "Latest developments")}</h2>
                <div>
                  {signal.updates.map((update) => (
                    <article key={`${update.addedAt}-${update.title}`}>
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
                      <h3>{update.title}</h3>
                      <p>{update.summary}</p>
                    </article>
                  ))}
                </div>
              </section>
            ) : null}
            {article.sections.map((section, index) => (
              <section key={`${section.heading}-${index}`}>
                <span className="article-section-number">0{index + 1}</span>
                <h2>{section.heading}</h2>
                <p>{section.body}</p>
              </section>
            ))}

            <section className="article-outlook">
              <span className="article-section-number">
                {t("下一步", "NEXT")}
              </span>
              <h2>
                {isExplore
                  ? t("接下来如何验证", "How to test this thesis")
                  : isConversation
                    ? t("听完后继续看什么", "What to follow after listening")
                    : t("接下来观察什么", "What to watch next")}
              </h2>
              <p>{article.outlook}</p>
            </section>

            <aside className="article-method-note">
              <span>{t("编辑说明", "EDITOR’S NOTE")}</span>
              <p>
                {t(
                  isExplore
                    ? "本文是 All We Need 根据下列公开来源形成的探索性判断，不是已被证实的结论。事实、编辑推断与反方观点已分开；原始来源保留在文末，便于逐项核查。"
                    : isConversation
                      ? "本文由 All We Need 根据节目公开内容与时间轴压缩整理。它保留对谈的中心论点、关键细节与主要限制，不替代完整节目；原始节目链接保留在文末。"
                    : "本文由 All We Need 根据下列公开来源综合撰写。事实、来源共识与编辑推断已尽量分开；原始来源保留在文末，便于逐项核查。",
                  isExplore
                    ? "This is an exploratory thesis synthesized from the public sources below, not a settled conclusion. Facts, editorial inference, and counterarguments are separated, with originals preserved for verification."
                    : isConversation
                      ? "All We Need condensed this note from the program’s public materials and chapter outline, preserving its central argument, key details, and principal limitation. It is a guide to—not a substitute for—the full conversation."
                    : "All We Need synthesized this article from the public sources below. Facts, source consensus, and editorial inference are separated where possible, with originals preserved for verification.",
                )}
              </p>
            </aside>
          </div>

          <aside className="article-rail">
            <div className="article-validation-card">
              <span>
                {isExplore
                  ? t("证据如何支撑判断", "HOW THE EVIDENCE CONNECTS")
                  : isCompany
                    ? t("公司判断的证据链", "EVIDENCE BEHIND THE COMPANY READ")
                    : isConversation
                      ? t("为什么值得听", "WHY THIS IS WORTH YOUR TIME")
                      : t("交叉验证结论", "CROSS-VALIDATION")}
              </span>
              <p>{signal.crossValidation}</p>
            </div>
            <div className="article-rail-stat">
              <strong>
                {isConversation ? signal.durationMinutes : signal.sourceCount}
              </strong>
              <span>
                {isConversation
                  ? t("分钟完整节目", "minutes in the full episode")
                  : t("个独立来源支撑本文", "independent sources")}
              </span>
            </div>
          </aside>
        </div>

        <section className="article-sources">
          <div className="article-sources-heading">
            <div>
              <span>{t("原始材料", "SOURCE MATERIAL")}</span>
              <h2>
                {isConversation
                  ? t("打开完整节目", "Open the full episode")
                  : t("这篇稿子基于什么", "What this article is based on")}
              </h2>
            </div>
            <small>{t("点击打开原文", "Open original")}</small>
          </div>
          <div className="article-source-list">
            {signal.evidence.map((evidence, index) => (
              <a
                href={evidence.url}
                target="_blank"
                rel="noreferrer"
                className="article-source-card"
                key={`${evidence.url}-${index}`}
              >
                <span className="article-source-index">0{index + 1}</span>
                <div>
                  <div className="article-source-meta">
                    <span>{shortKind(evidence.sourceKind, locale)}</span>
                    <span>{evidence.role}</span>
                    <strong>{evidence.sourceName}</strong>
                  </div>
                  <h3>{evidence.title}</h3>
                  <p>{evidence.takeaway}</p>
                </div>
                <i aria-hidden="true">↗</i>
              </a>
            ))}
          </div>
        </section>

        <footer className="article-footer">
          <a
            href={returnHref}
            onClick={(event) => {
              event.preventDefault();
              onBack();
            }}
          >
            ←{" "}
            {isExplore
              ? t("返回探索", "Back to Explore")
              : isCompany
                ? t("返回投资与公司信号", "Back to company signals")
                : isConversation
                  ? t("返回播客", "Back to Podcasts")
                  : t("返回焦点", "Back to Focus")}
          </a>
          <span>All We Need · {dateLabel}</span>
        </footer>
      </article>
    </main>
  );
}
