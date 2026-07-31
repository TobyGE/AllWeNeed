import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const canonicalSnapshotPath = resolve(projectRoot, "data/feed-snapshot.json");
const radarPath = resolve(projectRoot, "data/daily-radar.json");
const statePath = resolve(projectRoot, "data/incremental-state.json");
const resultPath = resolve(projectRoot, "tmp/incremental-result.json");
const authPath = resolve(homedir(), ".codex/auth.json");
const groundingSkillPath = resolve(
  homedir(),
  ".codex/skills/radar-grounding/SKILL.md",
);
const editorialSkillDirectory = resolve(
  homedir(),
  ".codex/skills/radar-editorial-research",
);
const endpoint = "https://chatgpt.com/backend-api/codex/responses";
const preferredModels = [
  process.env.SIGNAL_RADAR_MODEL?.trim(),
  "gpt-5.6-sol",
  "gpt-5.5",
].filter(Boolean);
const overlapMs = 6 * 60 * 60 * 1_000;
const requestedCandidateItems = Number(
  argumentValue("limit") ?? process.env.SIGNAL_RADAR_BATCH_SIZE ?? 8,
);
const maxCandidateItems =
  Number.isInteger(requestedCandidateItems) && requestedCandidateItems > 0
    ? Math.min(requestedCandidateItems, 24)
    : 8;
const maxFeedStoriesPerRun = 24;
const exploreEditorialFloor = 80;
const maxGroundingItemsPerRun = Math.max(
  1,
  Math.min(
    8,
    Number(process.env.SIGNAL_RADAR_GROUNDING_LIMIT ?? 6) || 6,
  ),
);
const maxEditorialResearchItemsPerRun = Math.max(
  1,
  Math.min(
    8,
    Number(process.env.SIGNAL_RADAR_RESEARCH_LIMIT ?? 4) || 4,
  ),
);
const editorialResearchTimeoutMs = Math.max(
  30_000,
  Math.min(
    180_000,
    Number(process.env.SIGNAL_RADAR_RESEARCH_TIMEOUT_MS ?? 90_000) || 90_000,
  ),
);
const editorialResearchChunkSize = Math.max(
  1,
  Math.min(
    3,
    Number(process.env.SIGNAL_RADAR_RESEARCH_CHUNK_SIZE ?? 2) || 2,
  ),
);
const editorialResearchConcurrency = Math.max(
  1,
  Math.min(
    3,
    Number(process.env.SIGNAL_RADAR_RESEARCH_CONCURRENCY ?? 2) || 2,
  ),
);
const preferredGroundingModels = [
  process.env.SIGNAL_RADAR_GROUNDING_MODEL?.trim(),
  "gpt-5.5",
  ...preferredModels,
].filter((value, index, values) => value && values.indexOf(value) === index);

function argumentValue(name) {
  const prefix = `--${name}=`;
  return process.argv
    .find((argument) => argument.startsWith(prefix))
    ?.slice(prefix.length);
}

function cleanText(value = "") {
  return String(value)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTitle(value = "") {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function itemTime(item, fallback) {
  const parsed = Date.parse(item.publishedAt ?? "");
  if (!Number.isFinite(parsed)) return fallback;
  return item.dateOnly ? parsed + 86_399_999 : parsed;
}

function itemProcessingKey(item) {
  return item.versionKey ?? item.url;
}

function incrementalRelevance(item, snapshotTime) {
  const text = `${item.title} ${item.summary}`.toLowerCase();
  const terms = [
    "fomc",
    "federal reserve",
    "interest rate",
    "monetary policy",
    "inflation",
    "earnings",
    "revenue",
    "net income",
    "guidance",
    "10-q",
    "10-k",
    "8-k",
    "20-f",
    "6-k",
    "launch",
    "release",
    "acquisition",
    "funding",
    "security",
    "breach",
    "regulation",
    "openai",
    "anthropic",
    "nvidia",
    "model",
    "agent",
    "chip",
  ];
  const ageHours = Math.max(
    0,
    (snapshotTime - itemTime(item, snapshotTime)) / 3_600_000,
  );
  const officialBonus = ["Fed", "SEC"].includes(item.sourceKind) ? 10 : 0;
  const discoveryBonus =
    item.discoveryOnly && item.discoveryLevel === "B"
      ? 8
      : item.discoveryOnly
        ? 3
        : 0;
  const termScore = terms.reduce(
    (score, term) => score + (text.includes(term) ? 2 : 0),
    0,
  );
  return (
    officialBonus +
    discoveryBonus +
    termScore +
    Math.max(0, 36 - ageHours) / 6
  );
}

export function selectIncrementalItems({
  scannedSnapshot,
  previousSnapshot,
  state,
}) {
  const snapshotTime = Date.parse(scannedSnapshot.generatedAt);
  const processedKeys = new Set(
    state?.processedKeys?.length
      ? state.processedKeys
      : state?.processedUrls?.length
        ? state.processedUrls
        : previousSnapshot.items.map(itemProcessingKey),
  );
  const initializedSourceIds = new Set(
    state?.initializedSourceIds?.length
      ? state.initializedSourceIds.map(String)
      : previousSnapshot.items.map((item) => String(item.sourceId)),
  );
  const windowStart = Date.parse(
    state?.windowStartAt ??
      state?.lastScanAt ??
      previousSnapshot.generatedAt ??
      scannedSnapshot.generatedAt,
  );
  const existingSourceCutoff = windowStart - overlapMs;

  return scannedSnapshot.items
    .filter((item) => {
      const sourceInitialized = initializedSourceIds.has(
        String(item.sourceId),
      );
      const publishedAt = Date.parse(item.publishedAt ?? "");
      const recentEnough = sourceInitialized
        ? itemTime(item, snapshotTime) >= existingSourceCutoff
        : Number.isFinite(publishedAt) && publishedAt >= windowStart;
      return (
        Boolean(item.url) &&
        recentEnough &&
        !processedKeys.has(itemProcessingKey(item))
      );
    })
    .sort(
      (left, right) =>
        incrementalRelevance(right, snapshotTime) -
        incrementalRelevance(left, snapshotTime),
    )
    .slice(0, maxCandidateItems)
    .map((item, index) => ({
      ...item,
      sourcePublisher: item.sourcePublisher ?? item.sourceName,
      ref: `N${index + 1}`,
    }));
}

function buildPrompt({ candidates, radar, scannedSnapshot }) {
  const existingTitles = radar.signals
    .slice(0, 80)
    .map(
      (signal) =>
        `id=${signal.id} | ${signal.title} | ${cleanText(signal.summary).slice(0, 120)} | ` +
        `updates=${(signal.updates ?? [])
          .slice(0, 3)
          .map((update) => cleanText(update.title))
          .join("; ") || "none"} | ` +
        `evidence=${(signal.evidence ?? [])
          .slice(-4)
          .map((evidence) => cleanText(evidence.title))
          .join("; ") || "none"}`,
    )
    .join("\n");
  const compactItems = candidates
    .map(
      (item) =>
        `${item.ref} | ${item.publishedAt ?? "unknown"} | ${item.sourceKind} | ${item.sourceName} | publisher=${item.sourcePublisher} | discoveryOnly=${Boolean(item.discoveryOnly)} | groundedFrom=${item.groundedFrom ?? "none"} | researchedFrom=${item.researchedFrom ?? "none"}\n` +
        `标题: ${cleanText(item.title).slice(0, 240)}\n` +
        `摘要: ${cleanText(item.summary).slice(0, 500) || "无摘要"}`,
    )
    .join("\n\n");

  return `你是 Signal Radar 持续信息流的增量编辑。这里没有“日报”或日期版次；你只能处理本次新增条目，不得重写旧稿。

任务：逐条处理本次新增内容，先聚合同一事件，再按照编辑价值决定进入“动态”、进入“探索”，或归档不展示。处理过但未入选的条目不会在以后重新候选，因此每个 ref 都必须有明确去向。

收录规则：
- 每个 ref 必须且只能出现在一个 feedStory、existingUpdate 或 ignored 中。
- bucket=dynamic 只用于已经发生的明确状态变化：发布、财报、监管、融资、产品上线、政策决定或有实质新证据的事件。必须有足够正文和可核验事实；官方一手来源可以单独成立。
- dynamic 是稀缺的新闻席位，不是“值得知道”的同义词。只有以下变化可以进入：会改变公司经营或资本判断的财报/guidance/融资/M&A；已落地的监管或宏观决定；改变价格、可用范围、分发方式或产业采用的重大产品/模型发布；有明确影响范围的真实安全事件；或至少两条独立来源共同确认的行业状态转折。
- 小版本、library/repository/demo、preview/alpha、单点技巧、孤立研究论文、单篇 Blog 观察、窄功能更新和一般知识不得因为“刚发布”进入 dynamic；如果也没有形成高价值 thesis，则直接 ignored，不能把 Explore 当作低质量内容的兜底区。
- bucket=explore 是稀缺的第二编辑层，只用于有清晰 thesis、二阶影响、跨界连接或值得持续验证的非共识判断。必须写清“什么变量正在变化”、作用机制和可证伪的下一步，不能只是把单篇内容换句话复述。
- Explore 的 valueScore 必须至少为 ${exploreEditorialFloor}，materiality 必须为 substantive 或 material，changedVariable 必须具体。低于门槛的“小知识”、普通教程、一般产品观察、营销发布、缺少机制的观点和仅靠措辞包装出的假设全部 ignored，并在 reason 前加“归档：未达到 Explore 编辑门槛”。
- 内容单薄、题目党、未经验证的规模数字、过窄教程、个人随感、与 Radar 重点弱相关的条目放进 ignored，并在 reason 前加“归档：”。“已处理”不等于“必须发布”。
- Radar 的核心范围是 AI、semiconductor、cloud infrastructure、developer tools、cybersecurity、robotics、frontier science、核心科技公司，以及直接影响这些领域的 Fed/监管/资本事件。“投资”只是观察角度，不是独立主题；普通消费、化工、地产、医药、传统制造公司的泛财报、荐股与行情内容必须 ignored，不能仅因出现“业绩、利润、融资、锂电”等词进入动态或探索。
- “大佬持仓跟踪、主力资金、龙虎榜、特供、研报精选”等付费导流、荐股或营销包装一律 ignored，即使 grounding 能找到真实公司公告也不能转成稿件。
- bucket=dynamic 的至少一条核心 evidence 必须是在本次扫描前 7 天内发布的新一手事实。旧公告被新快讯、回顾文章或营销内容重新提及时，不构成新事件；如果没有新的状态变化必须 ignored。旧资料只能作为新事件的背景证据。
- valueScore 必须是 0–99 的绝对编辑价值分，不是第1、第2、第3的名次。综合评估：影响范围 30%、信息增量 25%、证据强度 25%、对 AI/科技/投资判断的可行动性 20%。同一批内容将按此分数从高到低排列。
- dynamic 的 valueScore 必须至少为 82；低于 82 的内容只有同时达到 Explore 的 ${exploreEditorialFloor} 分硬门槛与 thesis 标准时才能进入 explore，否则 ignored。宁缺毋滥，不为动态或 Explore 凑数。
- 单一 Blog、YouTube、Newsletter、Fed 或 SEC 来源都允许收录，并标为“单一来源”；出现更多独立来源时再做 cross-validation。
- 多条新增内容讲同一事件时合并成一篇稿件，逐项列出不同来源提供的事实或观点。
- 若新增内容只是在佐证现有事件，或为现有事件补充了后续进展，放进 existingUpdates，追加“最新进展”和新 evidence；不得重写旧稿正文。只有出现可独立理解的新事件时才新建 feedStory。
- Fed statement 若没有利率决定、投票和关键措辞，SEC 业绩文件若只有 filing metadata 而没有财务数字或附件正文，不得生成稿件；放进 ignored 并注明“等待官方正文 enrichment”，留给后续新证据更新。
- SEC 财报优先使用 R ref 补齐 actuals、同比、关键 KPI、guidance 和具名 analyst consensus。不得在没有可比一致预期时声称 beat/miss；若搜索后仍没有可靠 consensus，应把文章中心放到增长、margin、cash flow、guidance 或经营指标，不得在正文解释“为什么不作 beat/miss 判断”。
- discoveryOnly=true 的条目只是匿名内部发现线索，不是证据。它必须进入 ignored，理由写“归档：匿名发现线索已消费”；不得在标题、正文、evidence、来源名或链接中暴露或复述该线索。
- groundedFrom 不为 none 的条目是外部 grounding 找到的可公开证据，可以正常进入 evidence。由匿名线索触发的动态，至少需要一条公司/监管/交易所等一手来源，或两条彼此独立的可靠来源；否则不得发布动态。
- Grounding 来源若在数字、日期、单位或事件状态上冲突，只能进入探索并明确写出冲突，或归档等待确认。
- 所有事实和数字必须来自 evidence；编辑判断必须使用审慎语气。
- article 必须围绕一个 central claim。研究限制只能在确实影响某个具体事实时出现一次，不能把“未验证”“单一来源”或“缺少数据”写成文章主线。Explore 正文约 70–80% 用于建立 thesis 与机制，反证和证伪条件集中在一个段落。
- 每条都要提供完整中文稿和英文稿，专有名词保持原文。
- 本批最多 ${maxFeedStoriesPerRun} 篇；如果多个条目属于同一事件，应优先聚类而不是截断。

现有新闻标题，用于避免把完全相同的内容重复成稿：
${existingTitles}

只返回合法 JSON：
{
  "feedStories": [
    {
      "bucket": "dynamic|explore",
      "materiality": "material|substantive|minor",
      "changedVariable": "具体写出发生变化的价格、能力、政策、经营指标、风险状态或可用范围",
      "valueScore": 0,
      "signal": {
        "category": "AI & 模型|Agents|算力|投资|科技|宏观",
        "eyebrow": "最新进展|趋势变化|资本信号|风险预警|产品信号|观点",
        "title": "中文标题，不超过28字",
        "summary": "中文摘要，不超过100字",
        "why": "为什么重要，不超过90字",
        "impact": "审慎的潜在影响，不超过90字",
        "shiftFrom": "此前状态，不超过28字",
        "shiftTo": "当前变化，不超过28字",
        "crossValidation": "具体说明证据关系，不超过110字",
        "article": {
          "lead": "80-160字中文导语",
          "sections": [
            {"heading": "小标题", "body": "120-240字正文"},
            {"heading": "小标题", "body": "120-240字正文"},
            {"heading": "小标题", "body": "120-240字正文"}
          ],
          "outlook": "80-150字，写可验证的下一步"
        },
        "evidence": [
          {"ref": "N1", "role": "主张|佐证|背景|反例", "takeaway": "仅概括该来源"}
        ],
        "score": 60
      },
      "translation": {
        "category": "English category",
        "eyebrow": "English eyebrow",
        "title": "English headline",
        "summary": "English summary",
        "why": "Why it matters",
        "impact": "Potential impact",
        "shiftFrom": "Previous state",
        "shiftTo": "Current change",
        "crossValidation": "How the evidence relates",
        "article": {
          "lead": "English lead",
          "sections": [
            {"heading": "Heading", "body": "Body"},
            {"heading": "Heading", "body": "Body"},
            {"heading": "Heading", "body": "Body"}
          ],
          "outlook": "What to watch next"
        },
        "evidence": [
          {"role": "Claim|Support|Context|Counterpoint", "takeaway": "Source-specific takeaway"}
        ]
      }
    }
  ],
  "existingUpdates": [
    {
      "existingSignalId": 1,
      "valueScore": 0,
      "update": {
        "title": "中文更新标题，不超过28字",
        "summary": "只写这次新增了什么，不超过120字",
        "evidence": [
          {"ref": "N1", "role": "佐证|最新进展|背景|反例", "takeaway": "仅概括该来源的新信息"}
        ]
      },
      "translation": {
        "title": "English update title",
        "summary": "What is newly added",
        "evidence": [
          {"role": "Support|Update|Context|Counterpoint", "takeaway": "Source-specific new information"}
        ]
      }
    }
  ],
  "ignored": [
    {"ref": "N1", "reason": "归档：具体编辑判断，或完全重复/无正文/垃圾内容"}
  ]
}

扫描时间：${scannedSnapshot.generatedAt}
本次新增候选：
${compactItems}`;
}

const fallbackGroundingInstructions = `
Treat every discovery item only as a private search lead. Search current public
sources and trace material claims to regulators, exchanges, company IR,
official filings, original research, or independently sourced reporting.
Separate reported actuals, guidance, and third-party consensus. Return
unverified when the claim cannot be supported. Never return the discovery
publisher, wording, or URL as a public source.
`.trim();

async function loadGroundingSkill() {
  try {
    const skill = await readFile(groundingSkillPath, "utf8");
    return skill.replace(/^---[\s\S]*?---\s*/u, "").trim();
  } catch {
    return fallbackGroundingInstructions;
  }
}

const fallbackEditorialInstructions = `
Research missing material facts before writing. Separate reported actuals,
company guidance, third-party consensus, observed reaction, and editorial
inference. A consensus comparison must name a provider, period, metric, and
accounting basis. If no defensible consensus is public, center the story on
growth, guidance, margins, cash flow, or operating KPIs and omit beat/miss
language without narrating the research gap. Write one centered argument.
Uncertainty and the strongest countercase should appear once, not dominate the
article.
`.trim();

async function loadEditorialSkill() {
  try {
    const [skill, matrices, writing] = await Promise.all([
      readFile(resolve(editorialSkillDirectory, "SKILL.md"), "utf8"),
      readFile(
        resolve(
          editorialSkillDirectory,
          "references/research-matrices.md",
        ),
        "utf8",
      ),
      readFile(
        resolve(editorialSkillDirectory, "references/writing-standard.md"),
        "utf8",
      ),
    ]);
    return [
      skill.replace(/^---[\s\S]*?---\s*/u, "").trim(),
      matrices.trim(),
      writing.trim(),
    ].join("\n\n");
  } catch {
    return fallbackEditorialInstructions;
  }
}

function buildGroundingPrompt(discoveryItems) {
  const items = discoveryItems
    .map(
      (item) =>
        `${item.ref} | ${item.publishedAt ?? "unknown"}\n` +
        `事件线索: ${cleanText(item.title).slice(0, 240)}\n` +
        `待核验主张: ${cleanText(item.summary).slice(0, 700)}`,
    )
    .join("\n\n");
  return `使用 live web search 核验以下匿名事件线索。逐条提取可验证主张，并回溯到可公开展示的一手或独立来源。

要求：
- 每个 ref 必须且只能返回一次。
- 不得把线索发布方、线索 URL 或线索原文当作 source。
- 公司财报、产品发布、监管或政策事件优先找公司 IR、正式公告、监管披露、交易所、政府或原始文件。
- reported actuals、company guidance 与 analyst consensus 必须分开；一致预期没有可靠来源时不要补写。
- grounded 需要一条匹配的一手来源，或两条彼此独立的可靠来源。
- 关键数字、日期、单位或状态不一致时标为 conflicted；找不到足够证据时标为 unverified。
- URL 必须是 canonical http/https 原文链接，不得是搜索结果页。
- sourceKind 只能是 Official、IR、Regulator、SEC、Research、Media 之一。

只返回合法 JSON：
{
  "results": [
    {
      "ref": "N1",
      "status": "grounded|conflicted|unverified",
      "claim": "核验后的简洁主张",
      "notes": "差异或限制；无则空字符串",
      "sources": [
        {
          "title": "原文标题",
          "url": "https://...",
          "publisher": "发布机构",
          "publishedAt": "ISO 8601 或 null",
          "sourceKind": "Official|IR|Regulator|SEC|Research|Media",
          "summary": "该来源具体确认了什么"
        }
      ]
    }
  ]
}

匿名事件线索：
${items}`;
}

function safeGroundingUrl(value) {
  try {
    const url = new URL(cleanText(value));
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (
      url.hostname === "cls.cn" ||
      url.hostname.endsWith(".cls.cn") ||
      url.hostname.endsWith(".cailianpress.com")
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function normalizeGroundingDate(value, fallback) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

export function hydrateGroundingCandidates({
  raw,
  discoveryItems,
  generatedAt,
}) {
  const itemMap = new Map(discoveryItems.map((item) => [item.ref, item]));
  const allowedKinds = new Set([
    "Official",
    "IR",
    "Regulator",
    "SEC",
    "Research",
    "Media",
  ]);
  const candidates = [];
  const seenUrls = new Set();

  for (const result of raw?.results ?? []) {
    const parent = itemMap.get(result?.ref);
    if (!parent || result?.status !== "grounded") continue;
    for (const source of (result.sources ?? []).slice(0, 3)) {
      const url = safeGroundingUrl(source?.url);
      const title = cleanText(source?.title).slice(0, 240);
      const publisher = cleanText(source?.publisher).slice(0, 120);
      const summary = cleanText(source?.summary).slice(0, 1_000);
      if (!url || !title || !publisher || !summary || seenUrls.has(url)) {
        continue;
      }
      seenUrls.add(url);
      const sourceKind = allowedKinds.has(source?.sourceKind)
        ? source.sourceKind
        : "Official";
      candidates.push({
        id: `ground-${parent.id}-${candidates.length + 1}-${url}`,
        sourceId: parent.sourceId,
        sourceName: publisher,
        sourcePublisher: publisher,
        sourceKind,
        title,
        url,
        publishedAt: normalizeGroundingDate(
          source.publishedAt,
          parent.publishedAt ?? generatedAt,
        ),
        summary,
        fetchedAt: generatedAt,
        groundedFrom: parent.ref,
        groundingClaim: cleanText(result.claim).slice(0, 600),
        groundingNotes: cleanText(result.notes).slice(0, 600),
      });
    }
  }
  return candidates.map((item, index) => ({
    ...item,
    ref: `G${index + 1}`,
  }));
}

export function selectEditorialResearchItems(candidates) {
  const materialTerms = [
    "earnings",
    "results",
    "revenue",
    "net income",
    "eps",
    "guidance",
    "10-q",
    "10-k",
    "8-k",
    "20-f",
    "6-k",
    "fomc",
    "federal reserve",
    "interest rate",
    "inflation",
    "funding",
    "acquisition",
    "merger",
    "launch",
    "release",
    "benchmark",
    "security",
    "breach",
    "vulnerability",
    "cve-",
  ];
  const materialKinds = new Set([
    "Fed",
    "SEC",
    "IR",
    "Official",
    "Regulator",
    "Research",
  ]);
  return candidates
    .filter((item) => {
      if (item.discoveryOnly) return false;
      const text = `${item.title ?? ""} ${item.summary ?? ""}`.toLowerCase();
      return (
        materialKinds.has(item.sourceKind) ||
        materialTerms.some((term) => text.includes(term))
      );
    })
    .sort(
      (left, right) =>
        incrementalRelevance(right, Date.now()) -
        incrementalRelevance(left, Date.now()),
    )
    .slice(0, maxEditorialResearchItemsPerRun);
}

function buildEditorialResearchPrompt(researchItems) {
  const items = researchItems
    .map(
      (item) =>
        `${item.ref} | ${item.publishedAt ?? "unknown"} | ${item.sourceKind} | ${item.sourceName}\n` +
        `标题: ${cleanText(item.title).slice(0, 260)}\n` +
        `现有摘要: ${cleanText(item.summary).slice(0, 900) || "无摘要"}\n` +
        `现有来源: ${item.url}`,
    )
    .join("\n\n");

  return `你是 Signal Radar 的研究编辑。使用 live web search 为以下候选补齐写出完整稿件所需的关键事实和比较基准。

逐条执行：
- 根据事件类型使用 research matrix，识别现有摘要缺少的 material facts。
- 财报主动搜索 reported actuals、同比变化、关键 KPI、current/prior guidance，以及可公开核验、明确注明 provider 的 analyst consensus。
- Fed、监管、产品、security、M&A 和 research 事件主动补齐对应的一手文件、此前状态和必要的独立验证。
- 优先返回 company IR、filing、regulator、official release、paper、repository；独立媒体只用于 consensus、市场反应或一手文件没有覆盖的背景。
- 搜索结果 snippet 不能直接作为 source。URL 必须是 canonical 原文。
- 不要重复输入中已经提供的 URL。
- 找不到可靠补充来源时返回 no_additional_sources，不得编造。
- 每个 ref 必须且只能返回一次，最多返回 4 个新增来源。

只返回合法 JSON：
{
  "results": [
    {
      "ref": "N1",
      "status": "researched|no_additional_sources|conflicted",
      "centralClaim": "证据支持的核心变化",
      "comparisons": "actual、prior、guidance、consensus 或 benchmark 的可比关系",
      "unresolved": "仍未解决但会影响判断的问题；无则空字符串",
      "sources": [
        {
          "title": "原文标题",
          "url": "https://...",
          "publisher": "发布机构",
          "publishedAt": "ISO 8601 或 null",
          "sourceKind": "Official|IR|Regulator|SEC|Research|Repository|Media",
          "role": "Primary|Consensus|Comparison|Context|Counterevidence",
          "summary": "这条来源补齐了哪个具体事实、数字或比较"
        }
      ]
    }
  ]
}

候选：
${items}`;
}

export function hydrateEditorialResearchCandidates({
  raw,
  researchItems,
  generatedAt,
}) {
  const itemMap = new Map(researchItems.map((item) => [item.ref, item]));
  const allowedKinds = new Set([
    "Official",
    "IR",
    "Regulator",
    "SEC",
    "Research",
    "Repository",
    "Media",
  ]);
  const seenUrls = new Set(researchItems.map((item) => item.url));
  const candidates = [];

  for (const result of raw?.results ?? []) {
    const parent = itemMap.get(result?.ref);
    if (!parent || result?.status === "no_additional_sources") continue;
    for (const source of (result.sources ?? []).slice(0, 4)) {
      const url = safeGroundingUrl(source?.url);
      const title = cleanText(source?.title).slice(0, 260);
      const publisher = cleanText(source?.publisher).slice(0, 120);
      const summary = cleanText(source?.summary).slice(0, 1_200);
      if (!url || !title || !publisher || !summary || seenUrls.has(url)) {
        continue;
      }
      seenUrls.add(url);
      candidates.push({
        id: `research-${parent.id ?? parent.ref}-${candidates.length + 1}-${url}`,
        sourceId: parent.sourceId,
        sourceName: publisher,
        sourcePublisher: publisher,
        sourceKind: allowedKinds.has(source?.sourceKind)
          ? source.sourceKind
          : "Media",
        title,
        url,
        publishedAt: normalizeGroundingDate(
          source.publishedAt,
          parent.publishedAt ?? generatedAt,
        ),
        summary,
        fetchedAt: generatedAt,
        researchedFrom: parent.ref,
        researchRole: cleanText(source.role).slice(0, 80),
        researchClaim: cleanText(result.centralClaim).slice(0, 700),
        researchComparisons: cleanText(result.comparisons).slice(0, 900),
        researchUnresolved: cleanText(result.unresolved).slice(0, 700),
      });
    }
  }
  return candidates.map((item, index) => ({
    ...item,
    ref: `R${index + 1}`,
  }));
}

async function loadSubscriptionAuth() {
  const auth = JSON.parse(await readFile(authPath, "utf8"));
  const tokens = auth.tokens ?? {};
  if (!tokens.access_token || !tokens.account_id) {
    throw new Error("ChatGPT subscription auth missing access_token/account_id");
  }
  return {
    accessToken: tokens.access_token,
    accountId: tokens.account_id,
  };
}

async function callSubscriptionModel({
  model,
  prompt,
  accessToken,
  accountId,
  instructions = "Classify every new source item exactly once. Publish only qualified dynamic events or substantive explore theses; archive weak items. Return only valid JSON.",
  tools,
  toolChoice,
  reasoningEffort = "medium",
  timeoutMs = 240_000,
}) {
  const requestBody = {
    model,
    instructions,
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: prompt }],
      },
    ],
    reasoning: { effort: reasoningEffort },
    stream: true,
    store: false,
  };
  if (tools?.length) requestBody.tools = tools;
  if (toolChoice) requestBody.tool_choice = toolChoice;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "chatgpt-account-id": accountId,
      "content-type": "application/json",
      accept: "text/event-stream",
      "openai-beta": "responses=v1",
    },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(
      `Subscription HTTP ${response.status}: ${(await response.text()).slice(0, 800)}`,
    );
  }

  let buffer = "";
  let output = "";
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6);
      if (!data || data === "[DONE]") continue;
      const event = JSON.parse(data);
      if (event.type === "response.output_text.delta") {
        output += event.delta ?? "";
      } else if (event.type === "response.failed") {
        throw new Error(`response.failed: ${JSON.stringify(event).slice(0, 800)}`);
      }
    }
  }
  return output.trim();
}

function isTimeoutError(error) {
  return (
    error?.name === "TimeoutError" ||
    error?.name === "AbortError" ||
    /timed?\s*out|timeout/iu.test(String(error?.message ?? error))
  );
}

function parseJsonOutput(text) {
  const unfenced = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Model returned no JSON object");
  return JSON.parse(unfenced.slice(start, end + 1));
}

async function groundDiscoveryCandidates({
  candidates,
  auth,
  generatedAt,
}) {
  const discoveryItems = candidates
    .filter((item) => item.discoveryOnly)
    .slice(0, maxGroundingItemsPerRun);
  if (!discoveryItems.length) {
    return { candidates: [], model: null, attempted: 0 };
  }

  const skillInstructions = await loadGroundingSkill();
  const prompt = buildGroundingPrompt(discoveryItems);
  let lastError;
  for (const model of preferredGroundingModels) {
    try {
      const output = await callSubscriptionModel({
        model,
        prompt,
        ...auth,
        instructions:
          `${skillInstructions}\n\nUse live web search for every supplied ref and return only the requested JSON.`,
        tools: [
          {
            type: "web_search",
            search_context_size: "medium",
            external_web_access: true,
          },
        ],
        toolChoice: "required",
        reasoningEffort: "medium",
      });
      const raw = parseJsonOutput(output);
      return {
        candidates: hydrateGroundingCandidates({
          raw,
          discoveryItems,
          generatedAt,
        }),
        model,
        attempted: discoveryItems.length,
      };
    } catch (error) {
      lastError = error;
      console.warn(
        `${model} discovery grounding failed: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  }
  console.warn(
    `Discovery grounding unavailable; anonymous leads will be archived: ${
      lastError instanceof Error ? lastError.message : lastError
    }`,
  );
  return { candidates: [], model: null, attempted: discoveryItems.length };
}

async function researchEditorialCandidates({
  candidates,
  auth,
  generatedAt,
  skillInstructions,
}) {
  const researchItems = selectEditorialResearchItems(candidates);
  if (!researchItems.length) {
    return { candidates: [], model: null, attempted: 0 };
  }

  const chunks = [];
  for (
    let index = 0;
    index < researchItems.length;
    index += editorialResearchChunkSize
  ) {
    chunks.push(researchItems.slice(index, index + editorialResearchChunkSize));
  }

  const results = new Array(chunks.length);
  let nextChunkIndex = 0;
  async function researchNextChunk() {
    while (nextChunkIndex < chunks.length) {
      const chunkIndex = nextChunkIndex;
      nextChunkIndex += 1;
      const chunk = chunks[chunkIndex];
      const prompt = buildEditorialResearchPrompt(chunk);
      let lastError;

      for (const model of preferredGroundingModels) {
        try {
          const output = await callSubscriptionModel({
            model,
            prompt,
            ...auth,
            instructions:
              `${skillInstructions}\n\nResearch every supplied ref with live web search. Return only the requested JSON.`,
            tools: [
              {
                type: "web_search",
                search_context_size: "medium",
                external_web_access: true,
              },
            ],
            toolChoice: "required",
            reasoningEffort: "high",
            timeoutMs: editorialResearchTimeoutMs,
          });
          const raw = parseJsonOutput(output);
          results[chunkIndex] = {
            candidates: hydrateEditorialResearchCandidates({
              raw,
              researchItems: chunk,
              generatedAt,
            }),
            model,
          };
          break;
        } catch (error) {
          lastError = error;
          console.warn(
            `${model} editorial research chunk ${chunkIndex + 1}/${chunks.length} failed: ${
              error instanceof Error ? error.message : error
            }`,
          );
          if (isTimeoutError(error)) break;
        }
      }

      if (!results[chunkIndex]) {
        console.warn(
          `Editorial research chunk ${chunkIndex + 1}/${chunks.length} unavailable; its ${chunk.length} item(s) will use fetched evidence only: ${
            lastError instanceof Error ? lastError.message : lastError
          }`,
        );
        results[chunkIndex] = { candidates: [], model: null };
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(editorialResearchConcurrency, chunks.length) },
      () => researchNextChunk(),
    ),
  );

  const models = [
    ...new Set(results.map((result) => result.model).filter(Boolean)),
  ];
  return {
    candidates: results.flatMap((result) => result.candidates),
    model: models.length ? models.join(", ") : null,
    attempted: researchItems.length,
  };
}

export function validateFeedCoverage(raw, candidates) {
  const expected = new Set(candidates.map((item) => item.ref));
  const itemMap = new Map(candidates.map((item) => [item.ref, item]));
  const covered = new Map();
  const claim = (ref, disposition) => {
    if (!expected.has(ref)) {
      throw new Error(`Model returned unknown source ref ${ref}`);
    }
    if (covered.has(ref)) {
      throw new Error(`Source ref ${ref} was assigned more than once`);
    }
    if (
      ["story", "update"].includes(disposition) &&
      itemMap.get(ref)?.discoveryOnly
    ) {
      throw new Error(
        `Anonymous discovery ref ${ref} cannot be used as public evidence`,
      );
    }
    covered.set(ref, disposition);
  };

  for (const story of raw?.feedStories ?? []) {
    for (const evidence of story?.signal?.evidence ?? []) {
      claim(evidence?.ref, "story");
    }
  }
  for (const update of raw?.existingUpdates ?? []) {
    for (const evidence of update?.update?.evidence ?? []) {
      claim(evidence?.ref, "update");
    }
  }
  for (const ignored of raw?.ignored ?? []) {
    const reason = cleanText(ignored?.reason);
    if (!reason) throw new Error(`Ignored ref ${ignored?.ref} has no reason`);
    claim(ignored?.ref, "ignored");
  }

  const missing = [...expected].filter((ref) => !covered.has(ref));
  if (missing.length) {
    throw new Error(`Model did not account for source refs: ${missing.join(", ")}`);
  }
  return {
    storyItemCount: [...covered.values()].filter((value) => value === "story")
      .length,
    updateItemCount: [...covered.values()].filter((value) => value === "update")
      .length,
    ignoredItemCount: [...covered.values()].filter(
      (value) => value === "ignored",
    ).length,
  };
}

export function assertEditorialArticleQuality(article, label) {
  const text = [
    article?.lead,
    ...(article?.sections ?? []).flatMap((section) => [
      section?.heading,
      section?.body,
    ]),
    article?.outlook,
  ]
    .map((value) => cleanText(value))
    .join(" ");
  const processNarrationPatterns = [
    /由于.{0,45}(?:没有|未).{0,45}(?:不作|无法|不能).{0,24}(?:判断|结论|beat|miss)/iu,
    /尚待.{0,30}(?:验证|确认)/u,
    /单一来源假设/u,
    /single-source hypothesis/iu,
    /without.{0,40}consensus.{0,40}(?:cannot|can't|do not|won't)/iu,
  ];
  if (processNarrationPatterns.some((pattern) => pattern.test(text))) {
    throw new Error(`${label} article narrates a research limitation`);
  }
}

function hydrateArticle(article, label) {
  if (
    !article ||
    !cleanText(article.lead) ||
    !Array.isArray(article.sections) ||
    article.sections.length !== 3 ||
    !cleanText(article.outlook)
  ) {
    throw new Error(`${label} article is incomplete`);
  }
  const hydrated = {
    lead: cleanText(article.lead).slice(0, 600),
    sections: article.sections.map((section, index) => {
      const heading = cleanText(section?.heading).slice(0, 100);
      const body = cleanText(section?.body).slice(0, 1_000);
      if (!heading || !body) {
        throw new Error(`${label} article section ${index + 1} is incomplete`);
      }
      return { heading, body };
    }),
    outlook: cleanText(article.outlook).slice(0, 600),
  };
  assertEditorialArticleQuality(hydrated, label);
  return hydrated;
}

function assertNoPrivateDiscoveryLeak(value, label) {
  const serialized = JSON.stringify(value);
  if (
    /财联社|实时财经发现源|(?:api3|m)\.cls\.cn|cailianpress\.com/iu.test(
      serialized,
    )
  ) {
    throw new Error(`${label} exposes a private discovery source`);
  }
}

function formatAge(publishedAt, generatedAt) {
  if (!publishedAt) return "时间未知";
  const hours = Math.max(
    0,
    Math.round(
      (Date.parse(generatedAt) - Date.parse(publishedAt)) / 3_600_000,
    ),
  );
  if (hours < 1) return "刚刚";
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

function evidenceMetadata(evidence) {
  const sources = [...new Set(evidence.map((item) => item.sourceKind))];
  const sourceNames = [
    ...new Set(
      evidence.map((item) => item.sourcePublisher ?? item.sourceName),
    ),
  ];
  return {
    sources,
    sourceNames,
    sourceCount: sourceNames.length,
    validationType:
      sourceNames.length === 1
        ? "单一来源"
        : sources.length > 1
          ? "跨平台验证"
          : "多账号验证",
  };
}

const directRadarScopePattern =
  /人工智能|大模型|基础模型|智能体|算力|芯片|半导体|数据中心|云计算|机器人|自动驾驶|网络安全|漏洞|量子计算|核聚变|开发者工具|开源模型|美联储|货币政策|利率|通胀|\b(?:ai|llm|agent|inference|training|gpu|tpu|semiconductor|chip|foundry|data center|cloud computing|robotics?|autonomous driving|cybersecurity|vulnerability|quantum computing|fusion|developer tools?|open source model|federal reserve|fomc|monetary policy|interest rates?)\b|\b(?:openai|anthropic|nvidia|microsoft|google|alphabet|amazon|apple|meta|tesla|amd|broadcom|oracle|palantir|tsmc|samsung|asml|cloudflare|github|hugging face|deepmind|xai|mistral|moonshot|kimi|spacex)\b/iu;

export function hasDirectRadarScope(evidence) {
  return evidence.some((item) =>
    directRadarScopePattern.test(
      [
        item.sourceName,
        item.sourcePublisher,
        item.title,
        item.summary,
        item.groundingClaim,
        item.researchClaim,
      ]
        .map((value) => cleanText(value))
        .join(" "),
    ),
  );
}

export function hasFreshDynamicEvidence(
  evidence,
  generatedAt,
  maxAgeMs = 7 * 24 * 60 * 60 * 1_000,
) {
  const generatedTime = Date.parse(generatedAt ?? "");
  if (!Number.isFinite(generatedTime)) return false;
  const newestEvidenceTime = Math.max(
    ...evidence
      .map((item) => Date.parse(item.publishedAt ?? ""))
      .filter(Number.isFinite),
  );
  return (
    Number.isFinite(newestEvidenceTime) &&
    newestEvidenceTime <= generatedTime + 24 * 60 * 60 * 1_000 &&
    newestEvidenceTime >= generatedTime - maxAgeMs
  );
}

export function qualifiesDynamicMateriality(event) {
  const valueScore =
    Number(event?.valueScore) || Number(event?.signal?.score) || 0;
  const materiality = cleanText(event?.materiality).toLowerCase();
  if (valueScore < 82) return false;
  if (materiality === "minor") return false;
  return true;
}

export function qualifiesExploreMateriality(event) {
  const valueScore =
    Number(event?.valueScore) || Number(event?.signal?.score) || 0;
  const materiality = cleanText(event?.materiality).toLowerCase();
  const changedVariable = cleanText(event?.changedVariable);
  if (valueScore < exploreEditorialFloor) return false;
  if (!["substantive", "material"].includes(materiality)) return false;
  if (changedVariable.length < 8) return false;
  return true;
}

export function applyEditorialPublicationBar(raw) {
  const feedStories = [];
  const autoIgnored = [];

  for (const event of raw?.feedStories ?? []) {
    const qualifiesAsDynamic =
      event?.bucket === "dynamic" && qualifiesDynamicMateriality(event);
    const qualifiesAsExplore = qualifiesExploreMateriality(event);
    if (qualifiesAsDynamic || qualifiesAsExplore) {
      feedStories.push(event);
      continue;
    }
    for (const evidence of event?.signal?.evidence ?? []) {
      if (!evidence?.ref) continue;
      autoIgnored.push({
        ref: evidence.ref,
        reason: "归档：未达到 Explore 编辑门槛",
      });
    }
  }

  return {
    ...raw,
    feedStories,
    ignored: [...(raw?.ignored ?? []), ...autoIgnored],
  };
}

export function hydrateFeedStories({
  raw,
  candidates,
  radar,
  generatedAt,
}) {
  const events = Array.isArray(raw?.feedStories)
    ? [...raw.feedStories]
        .sort(
          (left, right) =>
            (Number(right?.valueScore) ||
              Number(right?.signal?.score) ||
              0) -
            (Number(left?.valueScore) ||
              Number(left?.signal?.score) ||
              0),
        )
        .slice(0, maxFeedStoriesPerRun)
    : [];
  const itemMap = new Map(candidates.map((item) => [item.ref, item]));
  const existingTitles = new Set(
    radar.signals.map((signal) => normalizeTitle(signal.title)),
  );
  const existingEvidenceTitles = new Map(
    radar.signals.flatMap((signal) =>
      (signal.evidence ?? [])
        .map((evidence) => normalizeTitle(evidence.title))
        .filter(Boolean)
        .map((title) => [title, signal.id]),
    ),
  );
  const nextId = Math.max(
    0,
    ...radar.signals.map((signal) => Number(signal.id) || 0),
  );
  const tones = ["orange", "blue", "green"];
  const hydrated = [];

  for (const event of events) {
    if (!["dynamic", "explore"].includes(event?.bucket)) {
      throw new Error(
        `feedStory ${event?.signal?.title ?? "untitled"} has invalid editorial bucket`,
      );
    }
    assertNoPrivateDiscoveryLeak(event, "feedStory");
    const qualifiesAsDynamic =
      event.bucket === "dynamic" && qualifiesDynamicMateriality(event);
    if (!qualifiesAsDynamic && !qualifiesExploreMateriality(event)) {
      continue;
    }
    const titleKey = normalizeTitle(event.signal?.title);
    if (!titleKey || existingTitles.has(titleKey)) continue;

    const evidence = [];
    const seenUrls = new Set();
    for (const entry of event.signal?.evidence ?? []) {
      const item = itemMap.get(entry?.ref);
      if (!item || item.discoveryOnly || seenUrls.has(item.url)) continue;
      seenUrls.add(item.url);
      evidence.push({
        ...item,
        role: ["主张", "佐证", "背景", "反例"].includes(entry.role)
          ? entry.role
          : "佐证",
        takeaway: cleanText(entry.takeaway).slice(0, 120),
      });
      if (evidence.length === 8) break;
    }
    if (!evidence.length) continue;
    const duplicateEvidence = evidence.find((item) =>
      existingEvidenceTitles.has(normalizeTitle(item.title)),
    );
    if (duplicateEvidence) {
      throw new Error(
        `feedStory ${event.signal.title} repeats evidence already attached to signal ${existingEvidenceTitles.get(
          normalizeTitle(duplicateEvidence.title),
        )}; return it as an existingUpdate instead`,
      );
    }
    if (
      event.bucket === "dynamic" &&
      (!hasDirectRadarScope(evidence) ||
        !hasFreshDynamicEvidence(evidence, generatedAt))
    ) {
      continue;
    }
    const editorialBucket = qualifiesAsDynamic ? "dynamic" : "explore";

    const metadata = evidenceMetadata(evidence);
    const newest = evidence
      .map((item) => item.publishedAt)
      .filter(Boolean)
      .sort()
      .at(-1);
    const id = nextId + hydrated.length + 1;
    const signal = {
      id,
      editorialBucket,
      category: cleanText(event.signal.category),
      eyebrow: cleanText(event.signal.eyebrow),
      title: cleanText(event.signal.title).slice(0, 100),
      summary: cleanText(event.signal.summary).slice(0, 500),
      why: cleanText(event.signal.why).slice(0, 500),
      impact: cleanText(event.signal.impact).slice(0, 500),
      shiftFrom: cleanText(event.signal.shiftFrom).slice(0, 160),
      shiftTo: cleanText(event.signal.shiftTo).slice(0, 160),
      crossValidation: cleanText(event.signal.crossValidation).slice(0, 600),
      article: hydrateArticle(event.signal.article, `signal ${id}`),
      validationType: metadata.validationType,
      publishedAt: newest ?? generatedAt,
      updatedAt: newest ?? generatedAt,
      sources: metadata.sources,
      sourceNames: metadata.sourceNames,
      sourceCount: metadata.sourceCount,
      age: formatAge(newest, generatedAt),
      score: Math.max(
        0,
        Math.min(
          99,
          Number(event.valueScore) || Number(event.signal.score) || 50,
        ),
      ),
      tone: tones[(id - 1) % tones.length],
      evidence,
      references: evidence.map(
        ({ role: _role, takeaway: _takeaway, ...reference }) => reference,
      ),
    };

    const zhTranslation = {
      category: signal.category,
      eyebrow: signal.eyebrow,
      title: signal.title,
      summary: signal.summary,
      why: signal.why,
      impact: signal.impact,
      shiftFrom: signal.shiftFrom,
      shiftTo: signal.shiftTo,
      crossValidation: signal.crossValidation,
      article: signal.article,
      evidence: evidence.map(({ role, takeaway }) => ({ role, takeaway })),
    };
    const translation = event.translation ?? {};
    const enTranslation = {
      category: cleanText(translation.category),
      eyebrow: cleanText(translation.eyebrow),
      title: cleanText(translation.title),
      summary: cleanText(translation.summary),
      why: cleanText(translation.why),
      impact: cleanText(translation.impact),
      shiftFrom: cleanText(translation.shiftFrom),
      shiftTo: cleanText(translation.shiftTo),
      crossValidation: cleanText(translation.crossValidation),
      article: hydrateArticle(translation.article, `translation ${id}`),
      evidence: evidence.map((_, evidenceIndex) => ({
        role:
          cleanText(translation.evidence?.[evidenceIndex]?.role) || "Support",
        takeaway: cleanText(
          translation.evidence?.[evidenceIndex]?.takeaway,
        ).slice(0, 160),
      })),
    };
    if (
      !enTranslation.title ||
      !enTranslation.summary ||
      !enTranslation.why ||
      !enTranslation.impact
    ) {
      throw new Error(`translation ${id} is incomplete`);
    }

    hydrated.push({ signal, zhTranslation, enTranslation });
    existingTitles.add(titleKey);
  }
  return hydrated;
}

export function hydrateExistingUpdates({
  raw,
  candidates,
  radar,
  generatedAt,
}) {
  const updates = Array.isArray(raw?.existingUpdates)
    ? raw.existingUpdates.slice(0, maxFeedStoriesPerRun)
    : [];
  const itemMap = new Map(candidates.map((item) => [item.ref, item]));
  const signalIds = new Set(radar.signals.map((signal) => String(signal.id)));
  const hydrated = [];

  for (const entry of updates) {
    assertNoPrivateDiscoveryLeak(entry, "existingUpdate");
    const existingSignalId = String(entry?.existingSignalId ?? "");
    if (!signalIds.has(existingSignalId)) {
      throw new Error(
        `Model referenced unknown existing signal ${existingSignalId}`,
      );
    }

    const evidence = [];
    const seenUrls = new Set();
    for (const evidenceEntry of entry?.update?.evidence ?? []) {
      const item = itemMap.get(evidenceEntry?.ref);
      if (!item || item.discoveryOnly || seenUrls.has(item.url)) continue;
      seenUrls.add(item.url);
      evidence.push({
        ...item,
        role: ["佐证", "最新进展", "背景", "反例"].includes(evidenceEntry.role)
          ? evidenceEntry.role
          : "最新进展",
        takeaway: cleanText(evidenceEntry.takeaway).slice(0, 160),
      });
      if (evidence.length === 8) break;
    }
    if (!evidence.length) continue;

    const newest =
      evidence
        .map((item) => item.publishedAt)
        .filter(Boolean)
        .sort()
        .at(-1) ?? generatedAt;
    const title = cleanText(entry.update?.title).slice(0, 100);
    const summary = cleanText(entry.update?.summary).slice(0, 600);
    const translation = entry.translation ?? {};
    const englishTitle = cleanText(translation.title).slice(0, 140);
    const englishSummary = cleanText(translation.summary).slice(0, 800);
    if (!title || !summary || !englishTitle || !englishSummary) {
      throw new Error(
        `Update for signal ${existingSignalId} is missing localized copy`,
      );
    }

    const zhEvidence = evidence.map(({ role, takeaway }) => ({
      role,
      takeaway,
    }));
    const enEvidence = evidence.map((_, evidenceIndex) => ({
      role:
        cleanText(translation.evidence?.[evidenceIndex]?.role) || "Update",
      takeaway: cleanText(
        translation.evidence?.[evidenceIndex]?.takeaway,
      ).slice(0, 200),
    }));
    hydrated.push({
      existingSignalId,
      valueScore: Math.max(
        0,
        Math.min(99, Number(entry.valueScore) || 50),
      ),
      update: {
        addedAt: newest,
        title,
        summary,
        evidence,
      },
      zhUpdate: {
        addedAt: newest,
        title,
        summary,
        evidence: zhEvidence,
      },
      enUpdate: {
        addedAt: newest,
        title: englishTitle,
        summary: englishSummary,
        evidence: enEvidence,
      },
    });
  }
  return hydrated;
}

export function mergeFeedStories({
  radar,
  hydratedStories,
  hydratedUpdates = [],
  scannedSnapshot,
}) {
  if (!hydratedStories.length && !hydratedUpdates.length) return radar;
  const addedAt = new Date().toISOString();
  const signals = hydratedStories.map((event) => ({
    ...event.signal,
    feedBatchAt: scannedSnapshot.generatedAt,
  }));
  const zhSignals = hydratedStories.map((event) => event.zhTranslation);
  const enSignals = hydratedStories.map((event) => event.enTranslation);
  const existingSignals = radar.signals.map((signal) => ({ ...signal }));
  const existingZhSignals = radar.translations.zh.signals.map((signal) => ({
    ...signal,
  }));
  const existingEnSignals = radar.translations.en.signals.map((signal) => ({
    ...signal,
  }));
  const updatedIds = new Set();

  for (const hydrated of hydratedUpdates) {
    const signalIndex = existingSignals.findIndex(
      (signal) => String(signal.id) === hydrated.existingSignalId,
    );
    if (signalIndex < 0) {
      throw new Error(
        `Cannot merge update for missing signal ${hydrated.existingSignalId}`,
      );
    }
    const previous = existingSignals[signalIndex];
    const previousEvidence = previous.evidence ?? [];
    const knownUrls = new Set(previousEvidence.map((item) => item.url));
    const newEvidenceIndexes = hydrated.update.evidence
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => !knownUrls.has(item.url));
    const newEvidence = newEvidenceIndexes.map(({ item }) => item);
    const mergedEvidence = [...previousEvidence, ...newEvidence];
    const metadata = evidenceMetadata(mergedEvidence);
    existingSignals[signalIndex] = {
      ...previous,
      ...metadata,
      evidence: mergedEvidence,
      references: mergedEvidence.map(
        ({ role: _role, takeaway: _takeaway, ...reference }) => reference,
      ),
      updatedAt: hydrated.update.addedAt,
      feedBatchAt: scannedSnapshot.generatedAt,
      score: Math.max(Number(previous.score) || 0, hydrated.valueScore),
      updates: [hydrated.update, ...(previous.updates ?? [])],
    };

    const previousZh = existingZhSignals[signalIndex] ?? {};
    existingZhSignals[signalIndex] = {
      ...previousZh,
      evidence: [
        ...(previousZh.evidence ?? []),
        ...newEvidenceIndexes.map(
          ({ index }) => hydrated.zhUpdate.evidence[index],
        ),
      ],
      updates: [hydrated.zhUpdate, ...(previousZh.updates ?? [])],
    };
    const previousEn = existingEnSignals[signalIndex] ?? {};
    existingEnSignals[signalIndex] = {
      ...previousEn,
      evidence: [
        ...(previousEn.evidence ?? []),
        ...newEvidenceIndexes.map(
          ({ index }) => hydrated.enUpdate.evidence[index],
        ),
      ],
      updates: [hydrated.enUpdate, ...(previousEn.updates ?? [])],
    };
    updatedIds.add(hydrated.existingSignalId);
  }

  const updatedIndexes = existingSignals
    .map((signal, index) => ({ signal, index }))
    .filter(({ signal }) => updatedIds.has(String(signal.id)))
    .sort(
      (left, right) =>
        Date.parse(right.signal.updatedAt ?? "") -
        Date.parse(left.signal.updatedAt ?? ""),
    )
    .map(({ index }) => index);
  const untouchedIndexes = existingSignals
    .map((_, index) => index)
    .filter((index) => !updatedIndexes.includes(index));
  const orderedIndexes = [...updatedIndexes, ...untouchedIndexes];
  return {
    ...radar,
    generatedAt: addedAt,
    basedOnSnapshotAt: scannedSnapshot.generatedAt,
    totalFetchedItemCount: scannedSnapshot.items.length,
    signals: [
      ...signals,
      ...orderedIndexes.map((index) => existingSignals[index]),
    ],
    translations: {
      ...radar.translations,
      zh: {
        ...radar.translations.zh,
        signals: [
          ...zhSignals,
          ...orderedIndexes.map((index) => existingZhSignals[index]),
        ],
      },
      en: {
        ...radar.translations.en,
        signals: [
          ...enSignals,
          ...orderedIndexes.map((index) => existingEnSignals[index]),
        ],
      },
    },
    incremental: {
      lastAddedAt: addedAt,
      lastScanAt: scannedSnapshot.generatedAt,
      lastAddedCount: hydratedStories.length,
      lastUpdatedCount: hydratedUpdates.length,
      totalAppended:
        Number(radar.incremental?.totalAppended ?? 0) + hydratedStories.length,
      totalUpdated:
        Number(radar.incremental?.totalUpdated ?? 0) + hydratedUpdates.length,
    },
  };
}

export function createBaselineState(scannedSnapshot) {
  const processedItems = scannedSnapshot.items.filter((item) => item.url);
  return {
    lastScanAt: scannedSnapshot.generatedAt,
    windowStartAt: scannedSnapshot.generatedAt,
    initializedSourceIds: scannedSnapshot.statuses
      .filter((status) => status.status === "ok")
      .map((status) => String(status.sourceId)),
    processedUrls: [
      ...new Set(processedItems.map((item) => item.url)),
    ].slice(-20_000),
    processedKeys: [
      ...new Set(processedItems.map(itemProcessingKey)),
    ].slice(-20_000),
  };
}

export function nextState({
  state,
  previousSnapshot,
  candidates,
  scannedSnapshot,
}) {
  const initializedSourceIds = new Set(
    state?.initializedSourceIds?.length
      ? state.initializedSourceIds.map(String)
      : previousSnapshot.items.map((item) => String(item.sourceId)),
  );
  const successfulSourceIds = new Set(
    scannedSnapshot.statuses
      .filter((status) => status.status === "ok")
      .map((status) => String(status.sourceId)),
  );
  const newlyInitializedSourceIds = new Set(
    [...successfulSourceIds].filter(
      (sourceId) => !initializedSourceIds.has(sourceId),
    ),
  );
  const windowStartAt =
    state?.windowStartAt ??
    state?.lastScanAt ??
    previousSnapshot.generatedAt ??
    scannedSnapshot.generatedAt;
  const windowStart = Date.parse(windowStartAt);
  const urls = new Set([
    ...(state?.processedUrls ?? previousSnapshot.items.map((item) => item.url)),
    ...candidates.map((item) => item.url),
    ...scannedSnapshot.items
      .filter((item) => {
        if (!newlyInitializedSourceIds.has(String(item.sourceId))) {
          return false;
        }
        const publishedAt = Date.parse(item.publishedAt ?? "");
        return !Number.isFinite(publishedAt) || publishedAt < windowStart;
      })
      .map((item) => item.url),
  ]);
  const keys = new Set([
    ...(state?.processedKeys ??
      state?.processedUrls ??
      previousSnapshot.items.map(itemProcessingKey)),
    ...candidates.map(itemProcessingKey),
    ...scannedSnapshot.items
      .filter((item) => {
        if (!newlyInitializedSourceIds.has(String(item.sourceId))) {
          return false;
        }
        const publishedAt = Date.parse(item.publishedAt ?? "");
        return !Number.isFinite(publishedAt) || publishedAt < windowStart;
      })
      .map(itemProcessingKey),
  ]);
  const allInitializedSourceIds = new Set([
    ...initializedSourceIds,
    ...successfulSourceIds,
  ]);
  const remainingEligibleItems = scannedSnapshot.items.filter((item) => {
    if (!item.url || keys.has(itemProcessingKey(item))) return false;
    if (!allInitializedSourceIds.has(String(item.sourceId))) return false;
    return itemTime(item, Date.parse(scannedSnapshot.generatedAt)) >=
      windowStart - overlapMs;
  });
  return {
    lastScanAt: scannedSnapshot.generatedAt,
    windowStartAt:
      remainingEligibleItems.length > 0
        ? windowStartAt
        : scannedSnapshot.generatedAt,
    initializedSourceIds: [...allInitializedSourceIds],
    processedUrls: [...urls].slice(-20_000),
    processedKeys: [...keys].slice(-20_000),
  };
}

export function assertSnapshotHealth(scannedSnapshot, previousSnapshot) {
  const currentSuccessful = Number(scannedSnapshot.successfulSources ?? 0);
  const previousSuccessful = Number(previousSnapshot.successfulSources ?? 0);
  const currentFailed = Number(scannedSnapshot.failedSources ?? 0);
  const expectedMinimum =
    previousSuccessful >= 20 ? Math.floor(previousSuccessful * 0.8) : 1;

  if (currentSuccessful < expectedMinimum) {
    throw new Error(
      `Source health degraded: ${currentSuccessful} connected; expected at least ${expectedMinimum} from previous baseline ${previousSuccessful}`,
    );
  }
  if (
    currentSuccessful + currentFailed >= 20 &&
    currentFailed / (currentSuccessful + currentFailed) > 0.2
  ) {
    throw new Error(
      `Source failure ratio too high: ${currentFailed} failed, ${currentSuccessful} connected`,
    );
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const markBaseline = process.argv.includes("--mark-baseline");
  const scannedPath = resolve(
    projectRoot,
    argumentValue("snapshot") ?? "tmp/feed-snapshot.json",
  );
  const [scannedText, previousText, radarText] = await Promise.all([
    readFile(scannedPath, "utf8"),
    readFile(canonicalSnapshotPath, "utf8"),
    readFile(radarPath, "utf8"),
  ]);
  const scannedSnapshot = JSON.parse(scannedText);
  const previousSnapshot = JSON.parse(previousText);
  const radar = JSON.parse(radarText);
  assertSnapshotHealth(scannedSnapshot, previousSnapshot);
  let state = null;
  try {
    state = JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    // The previous canonical snapshot becomes the initial processed baseline.
  }

  if (markBaseline) {
    const baseline = createBaselineState(scannedSnapshot);
    const result = {
      scannedAt: scannedSnapshot.generatedAt,
      baselineInitialized: true,
      baselineItemCount: baseline.processedUrls.length,
      initializedSourceCount: baseline.initializedSourceIds.length,
      successfulSources: scannedSnapshot.successfulSources,
      failedSources: scannedSnapshot.failedSources,
      needsAuthSources: scannedSnapshot.needsAuthSources,
      publishRequired: false,
    };
    await Promise.all([
      writeJson(statePath, baseline),
      writeFile(canonicalSnapshotPath, scannedText, "utf8"),
      writeJson(resultPath, result),
    ]);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const selectedCandidates = selectIncrementalItems({
    scannedSnapshot,
    previousSnapshot,
    state,
  });
  const baseResult = {
    scannedAt: scannedSnapshot.generatedAt,
    newItemCount: selectedCandidates.length,
    fetchedItemCount: scannedSnapshot.items.length,
    successfulSources: scannedSnapshot.successfulSources,
    failedSources: scannedSnapshot.failedSources,
    needsAuthSources: scannedSnapshot.needsAuthSources,
  };

  if (dryRun) {
    const result = {
      ...baseResult,
      feedStoryCount: 0,
      updatedStoryCount: 0,
      includedItemCount: 0,
      appendedEvidenceItemCount: 0,
      ignoredItemCount: 0,
      addedTitles: [],
      updatedTitles: [],
      publishRequired: false,
      dryRun: true,
      candidateTitles: selectedCandidates
        .slice(0, 20)
        .map((item) => item.title),
    };
    await writeJson(resultPath, result);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  let hydratedStories = [];
  let hydratedUpdates = [];
  let coverage = {
    storyItemCount: 0,
    updateItemCount: 0,
    ignoredItemCount: 0,
  };
  let model = null;
  let grounding = { candidates: [], model: null, attempted: 0 };
  let editorialResearch = { candidates: [], model: null, attempted: 0 };
  let candidates = selectedCandidates;
  let auth = null;
  if (selectedCandidates.length) {
    auth = await loadSubscriptionAuth();
    const editorialSkillInstructions = await loadEditorialSkill();
    grounding = await groundDiscoveryCandidates({
      candidates: selectedCandidates,
      auth,
      generatedAt: scannedSnapshot.generatedAt,
    });
    candidates = [...selectedCandidates, ...grounding.candidates];
    editorialResearch = await researchEditorialCandidates({
      candidates,
      auth,
      generatedAt: scannedSnapshot.generatedAt,
      skillInstructions: editorialSkillInstructions,
    });
    candidates = [...candidates, ...editorialResearch.candidates];
    const prompt = buildPrompt({ candidates, radar, scannedSnapshot });
    let lastError;
    for (const candidateModel of preferredModels) {
      try {
        const output = await callSubscriptionModel({
          model: candidateModel,
          prompt,
          ...auth,
          instructions:
            `${editorialSkillInstructions}\n\nClassify every new source item exactly once. Publish only qualified dynamic events or substantive Explore theses; archive weak items. Write a centered source-backed article and return only valid JSON.`,
          reasoningEffort: "high",
        });
        const raw = applyEditorialPublicationBar(parseJsonOutput(output));
        coverage = validateFeedCoverage(raw, candidates);
        hydratedStories = hydrateFeedStories({
          raw,
          candidates,
          radar,
          generatedAt: scannedSnapshot.generatedAt,
        });
        hydratedUpdates = hydrateExistingUpdates({
          raw,
          candidates,
          radar,
          generatedAt: scannedSnapshot.generatedAt,
        });
        model = candidateModel;
        break;
      } catch (error) {
        lastError = error;
        console.warn(
          `${candidateModel} incremental analysis failed: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }
    if (model === null) throw lastError ?? new Error("Incremental analysis failed");
  }

  await writeJson(
    statePath,
    nextState({
      state,
      previousSnapshot,
      candidates: selectedCandidates,
      scannedSnapshot,
    }),
  );

  if (hydratedStories.length || hydratedUpdates.length) {
    const mergedRadar = mergeFeedStories({
      radar,
      hydratedStories,
      hydratedUpdates,
      scannedSnapshot,
    });
    await Promise.all([
      writeJson(radarPath, mergedRadar),
      writeFile(canonicalSnapshotPath, scannedText, "utf8"),
    ]);
  }

  const result = {
    ...baseResult,
    model,
    groundingModel: grounding.model,
    groundingAttemptedCount: grounding.attempted,
    groundedEvidenceCount: grounding.candidates.length,
    editorialResearchModel: editorialResearch.model,
    editorialResearchAttemptedCount: editorialResearch.attempted,
    editorialResearchEvidenceCount: editorialResearch.candidates.length,
    feedStoryCount: hydratedStories.length,
    updatedStoryCount: hydratedUpdates.length,
    includedItemCount: coverage.storyItemCount,
    appendedEvidenceItemCount: coverage.updateItemCount,
    ignoredItemCount: coverage.ignoredItemCount,
    addedTitles: hydratedStories.map((event) => event.signal.title),
    updatedTitles: hydratedUpdates.map((event) => event.update.title),
    publishRequired:
      hydratedStories.length > 0 || hydratedUpdates.length > 0,
    dryRun: false,
  };
  await writeJson(resultPath, result);
  console.log(JSON.stringify(result, null, 2));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
