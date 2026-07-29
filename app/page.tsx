"use client";

import { useMemo, useState } from "react";

type Signal = {
  id: number;
  category: string;
  eyebrow: string;
  title: string;
  summary: string;
  why: string;
  impact: string;
  sources: string[];
  sourceCount: number;
  age: string;
  score: number;
  tone: "orange" | "blue" | "green";
};

const signals: Signal[] = [
  {
    id: 1,
    category: "AI & 模型",
    eyebrow: "必须知道",
    title: "开源小模型正在抢占端侧推理场景",
    summary:
      "过去 24 小时，多个独立信源都指向同一个变化：更小的模型开始在编码、语音和设备端任务上达到可用阈值。",
    why: "这不是一次单点发布，而是模型能力、硬件适配和部署工具链同时成熟形成的事件簇。",
    impact:
      "如果趋势持续，价值可能从通用 API 进一步转向设备分发、推理优化与垂直数据。",
    sources: ["HF", "Reddit", "Blog"],
    sourceCount: 12,
    age: "18 分钟前",
    score: 94,
    tone: "orange",
  },
  {
    id: 2,
    category: "Agents",
    eyebrow: "必须知道",
    title: "Coding Agent 从个人工具走向团队工作流",
    summary:
      "讨论焦点正在从“能不能写代码”转向权限、审查、任务编排和多人协作，企业采用信号明显增多。",
    why: "来自开发者社区、产品更新和工程负责人访谈的信号互相印证，而不是单一厂商叙事。",
    impact:
      "下一阶段竞争壁垒可能来自工作流控制面、上下文沉淀和企业治理，而非单纯模型能力。",
    sources: ["X", "YouTube", "Blog"],
    sourceCount: 9,
    age: "46 分钟前",
    score: 91,
    tone: "blue",
  },
  {
    id: 3,
    category: "算力",
    eyebrow: "趋势变化",
    title: "推理价格战开始转向延迟与可靠性",
    summary:
      "公开报价继续下降，但高质量讨论更多集中在首 token 延迟、峰值稳定性和批处理吞吐。",
    why: "成本仍重要，但开发者选择供应商时正在加入更接近生产环境的评价指标。",
    impact:
      "只卖便宜算力的服务商将承压，具备调度能力、硬件优化和稳定 SLA 的平台更有机会。",
    sources: ["Reddit", "X", "Blog"],
    sourceCount: 7,
    age: "1 小时前",
    score: 87,
    tone: "green",
  },
  {
    id: 4,
    category: "投资",
    eyebrow: "资本信号",
    title: "AI 基础设施融资正在向数据与评测层扩散",
    summary:
      "近期被关注的早期项目不再只做训练或推理，而是围绕数据质量、持续评测和可观测性建立产品。",
    why: "招聘、开源活跃度和投资人讨论同时上升，说明需求可能正在从试验阶段进入生产阶段。",
    impact:
      "值得建立一组“模型生产基础设施”观察名单，并持续跟踪客户采用而不只是融资金额。",
    sources: ["X", "HF", "Blog"],
    sourceCount: 6,
    age: "2 小时前",
    score: 82,
    tone: "orange",
  },
];

const trends = [
  { name: "端侧模型", change: "+38%", bars: [32, 48, 44, 61, 73, 92] },
  { name: "Agent 评测", change: "+24%", bars: [26, 31, 45, 39, 58, 75] },
  { name: "推理芯片", change: "+17%", bars: [41, 37, 50, 56, 61, 68] },
  { name: "合成数据", change: "+11%", bars: [34, 42, 38, 46, 52, 57] },
];

const discoveries = [
  {
    mark: "DS",
    name: "模型数据谱系",
    detail: "3 个高信号作者开始连续讨论",
    source: "跨 X · Blog · HF",
    color: "blue",
  },
  {
    mark: "RL",
    name: "强化学习环境",
    detail: "过去一周新增 8 个活跃项目",
    source: "Hugging Face · GitHub",
    color: "orange",
  },
  {
    mark: "VC",
    name: "垂直 AI 工作流",
    detail: "投资人关注度连续 4 天上升",
    source: "X · YouTube · Blog",
    color: "green",
  },
];

const categories = ["全部", "AI & 模型", "Agents", "算力", "投资"];

export default function Home() {
  const [activeCategory, setActiveCategory] = useState("全部");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<number[]>([1]);
  const [saved, setSaved] = useState<number[]>([]);
  const [following, setFollowing] = useState<string[]>([]);
  const [view, setView] = useState<"brief" | "explore">("brief");
  const [notice, setNotice] = useState("");

  const visibleSignals = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return signals.filter((signal) => {
      const matchesCategory =
        activeCategory === "全部" || signal.category === activeCategory;
      const matchesQuery =
        !normalized ||
        `${signal.title} ${signal.summary} ${signal.sources.join(" ")}`
          .toLowerCase()
          .includes(normalized);
      return matchesCategory && matchesQuery;
    });
  }, [activeCategory, query]);

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

        <nav className="side-nav" aria-label="主要导航">
          <button className="nav-item active" type="button">
            <span aria-hidden="true">⌁</span>
            今日雷达
            <span className="nav-count">6</span>
          </button>
          <button className="nav-item" type="button">
            <span aria-hidden="true">◎</span>
            探索
          </button>
          <button className="nav-item" type="button">
            <span aria-hidden="true">◇</span>
            追踪清单
            <span className="nav-count">{12 + following.length}</span>
          </button>
          <button className="nav-item" type="button">
            <span aria-hidden="true">☆</span>
            已收藏
            {saved.length > 0 && <span className="nav-count">{saved.length}</span>}
          </button>
        </nav>

        <div className="side-section">
          <p className="side-label">你的雷达</p>
          {["AI & 模型", "Agents", "算力与芯片", "创投动态"].map(
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
            onClick={() => showNotice("主题管理将在数据接入阶段开放")}
          >
            ＋ 添加主题
          </button>
        </div>

        <div className="coverage-card">
          <div className="coverage-top">
            <span>今日覆盖</span>
            <span className="live-dot">实时</span>
          </div>
          <strong>1,284</strong>
          <p>条内容已扫描</p>
          <div className="coverage-grid">
            <span>X · 468</span>
            <span>Blog · 243</span>
            <span>Reddit · 311</span>
            <span>HF · 262</span>
          </div>
        </div>

        <div className="profile">
          <span className="avatar">YQ</span>
          <div>
            <strong>研究小组</strong>
            <span>3 位成员</span>
          </div>
          <button
            type="button"
            aria-label="打开账户设置"
            onClick={() => showNotice("账户与成员设置尚未接入")}
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
          <label className="search">
            <span aria-hidden="true">⌕</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索事件、公司、人物或主题"
              aria-label="搜索情报"
            />
            <kbd>⌘ K</kbd>
          </label>
          <div className="top-actions">
            <span className="demo-label">DEMO DATA</span>
            <button
              className="icon-button"
              type="button"
              aria-label="查看通知"
              onClick={() => showNotice("目前没有新的通知")}
            >
              ♢
              <span className="notification-dot" />
            </button>
            <button
              className="digest-button"
              type="button"
              onClick={() =>
                showNotice("今日简报已准备好，将在 08:00 自动发送")
              }
            >
              <span aria-hidden="true">✦</span>
              每日简报
            </button>
          </div>
        </header>

        <div className="content">
          <section className="page-intro">
            <div>
              <p className="date-line">2026 年 7 月 28 日 · 星期二</p>
              <h1>
                今天真正需要知道的，
                <br />
                只有 <span>6 件事</span>
              </h1>
              <p className="intro-copy">
                从 1,284 条跨平台内容中识别并合并。事实、共识与推断分开呈现。
              </p>
            </div>
            <div className="brief-score">
              <div>
                <span className="score-ring">92</span>
                <span>
                  今日信号质量
                  <small>比过去 7 天高 8%</small>
                </span>
              </div>
              <div className="source-stack" aria-label="已覆盖平台">
                <span>X</span>
                <span>YT</span>
                <span>R</span>
                <span>HF</span>
                <span>+9</span>
              </div>
            </div>
          </section>

          <div className="view-row">
            <div className="view-switch" aria-label="内容视图">
              <button
                type="button"
                className={view === "brief" ? "selected" : ""}
                onClick={() => setView("brief")}
              >
                今日简报
              </button>
              <button
                type="button"
                className={view === "explore" ? "selected" : ""}
                onClick={() => setView("explore")}
              >
                探索信息流
              </button>
            </div>
            <div className="category-filters" aria-label="主题筛选">
              {categories.map((category) => (
                <button
                  type="button"
                  key={category}
                  className={activeCategory === category ? "selected" : ""}
                  onClick={() => setActiveCategory(category)}
                >
                  {category}
                </button>
              ))}
            </div>
          </div>

          <div className="dashboard-grid">
            <section className="feed-column">
              <div className="section-heading">
                <div>
                  <span className="section-kicker">
                    {view === "brief" ? "MUST KNOW" : "DISCOVERY FEED"}
                  </span>
                  <h2>
                    {view === "brief" ? "必须知道" : "为你发现的高信号内容"}
                  </h2>
                </div>
                <span className="result-count">{visibleSignals.length} 个事件簇</span>
              </div>

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
                          <span>{signal.age}</span>
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
                            <div>
                              <span className="analysis-label">为什么重要</span>
                              <p>{signal.why}</p>
                            </div>
                            <div>
                              <span className="analysis-label">可能影响</span>
                              <p>{signal.impact}</p>
                            </div>
                          </div>
                        )}

                        <div className="signal-footer">
                          <div className="source-pills">
                            {signal.sources.map((source) => (
                              <span key={source}>{source}</span>
                            ))}
                            <small>{signal.sourceCount} 个来源相互印证</small>
                          </div>
                          <div className="card-actions">
                            <span className="signal-score">
                              <i style={{ width: `${signal.score}%` }} />
                              {signal.score}
                            </span>
                            <button
                              type="button"
                              className={isSaved ? "saved" : ""}
                              aria-label={isSaved ? "取消收藏" : "收藏此信号"}
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
                    <strong>没有找到匹配的情报</strong>
                    <p>换一个关键词或清除主题筛选。</p>
                    <button
                      type="button"
                      onClick={() => {
                        setQuery("");
                        setActiveCategory("全部");
                      }}
                    >
                      清除筛选
                    </button>
                  </div>
                )}
              </div>
            </section>

            <aside className="insight-column">
              <section className="panel trend-panel">
                <div className="panel-heading">
                  <div>
                    <span className="section-kicker">MOMENTUM</span>
                    <h2>正在升温</h2>
                  </div>
                  <button
                    type="button"
                    aria-label="查看所有趋势"
                    onClick={() => showNotice("完整趋势图谱将在下一阶段开放")}
                  >
                    ↗
                  </button>
                </div>
                <div className="trend-list">
                  {trends.map((trend) => (
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
                <p className="panel-note">基于讨论速度、跨平台扩散和信源质量综合计算</p>
              </section>

              <section className="panel discovery-panel">
                <div className="panel-heading">
                  <div>
                    <span className="section-kicker">DISCOVERED FOR YOU</span>
                    <h2>新发现</h2>
                  </div>
                  <span className="new-badge">3 NEW</span>
                </div>
                <div className="discovery-list">
                  {discoveries.map((item) => {
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
                          {isFollowing ? "已追踪" : "＋ 追踪"}
                        </button>
                      </article>
                    );
                  })}
                </div>
              </section>

              <section className="panel thesis-panel">
                <span className="section-kicker">INVESTMENT LENS</span>
                <h2>今日投资假设</h2>
                <blockquote>
                  “模型能力正在商品化，差异化价值将更快向部署、数据和分发迁移。”
                </blockquote>
                <div className="thesis-footer">
                  <div className="confidence">
                    <span>置信度</span>
                    <strong>中高</strong>
                  </div>
                  <span className="team-avatars">
                    <i>Y</i>
                    <i>L</i>
                    <i>W</i>
                  </span>
                  <span className="team-agree">3 人认同</span>
                </div>
                <button
                  className="thesis-action"
                  type="button"
                  onClick={() => showNotice("已加入小组研究议程")}
                >
                  加入研究议程
                  <span>→</span>
                </button>
              </section>
            </aside>
          </div>

          <section className="signal-table-section">
            <div className="section-heading">
              <div>
                <span className="section-kicker">CAPITAL & COMPANY SIGNALS</span>
                <h2>投资与公司信号</h2>
              </div>
              <button
                type="button"
                className="text-action"
                onClick={() => showNotice("完整公司追踪清单将在数据接入后显示")}
              >
                查看全部 24 条 →
              </button>
            </div>
            <div className="signal-table">
              <div className="table-head">
                <span>实体 / 主题</span>
                <span>信号</span>
                <span>来源</span>
                <span>强度</span>
                <span>变化</span>
              </div>
              {[
                ["端侧 AI", "招聘与开源贡献同步增长", "8 个来源", "高", "↑ 18%"],
                ["模型评测", "新项目集中出现", "6 个来源", "中高", "↑ 12%"],
                ["推理平台", "开发者迁移讨论增加", "11 个来源", "中", "↑ 7%"],
              ].map((row) => (
                <div className="table-row" key={row[0]}>
                  <strong>{row[0]}</strong>
                  <span>{row[1]}</span>
                  <span>{row[2]}</span>
                  <span>
                    <i className={`strength strength-${row[3]}`} />
                    {row[3]}
                  </span>
                  <span className="change">{row[4]}</span>
                </div>
              ))}
            </div>
          </section>

          <footer className="footer">
            <span>
              <i className="status-dot" /> 原型数据 · 真实信源连接器尚未启用
            </span>
            <span>最后刷新于 2 分钟前</span>
          </footer>
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
