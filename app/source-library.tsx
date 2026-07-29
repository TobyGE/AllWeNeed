"use client";

import { useMemo, useState } from "react";
import snapshot from "../data/feed-snapshot.json";
import {
  getSourceKind,
  sourceCatalog,
  type SourceKind,
} from "./source-catalog";

type SourceStatus = {
  sourceId: number;
  status: string;
  itemCount: number;
  message: string;
  feedUrl?: string | null;
};

const kindFilters: Array<"全部" | SourceKind> = [
  "全部",
  "YouTube",
  "X",
  "Newsletter",
  "Blog",
];

function formatTime(value: string | null, locale: "zh" | "en") {
  if (!value) return locale === "zh" ? "尚未抓取" : "Not fetched yet";
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function hostLabel(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function sourceKindLabel(kind: SourceKind, locale: "zh" | "en") {
  if (locale === "zh") {
    if (kind === "Newsletter") return "邮件简报";
    if (kind === "Blog") return "博客";
  }
  return kind;
}

export function SourceLibrary({
  locale,
  onNotice,
}: {
  locale: "zh" | "en";
  onNotice: (message: string) => void;
}) {
  const [kind, setKind] = useState<(typeof kindFilters)[number]>("全部");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(30);
  const [disabled, setDisabled] = useState<number[]>([]);
  const t = (zh: string, en: string) => (locale === "zh" ? zh : en);
  const statusLabel: Record<string, string> = {
    ok: t("已连接", "Connected"),
    empty: t("已连接", "Connected"),
    needs_auth: t("待授权", "Needs auth"),
    error: t("需处理", "Needs review"),
  };

  const statuses = snapshot.statuses as SourceStatus[];
  const statusMap = useMemo(
    () => new Map(statuses.map((status) => [status.sourceId, status])),
    [statuses],
  );

  const counts = useMemo(() => {
    const result: Record<SourceKind, number> = {
      YouTube: 0,
      X: 0,
      Newsletter: 0,
      Blog: 0,
    };
    sourceCatalog.forEach((source) => {
      result[getSourceKind(source.url)] += 1;
    });
    return result;
  }, []);

  const filteredSources = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return sourceCatalog.filter((source) => {
      const sourceKind = getSourceKind(source.url);
      const matchesKind = kind === "全部" || sourceKind === kind;
      const matchesQuery =
        !normalized ||
        `${source.name} ${source.description} ${source.url}`
          .toLowerCase()
          .includes(normalized);
      return matchesKind && matchesQuery;
    });
  }, [kind, query]);

  const recentItems = snapshot.items.slice(0, 8);

  function toggleSource(id: number) {
    setDisabled((items) =>
      items.includes(id)
        ? items.filter((item) => item !== id)
        : [...items, id],
    );
  }

  return (
    <section className="source-library">
      <div className="source-hero">
        <div>
          <span className="section-kicker">
            {t("实时信源网络", "LIVE SOURCE NETWORK")}
          </span>
          <h1>
            {t("信源库已经开始", "The source network is")}
            <br />
            <span>{t("真实采集", "fetching live")}</span>
          </h1>
        </div>
        <div className="refresh-card">
          <span className="pulse-mark" />
          <div>
            <strong>{t("最近抓取成功", "Latest fetch succeeded")}</strong>
            <small>{formatTime(snapshot.generatedAt, locale)}</small>
          </div>
          <button
            type="button"
            onClick={() =>
              onNotice(
                t(
                  "抓取器已配置；自动定时任务将在下一阶段接入",
                  "The fetcher is configured; scheduled runs will arrive in the next phase",
                ),
              )
            }
          >
            {t("抓取说明", "Fetch details")}
          </button>
        </div>
      </div>

      <div className="source-stats">
        <article>
          <span>{t("总信源", "Total sources")}</span>
          <strong>{snapshot.totalSources}</strong>
          <small>{t("完整进入目录", "In the full catalog")}</small>
        </article>
        <article className="stat-green">
          <span>{t("已连接", "Connected")}</span>
          <strong>{snapshot.successfulSources}</strong>
          <small>
            {Math.round(
              (snapshot.successfulSources / snapshot.totalSources) * 100,
            )}
            % {t("可自动采集", "auto-fetchable")}
          </small>
        </article>
        <article className="stat-blue">
          <span>{t("真实内容", "Live items")}</span>
          <strong>{snapshot.items.length.toLocaleString()}</strong>
          <small>{t("当前本地快照", "Current local snapshot")}</small>
        </article>
        <article className="stat-orange">
          <span>{t("X 待授权", "X needs auth")}</span>
          <strong>{snapshot.needsAuthSources}</strong>
          <small>{t("需官方 API 凭证", "Official Bearer Token required")}</small>
        </article>
        <article>
          <span>{t("需处理", "Needs review")}</span>
          <strong>{snapshot.failedSources}</strong>
          <small>{t("未发现公开订阅源", "No public feed found")}</small>
        </article>
      </div>

      <section className="live-items">
        <div className="section-heading">
          <div>
            <span className="section-kicker">{t("刚刚抓取", "JUST FETCHED")}</span>
            <h2>{t("刚刚抓到的内容", "Just Fetched")}</h2>
          </div>
          <span className="live-caption">
            <i /> {t("来自真实来源", "From live sources")}
          </span>
        </div>
        <div className="live-item-grid">
          {recentItems.map((item) => (
            <a
              href={item.url}
              target="_blank"
              rel="noreferrer"
              className="live-item-card"
              key={item.id}
            >
              <div>
                <span className={`kind-badge kind-${item.sourceKind.toLowerCase()}`}>
                  {sourceKindLabel(item.sourceKind as SourceKind, locale)}
                </span>
                <time>{formatTime(item.publishedAt, locale)}</time>
              </div>
              <h3>{item.title}</h3>
              <footer>
                <span>{item.sourceName}</span>
                <span>↗</span>
              </footer>
            </a>
          ))}
        </div>
      </section>

      <section className="catalog-section">
        <div className="section-heading catalog-heading">
          <div>
            <span className="section-kicker">{t("全部信源", "ALL SOURCES")}</span>
            <h2>{t("全部 159 个信源", "All 159 Sources")}</h2>
          </div>
          <label className="catalog-search">
            <span>⌕</span>
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setLimit(30);
              }}
              placeholder={t(
                "搜索名称、简介或域名",
                "Search names, descriptions, or domains",
              )}
              aria-label={t("搜索信源", "Search sources")}
            />
          </label>
        </div>

        <div className="catalog-toolbar">
          <div className="kind-filters">
            {kindFilters.map((filter) => (
              <button
                type="button"
                key={filter}
                className={kind === filter ? "selected" : ""}
                onClick={() => {
                  setKind(filter);
                  setLimit(30);
                }}
              >
                {filter === "全部"
                  ? t("全部", "All")
                  : sourceKindLabel(filter, locale)}
                <span>
                  {filter === "全部" ? sourceCatalog.length : counts[filter]}
                </span>
              </button>
            ))}
          </div>
          <span className="catalog-result">
            {t("显示", "Showing")} {Math.min(limit, filteredSources.length)} /{" "}
            {filteredSources.length}
          </span>
        </div>

        <div className="source-grid">
          {filteredSources.slice(0, limit).map((source) => {
            const sourceKind = getSourceKind(source.url);
            const status = statusMap.get(source.id);
            const isDisabled = disabled.includes(source.id);
            return (
              <article
                className={`source-card ${isDisabled ? "source-disabled" : ""}`}
                key={source.id}
              >
                <div className="source-card-top">
                  <span className={`source-monogram kind-${sourceKind.toLowerCase()}`}>
                    {source.name.slice(0, 2).toUpperCase()}
                  </span>
                  <div>
                    <a href={source.url} target="_blank" rel="noreferrer">
                      {source.name}
                      <span>↗</span>
                    </a>
                    <small>{hostLabel(source.url)}</small>
                  </div>
                  <button
                    type="button"
                    className={`source-toggle ${isDisabled ? "" : "enabled"}`}
                    aria-label={
                      isDisabled
                        ? t("启用此信源", "Enable this source")
                        : t("停用此信源", "Disable this source")
                    }
                    onClick={() => toggleSource(source.id)}
                  >
                    <i />
                  </button>
                </div>
                <p>
                  {locale === "zh"
                    ? source.description
                    : `${sourceKind} source monitored for AI, technology, and investment intelligence.`}
                </p>
                <footer>
                  <span className={`status-chip status-${status?.status ?? "error"}`}>
                    <i />
                    {statusLabel[status?.status ?? "error"]}
                  </span>
                  <span className="source-kind">
                    {sourceKindLabel(sourceKind, locale)}
                  </span>
                  {status?.itemCount ? (
                    <span className="item-count">
                      {status.itemCount} {t("条", "items")}
                    </span>
                  ) : null}
                </footer>
              </article>
            );
          })}
        </div>

        {limit < filteredSources.length && (
          <button
            type="button"
            className="load-more"
            onClick={() => setLimit((value) => value + 30)}
          >
            {t("加载更多信源", "Load more sources")}
            <span>
              {Math.min(30, filteredSources.length - limit)}{" "}
              {t("个", "more")}
            </span>
          </button>
        )}
      </section>

    </section>
  );
}
