import controlData from "../data/control-center.json";

type Locale = "zh" | "en";
type RevisionItem = {
  updateId: string;
  signalId: string | number;
  title: string;
  thesisImpact: string;
  status: string;
};

function number(value: number | undefined) {
  return Number(value ?? 0).toLocaleString();
}

export function ControlCenter({ locale }: { locale: Locale }) {
  const t = (zh: string, en: string) => (locale === "zh" ? zh : en);
  const shadow = controlData.models.shadow as
    | {
        attempted?: boolean;
        completed?: boolean;
        primaryModel?: string;
        shadowModel?: string;
        comparison?: { agreementRate?: number; candidateCount?: number };
      }
    | null;
  const agreement =
    shadow?.comparison?.agreementRate === undefined
      ? "—"
      : `${Math.round(shadow.comparison.agreementRate * 100)}%`;

  return (
    <section className="control-center">
      <header className="control-hero">
        <div>
          <p>{t("运行控制台", "OPERATIONS CONTROL")}</p>
          <h1>{t("信息流运行状态", "Feed Operations")}</h1>
          <span>
            {t("最近生成", "Generated")}{" "}
            {new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
              dateStyle: "medium",
              timeStyle: "short",
              timeZone: "America/New_York",
            }).format(new Date(controlData.generatedAt))}
          </span>
        </div>
        <div className="control-health">
          <i />
          <strong>
            {controlData.scan.failedSources === 0
              ? t("采集健康", "Healthy ingest")
              : t("需要处理", "Attention needed")}
          </strong>
        </div>
      </header>

      <div className="control-metric-grid">
        <article>
          <span>{t("连接信源", "Connected")}</span>
          <strong>{number(controlData.scan.successfulSources)}</strong>
          <small>
            {number(controlData.scan.failedSources)} {t("失败", "failed")} ·{" "}
            {number(controlData.scan.needsAuthSources)}{" "}
            {t("待授权", "need auth")}
          </small>
        </article>
        <article>
          <span>{t("待处理候选", "Queued candidates")}</span>
          <strong>{number(controlData.scan.candidateCount)}</strong>
          <small>
            {number(controlData.scan.freshnessExcludedCount)}{" "}
            {t("条被 freshness gate 拦截", "blocked by freshness gate")}
          </small>
        </article>
        <article>
          <span>{t("本轮发布", "Published this run")}</span>
          <strong>
            {number(
              controlData.publication.feedStories +
                controlData.publication.updatedStories +
                controlData.publication.conversations,
            )}
          </strong>
          <small>
            {number(controlData.publication.ignored)} {t("归档", "archived")} ·{" "}
            {number(controlData.publication.deferred)}{" "}
            {t("待重试", "deferred")}
          </small>
        </article>
        <article>
          <span>{t("事件关系图", "Event graph")}</span>
          <strong>{number(controlData.graph.events)}</strong>
          <small>
            {number(controlData.graph.claims)} claims ·{" "}
            {number(controlData.graph.sources)} sources
          </small>
        </article>
      </div>

      <div className="control-columns">
        <section className="control-panel">
          <header>
            <div>
              <span>{t("更新队列", "UPDATE QUEUE")}</span>
              <h2>{t("Lane 分布", "Lane distribution")}</h2>
            </div>
          </header>
          <div className="lane-list">
            {Object.entries(controlData.scan.laneCounts).map(([lane, count]) => (
              <div key={lane}>
                <span>{lane}</span>
                <i>
                  <b
                    style={{
                      width: `${Math.min(
                        100,
                        (Number(count) /
                          Math.max(1, controlData.scan.candidateCount)) *
                          100,
                      )}%`,
                    }}
                  />
                </i>
                <strong>{number(Number(count))}</strong>
              </div>
            ))}
          </div>
        </section>

        <section className="control-panel">
          <header>
            <div>
              <span>{t("模型质量", "MODEL QUALITY")}</span>
              <h2>Terra ↔ Sol</h2>
            </div>
            <strong className="control-agreement">{agreement}</strong>
          </header>
          <dl className="model-readout">
            <div>
              <dt>{t("主模型", "Primary")}</dt>
              <dd>{controlData.models.editorial ?? "—"}</dd>
            </div>
            <div>
              <dt>{t("影子评估", "Shadow")}</dt>
              <dd>
                {shadow?.attempted
                  ? shadow.completed
                    ? t("已完成", "Completed")
                    : t("失败", "Failed")
                  : t("本轮未抽样", "Not sampled")}
              </dd>
            </div>
            <div>
              <dt>{t("近期样本", "Recent samples")}</dt>
              <dd>{number(controlData.models.recentQuality.length)}</dd>
            </div>
          </dl>
        </section>
      </div>

      <section className="control-panel control-revisions">
        <header>
          <div>
            <span>{t("编辑版本控制", "EDITORIAL VERSIONING")}</span>
            <h2>{t("需要重写的核心判断", "Thesis revision queue")}</h2>
          </div>
          <strong>{number(controlData.revisionQueue.length)}</strong>
        </header>
        {controlData.revisionQueue.length ? (
          <div className="revision-list">
            {(controlData.revisionQueue as RevisionItem[]).map((item) => (
              <article key={item.updateId}>
                <span>#{item.signalId}</span>
                <div>
                  <strong>{item.title}</strong>
                  <p>{item.thesisImpact}</p>
                </div>
                <small>{item.status}</small>
              </article>
            ))}
          </div>
        ) : (
          <p className="control-empty">
            {t(
              "目前没有新证据要求改写既有核心判断。",
              "No new evidence currently requires a thesis rewrite.",
            )}
          </p>
        )}
      </section>

      {controlData.scan.freshnessExcluded.length > 0 && (
        <section className="control-panel">
          <header>
            <div>
              <span>FRESHNESS GATE</span>
              <h2>{t("被拦截的旧内容", "Rejected stale items")}</h2>
            </div>
          </header>
          <div className="revision-list">
            {controlData.scan.freshnessExcluded.slice(0, 12).map((item) => (
              <article key={item.url}>
                <span>{item.reason}</span>
                <div>
                  <strong>{item.title}</strong>
                  <p>{item.sourceName}</p>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}
    </section>
  );
}
