"use client";

import { useEffect } from "react";

type Locale = "zh" | "en";

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
  id: number;
  category: string;
  eyebrow: string;
  title: string;
  summary: string;
  why: string;
  impact: string;
  crossValidation: string;
  validationType: "跨平台验证" | "多账号验证" | "单一来源";
  sourceCount: number;
  score: number;
  article?: {
    lead: string;
    sections: ArticleSection[];
    outlook: string;
  };
  evidence: ArticleEvidence[];
};

function shortKind(kind: string, locale: Locale) {
  if (locale === "zh") {
    if (kind === "Newsletter") return "简报";
    if (kind === "Blog") return "博客";
    return kind;
  }
  if (kind === "YouTube") return "YT";
  if (kind === "Newsletter") return "NL";
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
  onLocaleChange,
  onBack,
}: {
  signal: ArticleSignal;
  locale: Locale;
  generatedAt: string;
  onLocaleChange: (locale: Locale) => void;
  onBack: () => void;
}) {
  const t = (zh: string, en: string) => (locale === "zh" ? zh : en);
  const article = signal.article ?? fallbackArticle(signal, locale);
  useEffect(() => {
    const previousTitle = document.title;
    document.title = `${signal.title} — Signal Radar`;
    return () => {
      document.title = previousTitle;
    };
  }, [signal.title]);
  const dateLabel = new Intl.DateTimeFormat(
    locale === "zh" ? "zh-CN" : "en-US",
    {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "America/New_York",
    },
  ).format(new Date(generatedAt));

  return (
    <main className="article-page">
      <header className="article-topbar">
        <a
          className="article-brand"
          href="./"
          onClick={(event) => {
            event.preventDefault();
            onBack();
          }}
        >
          <span className="brand-mark" aria-hidden="true">
            S
          </span>
          <span>Signal Radar</span>
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
          <span className="article-edition">
            {t("RADAR 编辑稿", "RADAR EDITORIAL")}
          </span>
        </div>
      </header>

      <article className="article-layout">
        <nav className="article-breadcrumb" aria-label={t("面包屑", "Breadcrumb")}>
          <a
            href="./"
            onClick={(event) => {
              event.preventDefault();
              onBack();
            }}
          >
            {t("今日简报", "Today’s Brief")}
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
            <span>
              {t(
                `${signal.validationType} · ${signal.sourceCount} 个独立来源`,
                `${signal.sourceCount} independent sources`,
              )}
            </span>
            <span>
              {t("信号置信度", "Signal confidence")} {signal.score}/100
            </span>
          </div>
        </header>

        <div className="article-body-grid">
          <div className="article-copy">
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
              <h2>{t("接下来观察什么", "What to watch next")}</h2>
              <p>{article.outlook}</p>
            </section>

            <aside className="article-method-note">
              <span>{t("编辑说明", "EDITOR’S NOTE")}</span>
              <p>
                {t(
                  "本文由 Signal Radar 根据下列公开来源综合撰写。事实、来源共识与编辑推断已尽量分开；原始来源保留在文末，便于逐项核查。",
                  "Signal Radar synthesized this article from the public sources below. Facts, source consensus, and editorial inference are separated where possible, with originals preserved for verification.",
                )}
              </p>
            </aside>
          </div>

          <aside className="article-rail">
            <div className="article-validation-card">
              <span>{t("交叉验证结论", "CROSS-VALIDATION")}</span>
              <p>{signal.crossValidation}</p>
            </div>
            <div className="article-rail-stat">
              <strong>{signal.sourceCount}</strong>
              <span>{t("个独立来源支撑本文", "independent sources")}</span>
            </div>
          </aside>
        </div>

        <section className="article-sources">
          <div className="article-sources-heading">
            <div>
              <span>{t("原始材料", "SOURCE MATERIAL")}</span>
              <h2>{t("这篇稿子基于什么", "What this article is based on")}</h2>
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
            href="./"
            onClick={(event) => {
              event.preventDefault();
              onBack();
            }}
          >
            ← {t("返回今日简报", "Back to today’s brief")}
          </a>
          <span>Signal Radar · {dateLabel}</span>
        </footer>
      </article>
    </main>
  );
}
