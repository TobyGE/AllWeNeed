import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const snapshotPath = resolve(projectRoot, "data/feed-snapshot.json");
const outputPath = resolve(projectRoot, "data/daily-radar.json");
const authPath = resolve(homedir(), ".codex/auth.json");
const endpoint = "https://chatgpt.com/backend-api/codex/responses";
const preferredModels = [
  process.env.SIGNAL_RADAR_MODEL?.trim(),
  "gpt-5.6-sol",
  "gpt-5.5",
].filter(Boolean);

function cleanText(value = "") {
  return value
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

function normalizeTitle(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function relevanceScore(item, snapshotTime) {
  const text = `${item.title} ${item.summary}`.toLowerCase();
  const highValueTerms = [
    "ai",
    "agent",
    "model",
    "llm",
    "openai",
    "anthropic",
    "claude",
    "gemini",
    "nvidia",
    "chip",
    "semiconductor",
    "robot",
    "funding",
    "acquisition",
    "startup",
    "venture",
    "investment",
    "earnings",
    "revenue",
    "net income",
    "cash flow",
    "guidance",
    "10-q",
    "10-k",
    "8-k",
    "6-k",
    "20-f",
    "federal reserve",
    "fomc",
    "monetary policy",
    "interest rate",
    "inflation",
    "employment",
    "security",
    "research",
    "launch",
    "release",
    "benchmark",
    "inference",
    "compute",
  ];
  const lowValueTerms = [
    "shorts",
    "civil war",
    "genocide",
    "movie",
    "celebrity",
    "football",
  ];
  const published = item.publishedAt ? Date.parse(item.publishedAt) : 0;
  const ageHours = published
    ? Math.max(0, (snapshotTime - published) / 3_600_000)
    : 24 * 30;
  const recency = Math.max(0, 120 - ageHours) / 12;
  const relevance =
    highValueTerms.reduce(
      (score, term) => score + (text.includes(term) ? 2 : 0),
      0,
    ) +
    lowValueTerms.reduce(
      (score, term) => score - (text.includes(term) ? 3 : 0),
      0,
    );
  return recency + relevance + (item.summary ? 1 : 0);
}

function selectItems(snapshot) {
  const snapshotTime = Date.parse(snapshot.generatedAt);
  const cutoff = snapshotTime - 7 * 24 * 3_600_000;
  const seenUrls = new Set();
  const seenTitles = new Set();

  const selected = snapshot.items
    .filter((item) => {
      const published = item.publishedAt ? Date.parse(item.publishedAt) : 0;
      return published >= cutoff;
    })
    .sort(
      (a, b) =>
        relevanceScore(b, snapshotTime) - relevanceScore(a, snapshotTime),
    )
    .filter((item) => {
      const titleKey = normalizeTitle(item.title);
      if (
        !titleKey ||
        seenUrls.has(item.url) ||
        seenTitles.has(titleKey)
      ) {
        return false;
      }
      seenUrls.add(item.url);
      seenTitles.add(titleKey);
      return true;
    })
    .slice(0, 180);

  return selected.map((item, index) => ({
    ref: `I${index + 1}`,
    sourceId: item.sourceId,
    sourceName: item.sourceName,
    sourcePublisher: item.sourcePublisher ?? item.sourceName,
    sourceKind: item.sourceKind,
    title: cleanText(item.title).slice(0, 220),
    summary: cleanText(item.summary).slice(0, 420),
    url: item.url,
    publishedAt: item.publishedAt,
  }));
}

function buildPrompt(snapshot, items) {
  const compactItems = items
    .map(
      (item) =>
        `${item.ref} | ${item.publishedAt ?? "unknown"} | ${item.sourceKind} | ${item.sourceName}\n` +
        `标题: ${item.title}\n摘要: ${item.summary || "无摘要"}`,
    )
    .join("\n\n");

  return `你是一个面向 AI、科技与投资研究者的高级情报编辑。

目标：把真实采集条目合并成今日事件簇，为每个结论写一篇可独立阅读的站内新闻稿，并给出账号级、可点击、可逐项核查的证据链。

成功标准：
- 聚合同一事件或趋势，明确写出“从什么状态 → 变成什么状态”。
- 至少 4 个事件簇由 2-4 个不同账号交叉验证；优先跨平台组合。
- 每条 evidence 只概括它对应的那一条原始内容，不得把其他来源的信息混入。
- crossValidation 解释多条证据如何共同支持结论，也要点明它们之间的差异。
- article 必须像一篇完整的编辑稿，而不是把 summary、why 和 impact 原样拼接。导语交代核心变化，三段正文依次讲清发生了什么、独立来源如何互相印证、为什么重要，outlook 给出可观察的下一步。
- article 中的事实只能来自该 signal 引用的 evidence。来源没有给出的数字、时间、因果关系或背景不得补写；编辑推断必须明确使用“可能”“意味着”“值得观察”等审慎措辞。
- “来源如何互相印证”必须具体写出不同来源各自提供了什么，不得只写“多个来源显示”。
- 如果只有一个账号支持，必须标为单一来源，不得写“交叉验证”，score 不得超过 74。
- 不要为了凑多来源把不同事件硬合并。账号数不足时宁可降低结论强度。
- 优先使用最近 72 小时的高影响信息，必要时用最近 7 天内容提供背景。
- 区分事实、跨来源共识和编辑推断；没有证据时不要补充细节。
- 所有标题、判断、数字和实体信号都必须能从所引用条目得到支持。
- Federal Reserve 与 SEC 属于一手官方来源。涉及利率、政策措辞和财务数字时优先使用这些来源，并明确区分公司披露、官方数据与外部解读。
- 输出简体中文，短句、高信息密度，适合直接展示在产品首页。

只返回一个合法 JSON 对象，不要 Markdown、代码围栏或额外说明。必须严格符合以下形状：
{
  "editorNote": "一句话概括今日信息环境",
  "signalQuality": 0到100的整数,
  "signalQualityChange": -20到20的整数,
  "signals": [
    {
      "category": "AI & 模型|Agents|算力|投资|科技|宏观",
      "eyebrow": "必须知道|趋势变化|资本信号|风险预警|产品信号",
      "title": "不超过28个汉字",
      "summary": "不超过90个汉字，只写已知事实与共识",
      "why": "不超过80个汉字",
      "impact": "不超过80个汉字，明确标注推断语气",
      "shiftFrom": "过去的状态，不超过24个汉字",
      "shiftTo": "现在的新状态，不超过24个汉字",
      "crossValidation": "这些独立账号如何共同支撑结论，不超过90个汉字",
      "article": {
        "lead": "80-150个汉字的导语，交代核心事实、变化与读者为什么应当关注",
        "sections": [
          {
            "heading": "具体、有信息量的小标题",
            "body": "120-220个汉字，说明发生了什么，只写证据支持的事实"
          },
          {
            "heading": "具体、有信息量的小标题",
            "body": "140-240个汉字，逐个说明不同来源提供了什么，以及它们如何互相印证或存在差异"
          },
          {
            "heading": "具体、有信息量的小标题",
            "body": "120-220个汉字，解释为什么重要，并把事实与编辑推断分开"
          }
        ],
        "outlook": "80-140个汉字，写接下来应观察的可验证变化与主要不确定性"
      },
      "evidence": [
        {
          "ref": "I1",
          "role": "主张|佐证|背景|反例",
          "takeaway": "只概括该条原始内容，不超过65个汉字"
        },
        {
          "ref": "I2",
          "role": "主张|佐证|背景|反例",
          "takeaway": "只概括该条原始内容，不超过65个汉字"
        }
      ],
      "score": 60到99的整数
    }
  ],
  "exploreSignals": [
    {
      "category": "AI工程|开发工具|机器人|安全|消费科技|商业模式|科学|社会影响|投资|宏观",
      "label": "反常识|二阶影响|早期拐点|跨界连接|高风险高潜",
      "title": "大胆、具体但不夸大的标题，不超过28个汉字",
      "thesis": "这个探索方向真正值得思考的核心判断，不超过95个汉字",
      "whyNow": "为什么是现在出现这个信号，不超过65个汉字",
      "counterpoint": "最强反方观点或不确定性，不超过60个汉字",
      "horizon": "现在|3-6个月|1-2年",
      "confidence": "低|中|中高",
      "evidence": [
        {
          "ref": "I1",
          "takeaway": "该原始内容支持这个大胆方向的哪一部分，不超过60个汉字"
        }
      ]
    }
  ],
  "trends": [
    {
      "name": "不超过10个汉字",
      "change": "+12%或-8%",
      "refs": ["I1", "I2"]
    }
  ],
  "discoveries": [
    {
      "name": "不超过12个汉字",
      "detail": "不超过35个汉字",
      "refs": ["I1"]
    }
  ],
  "investmentThesis": {
    "quote": "不超过55个汉字，使用推断语气",
    "confidence": "中|中高|高",
    "refs": ["I1", "I2"]
  },
  "companySignals": [
    {
      "entity": "明确的公司、产品或公司生态",
      "signalType": "产品采用|竞争格局|平台扩张|资本事件|商业模式|风险",
      "stance": "偏积极|观察|分化|风险",
      "headline": "一句话投资信号，不超过32个汉字",
      "whatChanged": "此前状态到当前状态的具体变化，不超过60个汉字",
      "investmentRead": "这对公司价值、护城河或行业利润池意味着什么，不超过80个汉字",
      "catalyst": "未来可能强化该判断的催化剂，不超过45个汉字",
      "risk": "最可能推翻该判断的风险，不超过45个汉字",
      "watchNext": "下一步最值得追踪的可观察指标，不超过45个汉字",
      "crossValidation": "逐项说明不同来源各自提供了什么，以及它们如何共同支持公司级判断",
      "article": {
        "lead": "80-150个汉字，明确事件、发生变化的业务变量和关键比较",
        "sections": [
          {
            "heading": "具体、有信息量的小标题",
            "body": "120-220个汉字，写清实际变化、此前状态与可比数据"
          },
          {
            "heading": "具体、有信息量的小标题",
            "body": "140-240个汉字，解释变化如何影响需求、定价、margin、资本强度、竞争位置、分发、监管暴露或管理层可信度"
          },
          {
            "heading": "具体、有信息量的小标题",
            "body": "120-220个汉字，给出最强反方解释及其会如何改变投资判断"
          }
        ],
        "outlook": "80-140个汉字，指出下一项可验证的 KPI、披露或事件"
      },
      "evidence": [
        {
          "ref": "I1",
          "takeaway": "该账号提供的公司级证据，不超过60个汉字"
        },
        {
          "ref": "I2",
          "takeaway": "另一独立账号提供的佐证或不同角度，不超过60个汉字"
        }
      ],
      "score": 60到99的整数
    }
  ]
}

数量规则：signals 动态输出 6-12 条，正常信息密度默认 8 条。只有在存在彼此独立、证据充分的额外事件簇时才增加到 9-12 条；如果不足以支撑 8 条，允许减少到 6-7 条，绝不为凑数加入弱信号。exploreSignals 恰好 8 条，trends 恰好 4 条，discoveries 恰好 3 条，companySignals 恰好 3 条。每个 signal 的 evidence 为 1-4 条；交叉验证时每条 evidence 必须来自不同 sourceName。至少三分之二的 signals 必须有 2 个或以上不同 sourceName。

exploreSignals 质量门槛：
- 它不是今日雷达的重复版。寻找非共识观点、二阶影响、跨领域连接和早期弱信号。
- 8 条至少覆盖 6 个不同 category，且至少 2 条标记为“高风险高潜”。
- 至少 5 条由两个或以上独立账号支撑，至少 2 条是跨平台组合。
- 允许最多 3 条只有一个来源，但必须标为“高风险高潜”或“早期拐点”，confidence 必须为“低”。
- 整组内容至少使用 7 个不同 sourceName；同一个账号不得主导整页。
- 不要反复讨论同一家公司或同一模型；同一实体最多出现 2 次。
- thesis 可以大胆，但必须与事实证据分开；counterpoint 必须真正有可能推翻该判断。
- 不得使用“将会”“必然”等确定语气描述尚未发生的未来。
- 每条 evidence 只概括对应原始内容，不得把编辑推断写成来源原话。

companySignals 质量门槛：
- 只选最有投资含义的 3 个公司级信号，不要为了数量选择弱信息。
- 每条必须由 2-4 个不同 sourceName 支撑；优先跨平台。
- 证据必须和 entity 直接相关，或明确说明该证据为何构成其竞争环境。
- 不要把单个静态比例写成“增长率”或“变化百分比”。
- whatChanged 必须描述真正的状态变化；investmentRead 必须是审慎推断，不得写成投资建议。
- catalyst、risk、watchNext 必须具体且可以在未来观察验证。
- article 必须是一篇有单一中心判断的完整公司稿，不得把 whatChanged、investmentRead、catalyst 和 risk 机械拼接。
- 文章必须围绕一个发生变化的业务变量：需求、定价、margin、资本强度、竞争位置、分发、监管暴露或管理层可信度。
- crossValidation 必须逐项说明每个来源的贡献；正文不得出现“尚待验证”“单一来源假设”或研究过程说明。
- 如果证据无法支持公司价值或行业利润池层面的变化，应缩小判断或改选另一家公司，不得靠宽泛推断凑成投资信号。
快照生成时间：${snapshot.generatedAt}
输入条目数：${items.length}

真实采集条目：
${compactItems}`;
}

async function loadSubscriptionAuth() {
  let auth;
  try {
    auth = JSON.parse(await readFile(authPath, "utf8"));
  } catch (error) {
    throw new Error(
      `无法读取 ${authPath}。请先通过 Codex 登录 ChatGPT subscription。`,
      { cause: error },
    );
  }
  const tokens = auth.tokens ?? {};
  if (!tokens.access_token || !tokens.account_id) {
    throw new Error(
      `${authPath} 缺少 access_token 或 account_id，请重新运行 codex login。`,
    );
  }
  return {
    accessToken: tokens.access_token,
    accountId: tokens.account_id,
  };
}

async function callSubscriptionModel({ model, prompt, accessToken, accountId }) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "chatgpt-account-id": accountId,
      "content-type": "application/json",
      accept: "text/event-stream",
      "openai-beta": "responses=v1",
    },
    body: JSON.stringify({
      model,
      instructions:
        "Follow the user's evidence rules precisely. Return only valid JSON with no markdown fences.",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: prompt }],
        },
      ],
      reasoning: { effort: "medium" },
      stream: true,
      store: false,
    }),
    signal: AbortSignal.timeout(240_000),
  });

  if (!response.ok) {
    const body = (await response.text()).slice(0, 800);
    throw new Error(`HTTP ${response.status}: ${body}`);
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

function parseJsonOutput(text) {
  const unfenced = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("模型没有返回 JSON 对象");
  }
  return JSON.parse(unfenced.slice(start, end + 1));
}

function requireArray(value, length, label) {
  if (!Array.isArray(value) || value.length !== length) {
    throw new Error(`${label} 必须恰好包含 ${length} 条`);
  }
}

function requireArrayRange(value, minLength, maxLength, label) {
  if (
    !Array.isArray(value) ||
    value.length < minLength ||
    value.length > maxLength
  ) {
    throw new Error(
      `${label} 必须包含 ${minLength}-${maxLength} 条，实际为 ${
        Array.isArray(value) ? value.length : 0
      } 条`,
    );
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

function hydrateRefs(refs, itemMap) {
  return [...new Set((refs ?? []).filter((ref) => itemMap.has(ref)))]
    .slice(0, 6)
    .map((ref) => itemMap.get(ref));
}

function hydrateEvidence(evidence, itemMap) {
  const seenRefs = new Set();
  const seenPublishers = new Set();
  const hydrated = [];
  for (const entry of Array.isArray(evidence) ? evidence : []) {
    const item = itemMap.get(entry?.ref);
    const publisher = item?.sourcePublisher ?? item?.sourceName;
    if (
      !item ||
      seenRefs.has(entry.ref) ||
      seenPublishers.has(publisher)
    ) {
      continue;
    }
    seenRefs.add(entry.ref);
    seenPublishers.add(publisher);
    hydrated.push({
      ...item,
      role: ["主张", "佐证", "背景", "反例"].includes(entry.role)
        ? entry.role
        : "佐证",
      takeaway: cleanText(entry.takeaway).slice(0, 100),
    });
    if (hydrated.length === 4) break;
  }
  return hydrated;
}

function hydrateArticle(article, label) {
  if (
    !article ||
    !cleanText(article.lead) ||
    !Array.isArray(article.sections) ||
    article.sections.length !== 3 ||
    !cleanText(article.outlook)
  ) {
    throw new Error(`${label} 缺少完整 article`);
  }
  const hydrated = {
    lead: cleanText(article.lead).slice(0, 500),
    sections: article.sections.map((section, sectionIndex) => {
      const heading = cleanText(section?.heading).slice(0, 80);
      const body = cleanText(section?.body).slice(0, 900);
      if (!heading || !body) {
        throw new Error(
          `${label} article section ${sectionIndex + 1} 不完整`,
        );
      }
      return { heading, body };
    }),
    outlook: cleanText(article.outlook).slice(0, 500),
  };
  if (
    /单一来源假设|尚待.{0,30}(?:验证|确认)|由于.{0,45}(?:没有|未).{0,45}(?:不作|无法|不能).{0,24}(?:判断|结论|beat|miss)|single-source hypothesis/iu.test(
      JSON.stringify(hydrated),
    )
  ) {
    throw new Error(`${label} article 包含研究过程说明`);
  }
  return hydrated;
}

function barsFor(index, change) {
  const amount = Number.parseInt(String(change).replace(/[^\d-]/g, ""), 10) || 0;
  const base = Math.max(18, Math.min(68, 38 + amount));
  return Array.from({ length: 6 }, (_, step) =>
    Math.max(
      16,
      Math.min(96, base - 20 + step * 7 + ((index + step * 3) % 9)),
    ),
  );
}

function validateAndHydrate(raw, snapshot, items, model) {
  requireArrayRange(raw.signals, 6, 12, "signals");
  requireArray(raw.exploreSignals, 8, "exploreSignals");
  requireArray(raw.trends, 4, "trends");
  requireArray(raw.discoveries, 3, "discoveries");
  requireArray(raw.companySignals, 3, "companySignals");

  const itemMap = new Map(items.map((item) => [item.ref, item]));
  const tones = ["orange", "blue", "green"];
  const colors = ["blue", "orange", "green"];

  const signals = raw.signals.map((signal, index) => {
    const evidence = hydrateEvidence(signal.evidence, itemMap);
    if (!evidence.length) {
      throw new Error(`signal ${index + 1} 没有有效 evidence`);
    }
    const sourceNames = [
      ...new Set(
        evidence.map((item) => item.sourcePublisher ?? item.sourceName),
      ),
    ];
    const sourceKinds = [...new Set(evidence.map((item) => item.sourceKind))];
    const newest = evidence
      .map((item) => item.publishedAt)
      .filter(Boolean)
      .sort()
      .at(-1);
    const validationType =
      sourceNames.length === 1
        ? "单一来源"
        : sourceKinds.length > 1
          ? "跨平台验证"
          : "多账号验证";
    return {
      id: index + 1,
      category: signal.category,
      eyebrow: signal.eyebrow,
      title: signal.title,
      summary: signal.summary,
      why: signal.why,
      impact: signal.impact,
      shiftFrom: signal.shiftFrom,
      shiftTo: signal.shiftTo,
      crossValidation: signal.crossValidation,
      article: hydrateArticle(signal.article, `signal ${index + 1}`),
      validationType,
      sources: sourceKinds,
      sourceNames,
      sourceCount: sourceNames.length,
      age: formatAge(newest, snapshot.generatedAt),
      score: Math.max(
        60,
        Math.min(
          sourceNames.length === 1 ? 74 : 99,
          Number(signal.score) || 75,
        ),
      ),
      tone: tones[index % tones.length],
      evidence,
      references: evidence.map(
        ({ role: _role, takeaway: _takeaway, ...reference }) => reference,
      ),
    };
  });
  const crossValidatedCount = signals.filter(
    (signal) => signal.sourceCount >= 2,
  ).length;
  const requiredCrossValidatedCount = Math.ceil((signals.length * 2) / 3);
  if (crossValidatedCount < requiredCrossValidatedCount) {
    throw new Error(
      `只有 ${crossValidatedCount} 个 signal 达到独立账号交叉验证，${signals.length} 条中至少需要 ${requiredCrossValidatedCount} 个`,
    );
  }

  const exploreTones = ["violet", "cyan", "amber", "coral"];
  const exploreSignals = raw.exploreSignals.map((signal, index) => {
    const evidence = hydrateEvidence(signal.evidence, itemMap);
    if (!evidence.length) {
      throw new Error(`exploreSignal ${index + 1} 没有有效 evidence`);
    }
    const sourceNames = [
      ...new Set(
        evidence.map((item) => item.sourcePublisher ?? item.sourceName),
      ),
    ];
    const sourceKinds = [...new Set(evidence.map((item) => item.sourceKind))];
    const singleSource = sourceNames.length === 1;
    const label =
      singleSource && !["高风险高潜", "早期拐点"].includes(signal.label)
        ? "早期拐点"
        : signal.label;
    return {
      id: `explore-${index + 1}`,
      category: signal.category,
      label,
      title: signal.title,
      thesis: signal.thesis,
      whyNow: signal.whyNow,
      counterpoint: signal.counterpoint,
      horizon: signal.horizon,
      confidence: singleSource ? "低" : signal.confidence,
      validationType:
        singleSource
          ? "单一来源"
          : sourceKinds.length > 1
            ? "跨平台验证"
            : "多账号验证",
      sourceNames,
      sourceKinds,
      sourceCount: sourceNames.length,
      tone: exploreTones[index % exploreTones.length],
      evidence,
      references: evidence.map(
        ({ role: _role, takeaway: _takeaway, ...reference }) => reference,
      ),
    };
  });
  const exploreCategories = new Set(
    exploreSignals.map((signal) => signal.category),
  );
  const exploreSources = new Set(
    exploreSignals.flatMap((signal) => signal.sourceNames),
  );
  const exploreMultiSource = exploreSignals.filter(
    (signal) => signal.sourceCount >= 2,
  ).length;
  const exploreCrossPlatform = exploreSignals.filter(
    (signal) => signal.validationType === "跨平台验证",
  ).length;
  const exploreWildcards = exploreSignals.filter(
    (signal) => signal.label === "高风险高潜",
  ).length;
  if (
    exploreCategories.size < 6 ||
    exploreSources.size < 7 ||
    exploreMultiSource < 5 ||
    exploreCrossPlatform < 2 ||
    exploreWildcards < 2
  ) {
    throw new Error(
      `exploreSignals 多样性不足：${exploreCategories.size} 类、${exploreSources.size} 个账号、${exploreMultiSource} 条多账号、${exploreCrossPlatform} 条跨平台、${exploreWildcards} 条高风险高潜`,
    );
  }

  const trends = raw.trends.map((trend, index) => ({
    name: trend.name,
    change: trend.change,
    bars: barsFor(index, trend.change),
    references: hydrateRefs(trend.refs, itemMap),
  }));

  const discoveries = raw.discoveries.map((item, index) => {
    const references = hydrateRefs(item.refs, itemMap);
    const source = [...new Set(references.map((ref) => ref.sourceKind))].join(
      " · ",
    );
    return {
      mark: String(item.name ?? "?").slice(0, 2).toUpperCase(),
      name: item.name,
      detail: item.detail,
      source: source || "公开信源",
      color: colors[index % colors.length],
      references,
    };
  });

  const investmentReferences = hydrateRefs(
    raw.investmentThesis?.refs,
    itemMap,
  );
  const companySignals = raw.companySignals.map((item, index) => {
    const evidence = hydrateEvidence(item.evidence, itemMap);
    const sourceNames = [
      ...new Set(
        evidence.map((ref) => ref.sourcePublisher ?? ref.sourceName),
      ),
    ];
    const sourceKinds = [...new Set(evidence.map((ref) => ref.sourceKind))];
    if (sourceNames.length < 2) {
      throw new Error(
        `companySignal ${item.entity ?? "unknown"} 只有 ${sourceNames.length} 个独立账号`,
      );
    }
    const crossValidation = cleanText(item.crossValidation).slice(0, 900);
    if (!crossValidation) {
      throw new Error(
        `companySignal ${item.entity ?? index + 1} 缺少 crossValidation`,
      );
    }
    return {
      entity: item.entity,
      signalType: item.signalType,
      stance: item.stance,
      headline: item.headline,
      whatChanged: item.whatChanged,
      investmentRead: item.investmentRead,
      catalyst: item.catalyst,
      risk: item.risk,
      watchNext: item.watchNext,
      crossValidation,
      article: hydrateArticle(
        item.article,
        `companySignal ${item.entity ?? index + 1}`,
      ),
      score: Math.max(60, Math.min(99, Number(item.score) || 75)),
      validationType:
        sourceKinds.length > 1 ? "跨平台验证" : "多账号验证",
      sourceNames,
      sourceKinds,
      sourceCount: sourceNames.length,
      evidence,
      references: evidence.map(
        ({ role: _role, takeaway: _takeaway, ...reference }) => reference,
      ),
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    basedOnSnapshotAt: snapshot.generatedAt,
    model,
    analyzedItemCount: items.length,
    totalFetchedItemCount: snapshot.items.length,
    editorNote: raw.editorNote,
    signalQuality: Math.max(
      0,
      Math.min(100, Number(raw.signalQuality) || 80),
    ),
    signalQualityChange: Math.max(
      -20,
      Math.min(20, Number(raw.signalQualityChange) || 0),
    ),
    signals,
    exploreSignals,
    trends,
    discoveries,
    investmentThesis: {
      quote: raw.investmentThesis?.quote,
      confidence: raw.investmentThesis?.confidence,
      evidenceCount: new Set(
        investmentReferences.map((item) => item.sourceName),
      ).size,
      references: investmentReferences,
    },
    companySignals,
  };
}

const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
const items = selectItems(snapshot);
if (items.length < 24) {
  throw new Error(`可分析的近 7 天条目不足：${items.length}`);
}
const prompt = buildPrompt(snapshot, items);
const auth = await loadSubscriptionAuth();

let lastError;
let generated;
for (const model of [...new Set(preferredModels)]) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      console.log(
        `Analyzing ${items.length} items with ${model} (attempt ${attempt}/2)...`,
      );
      const output = await callSubscriptionModel({ model, prompt, ...auth });
      const raw = parseJsonOutput(output);
      generated = validateAndHydrate(raw, snapshot, items, model);
      break;
    } catch (error) {
      lastError = error;
      console.warn(
        `${model} attempt ${attempt} failed: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  }
  if (generated) break;
}

if (!generated) {
  throw new Error("所有 subscription 模型调用均失败", { cause: lastError });
}

try {
  const previousRadar = JSON.parse(await readFile(outputPath, "utf8"));
  if (previousRadar.translations?.zh && previousRadar.translations?.en) {
    generated.translations = previousRadar.translations;
    generated.localizationModel = previousRadar.localizationModel;
  }
} catch {
  // The first analysis run has no previous bilingual edition to preserve.
}

await writeFile(outputPath, `${JSON.stringify(generated, null, 2)}\n`, "utf8");
console.log(
  `Done: ${generated.signals.length} signals generated from ${generated.analyzedItemCount} items with ${generated.model}.`,
);
