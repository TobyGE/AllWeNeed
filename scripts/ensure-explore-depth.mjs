import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const radarPath = resolve(projectRoot, "data/daily-radar.json");
const authPath = resolve(homedir(), ".codex/auth.json");
const editorialSkillDirectory = resolve(
  homedir(),
  ".codex/skills/radar-editorial-research",
);
const endpoint = "https://chatgpt.com/backend-api/codex/responses";
const targetExploreCount = Math.max(
  50,
  Number(argumentValue("target") ?? process.env.SIGNAL_RADAR_EXPLORE_MIN ?? 50) ||
    50,
);
const preferredModels = [
  process.env.SIGNAL_RADAR_MODEL?.trim(),
  "gpt-5.6-sol",
  "gpt-5.5",
].filter((value, index, values) => value && values.indexOf(value) === index);
const categories = [
  "AI 工程",
  "开发工具",
  "机器人",
  "安全",
  "消费科技",
  "商业模式",
  "科学",
  "社会影响",
  "投资",
  "宏观",
  "算力",
  "组织与治理",
];
const labels = ["反常识", "二阶影响", "早期拐点", "跨界连接", "高风险高潜"];
const horizons = ["现在", "3-6个月", "1-2年"];
const confidences = ["低", "中", "中高"];
const tones = ["violet", "cyan", "amber", "coral"];

function argumentValue(name) {
  const prefix = `--${name}=`;
  return process.argv
    .find((argument) => argument.startsWith(prefix))
    ?.slice(prefix.length);
}

function cleanText(value = "") {
  return String(value).replace(/\s+/g, " ").trim();
}

function normalizeTitle(value = "") {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function clamp(value, minimum, maximum, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? Math.max(minimum, Math.min(maximum, Math.round(numeric)))
    : fallback;
}

async function loadEditorialWritingSkill() {
  try {
    const [skill, writing] = await Promise.all([
      readFile(resolve(editorialSkillDirectory, "SKILL.md"), "utf8"),
      readFile(
        resolve(editorialSkillDirectory, "references/writing-standard.md"),
        "utf8",
      ),
    ]);
    return [
      skill.replace(/^---[\s\S]*?---\s*/u, "").trim(),
      writing.trim(),
    ].join("\n\n");
  } catch {
    return "Write one centered, source-backed thesis. Use uncertainty locally once; do not turn the article into a research disclaimer. Give the strongest countercase one bounded section and devote most of the essay to the thesis and its mechanism.";
  }
}

function compactInput(radar) {
  const evidenceByUrl = new Map();
  const seeds = radar.signals
    .filter((signal) => signal.editorialBucket !== "explore")
    .map((signal) => {
      const evidenceKeys = [];
      for (const evidence of signal.evidence) {
        if (!evidence?.url) continue;
        let entry = evidenceByUrl.get(evidence.url);
        if (!entry) {
          entry = {
            key: `E${String(evidenceByUrl.size + 1).padStart(3, "0")}`,
            feedBatchAt:
              signal.feedBatchAt ?? signal.updatedAt ?? radar.generatedAt,
            evidence,
          };
          evidenceByUrl.set(evidence.url, entry);
        }
        evidenceKeys.push(entry.key);
      }
      return {
        seedId: `S${signal.id}`,
        category: signal.category,
        title: signal.title,
        summary: cleanText(signal.summary).slice(0, 500),
        why: cleanText(signal.why).slice(0, 500),
        impact: cleanText(signal.impact).slice(0, 500),
        crossValidation: cleanText(signal.crossValidation).slice(0, 700),
        evidenceKeys,
      };
    })
    .filter((seed) => seed.evidenceKeys.length);

  const evidenceEntries = [...evidenceByUrl.values()];
  const evidence = evidenceEntries.map(({ key, evidence: item }) => ({
    key,
    sourceName: item.sourceName,
    sourceKind: item.sourceKind,
    title: cleanText(item.title).slice(0, 260),
    summary: cleanText(item.summary).slice(0, 700),
    takeaway: cleanText(item.takeaway).slice(0, 220),
  }));
  return { seeds, evidence, evidenceEntries };
}

function buildChinesePrompt({ radar, seeds, evidence, requestedCount }) {
  const existingTitles = [
    ...radar.exploreSignals.map((signal) => signal.title),
    ...radar.signals
      .filter((signal) => signal.editorialBucket === "explore")
      .map((signal) => signal.title),
  ];

  return `你是 All We Need 的 Explore 主编。

目标：从已经正式入选、已有完整证据链的 Radar 稿件中，提炼 ${requestedCount} 个新增 Explore 方向。不要重新使用曾经被编辑流程淘汰的原始条目；下面给你的材料全部来自已经正式收录的稿件。

Explore 不是重复新闻，而是从已知事实中提出可继续验证的非共识判断、二阶影响、跨界连接或早期拐点。内容可以大胆，但必须明确区分来源事实与编辑推断。

硬性规则：
- 恰好返回 ${requestedCount} 条，不能少。
- 只能使用输入中的 evidence key；不得从记忆补充事实、数字、日期、人物、公司背景或因果关系。
- 每条使用 1-3 个 evidence key。多来源时要说明各来源分别贡献了什么；单一来源时必须明确写“单一来源假设”，confidence 只能是“低”。
- 同一个 seed 最多产生 2 个方向；若同一 seed 产生 2 条，必须是明显不同、可分别证伪的角度。
- 至少覆盖 10 个 category，任何 category 不得超过 5 条。
- 至少 12 条使用两个或以上独立 sourceName；至少 8 条跨 sourceKind。
- 至少 8 条为“高风险高潜”，至少 8 条为“跨界连接”。
- 不得重复现有标题，也不得用同义标题重复同一个 thesis。
- title 必须具体，避免“值得关注”“迎来变化”“未来可期”等空话。
- counterpoint 必须是真正可能推翻 thesis 的反证，不是礼貌性保留。
- 每条都要写成完整站内稿：导语 + 三段正文 + outlook。文章只能有一个中心 thesis，约 70–80% 篇幅用于建立证据连接与机制，反方观点和证伪条件集中在一个有边界的段落。
- uncertainty 只在影响结论的位置说明一次。不得反复写“单一来源假设”“尚未验证”“没有数据证明”等研究过程；如果证据不足，缩小 thesis，而不是让限制条件成为全文中心。
- 中文中保留 company、product、model、person、publication、platform、benchmark、API、AI、Agent、LLM、token、context、inference、open-source、workflow 等专业名词，不要生硬全译。
- 不得使用确定语气预测尚未发生的未来，不得写投资建议。

允许的 category：
${categories.join("、")}

允许的 label：
${labels.join("、")}

现有标题，禁止重复：
${existingTitles.map((title) => `- ${title}`).join("\n")}

只返回合法 JSON：
{
  "items": [
    {
      "category": "允许值",
      "label": "允许值",
      "title": "不超过32个汉字",
      "thesis": "核心探索判断，不超过110个汉字",
      "whyNow": "为什么现在值得追踪，不超过85个汉字",
      "counterpoint": "最强反方观点，不超过85个汉字",
      "horizon": "现在|3-6个月|1-2年",
      "confidence": "低|中|中高",
      "valueScore": 60到92的整数,
      "evidence": [
        {
          "key": "E001",
          "takeaway": "这一来源具体支持 thesis 的哪一部分"
        }
      ],
      "crossValidation": "逐项说明来源如何连接；单一来源时明确写单一来源假设",
      "article": {
        "lead": "100-180个汉字",
        "sections": [
          {"heading": "具体小标题", "body": "140-260个汉字"},
          {"heading": "具体小标题", "body": "140-260个汉字"},
          {"heading": "具体小标题", "body": "130-230个汉字"}
        ],
        "outlook": "90-160个汉字，写可验证的增强或削弱条件"
      }
    }
  ]
}

已正式入选的 Radar seeds：
${JSON.stringify(seeds)}

可引用证据：
${JSON.stringify(evidence)}`;
}

function buildEnglishPrompt(items) {
  const compactItems = items.map((item) => ({
    id: item.id,
    category: item.category,
    label: item.label,
    title: item.title,
    thesis: item.thesis,
    whyNow: item.whyNow,
    counterpoint: item.counterpoint,
    horizon: item.horizon,
    confidence: item.confidence,
    evidence: item.evidence.map((entry) => ({
      key: entry.key,
      sourceName: entry.sourceName,
      sourceKind: entry.sourceKind,
      originalTitle: entry.title,
      takeaway: entry.takeaway,
    })),
    crossValidation: item.crossValidation,
    article: item.article,
  }));

  return `You are the English editor for All We Need.

Translate and rewrite every supplied Explore item into polished, concise editorial English.

Rules:
- Return all ${items.length} items in exactly the same order and preserve every id and evidence key.
- Preserve facts, numbers, uncertainty, source names, product names, model names, and original titles exactly.
- Do not add background knowledge or new claims.
- Keep the distinction between sourced observation, editorial inference, and counterargument.
- Translate interface taxonomy naturally: category, label, horizon, and confidence should be concise English.
- The article must remain a cohesive source-backed essay with exactly three sections.

Return valid JSON only:
{
  "items": [
    {
      "id": "explore-depth-01",
      "category": "...",
      "label": "...",
      "title": "...",
      "thesis": "...",
      "whyNow": "...",
      "counterpoint": "...",
      "horizon": "...",
      "confidence": "...",
      "evidence": [{"key": "E001", "takeaway": "..."}],
      "crossValidation": "...",
      "article": {
        "lead": "...",
        "sections": [
          {"heading": "...", "body": "..."},
          {"heading": "...", "body": "..."},
          {"heading": "...", "body": "..."}
        ],
        "outlook": "..."
      }
    }
  ]
}

Input:
${JSON.stringify(compactItems)}`;
}

async function loadSubscriptionAuth() {
  const auth = JSON.parse(await readFile(authPath, "utf8"));
  const tokens = auth.tokens ?? {};
  if (!tokens.access_token || !tokens.account_id) {
    throw new Error("ChatGPT subscription credentials are unavailable.");
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
  reasoningEffort,
  instructions,
}) {
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
        `${instructions}\n\nStay strictly evidence-bound. Return only complete, valid JSON without markdown fences.`,
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: prompt }],
        },
      ],
      reasoning: { effort: reasoningEffort },
      stream: true,
      store: false,
    }),
    signal: AbortSignal.timeout(600_000),
  });

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status}: ${(await response.text()).slice(0, 800)}`,
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
        throw new Error(
          `response.failed: ${JSON.stringify(event).slice(0, 800)}`,
        );
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
    throw new Error("Model did not return a JSON object.");
  }
  return JSON.parse(unfenced.slice(start, end + 1));
}

async function callWithFallback({
  prompt,
  auth,
  reasoningEffort,
  instructions,
  validate,
}) {
  let lastError;
  for (const model of preferredModels) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        console.log(`${model} attempt ${attempt}...`);
        const raw = parseJsonOutput(
          await callSubscriptionModel({
            model,
            prompt,
            ...auth,
            reasoningEffort,
            instructions,
          }),
        );
        return { value: validate(raw), model };
      } catch (error) {
        lastError = error;
        console.warn(
          `${model} attempt ${attempt} failed: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }
  }
  throw new Error("All Explore depth model calls failed.", {
    cause: lastError,
  });
}

function requireCompleteArticle(article, label) {
  if (
    !cleanText(article?.lead) ||
    !Array.isArray(article?.sections) ||
    article.sections.length !== 3 ||
    !cleanText(article?.outlook)
  ) {
    throw new Error(`${label} has an incomplete article.`);
  }
  const complete = {
    lead: cleanText(article.lead).slice(0, 1_200),
    sections: article.sections.map((section, sectionIndex) => {
      const heading = cleanText(section?.heading).slice(0, 140);
      const body = cleanText(section?.body).slice(0, 1_600);
      if (!heading || !body) {
        throw new Error(
          `${label} article section ${sectionIndex + 1} is incomplete.`,
        );
      }
      return { heading, body };
    }),
    outlook: cleanText(article.outlook).slice(0, 1_000),
  };
  const serialized = JSON.stringify(complete);
  if (
    /单一来源假设|尚待.{0,30}(?:验证|确认)|由于.{0,45}(?:没有|未).{0,45}(?:不作|无法|不能).{0,24}(?:判断|结论|beat|miss)|single-source hypothesis/iu.test(
      serialized,
    )
  ) {
    throw new Error(`${label} narrates a research limitation.`);
  }
  return complete;
}

function validateChineseItems({
  raw,
  requestedCount,
  radar,
  evidenceEntries,
}) {
  if (!Array.isArray(raw?.items) || raw.items.length !== requestedCount) {
    throw new Error(
      `Expected ${requestedCount} Explore items, received ${
        Array.isArray(raw?.items) ? raw.items.length : 0
      }.`,
    );
  }
  const evidenceMap = new Map(
    evidenceEntries.map((entry) => [entry.key, entry]),
  );
  const seenTitles = new Set([
    ...radar.exploreSignals.map((signal) => normalizeTitle(signal.title)),
    ...radar.signals
      .filter((signal) => signal.editorialBucket === "explore")
      .map((signal) => normalizeTitle(signal.title)),
  ]);

  return raw.items.map((item, index) => {
    const title = cleanText(item?.title).slice(0, 140);
    const titleKey = normalizeTitle(title);
    if (!titleKey || seenTitles.has(titleKey)) {
      throw new Error(`Explore item ${index + 1} has a duplicate title.`);
    }
    seenTitles.add(titleKey);

    const seenEvidence = new Set();
    const evidence = [];
    for (const entry of Array.isArray(item?.evidence) ? item.evidence : []) {
      const source = evidenceMap.get(entry?.key);
      if (!source || seenEvidence.has(source.evidence.url)) continue;
      seenEvidence.add(source.evidence.url);
      evidence.push({
        key: source.key,
        feedBatchAt: source.feedBatchAt,
        ...source.evidence,
        role: "佐证",
        takeaway: cleanText(entry.takeaway).slice(0, 240),
      });
      if (evidence.length === 3) break;
    }
    if (!evidence.length) {
      throw new Error(`Explore item ${index + 1} has no valid evidence.`);
    }

    const sourceNames = [...new Set(evidence.map((entry) => entry.sourceName))];
    const sourceKinds = [...new Set(evidence.map((entry) => entry.sourceKind))];
    const singleSource = sourceNames.length === 1;
    const batchTimes = evidence
      .map((entry) => entry.feedBatchAt)
      .filter((value) => Number.isFinite(Date.parse(value)))
      .sort();
    const id = `explore-depth-${String(index + 1).padStart(2, "0")}`;
    return {
      id,
      category: categories.includes(item.category) ? item.category : "AI 工程",
      label: labels.includes(item.label)
        ? singleSource && !["高风险高潜", "早期拐点"].includes(item.label)
          ? "早期拐点"
          : item.label
        : singleSource
          ? "早期拐点"
          : "二阶影响",
      title,
      thesis: cleanText(item.thesis).slice(0, 600),
      whyNow: cleanText(item.whyNow).slice(0, 500),
      counterpoint: cleanText(item.counterpoint).slice(0, 500),
      horizon: horizons.includes(item.horizon) ? item.horizon : "3-6个月",
      confidence: singleSource
        ? "低"
        : confidences.includes(item.confidence)
          ? item.confidence
          : "中",
      validationType: singleSource
        ? "单一来源"
        : sourceKinds.length > 1
          ? "跨平台验证"
          : "多账号验证",
      sourceNames,
      sourceKinds,
      sourceCount: sourceNames.length,
      tone: tones[(radar.exploreSignals.length + index) % tones.length],
      evidence,
      crossValidation: cleanText(item.crossValidation).slice(0, 1_000),
      article: requireCompleteArticle(item.article, id),
      feedBatchAt:
        batchTimes.at(-1) ??
        radar.basedOnSnapshotAt ??
        radar.generatedAt,
      valueScore: clamp(item.valueScore, 60, 92, 72),
    };
  });
}

function validateEnglishItems(raw, chineseItems) {
  if (
    !Array.isArray(raw?.items) ||
    raw.items.length !== chineseItems.length
  ) {
    throw new Error(
      `Expected ${chineseItems.length} English Explore items, received ${
        Array.isArray(raw?.items) ? raw.items.length : 0
      }.`,
    );
  }
  return raw.items.map((item, index) => {
    const source = chineseItems[index];
    if (item?.id !== source.id) {
      throw new Error(`English Explore item ${index + 1} changed id.`);
    }
    const rawEvidence = Array.isArray(item.evidence) ? item.evidence : [];
    if (
      rawEvidence.length !== source.evidence.length ||
      rawEvidence.some(
        (entry, evidenceIndex) =>
          entry?.key !== source.evidence[evidenceIndex].key,
      )
    ) {
      throw new Error(`English ${source.id} changed evidence order.`);
    }
    return {
      category: cleanText(item.category),
      label: cleanText(item.label),
      title: cleanText(item.title),
      thesis: cleanText(item.thesis),
      whyNow: cleanText(item.whyNow),
      counterpoint: cleanText(item.counterpoint),
      horizon: cleanText(item.horizon),
      confidence: cleanText(item.confidence),
      evidence: rawEvidence.map((entry, evidenceIndex) => ({
        ref: source.evidence[evidenceIndex].ref,
        sourceName: source.evidence[evidenceIndex].sourceName,
        sourceKind: source.evidence[evidenceIndex].sourceKind,
        originalTitle: source.evidence[evidenceIndex].title,
        takeaway: cleanText(entry.takeaway),
      })),
      crossValidation: cleanText(item.crossValidation),
      article: requireCompleteArticle(item.article, `en.${source.id}`),
    };
  });
}

function chineseTranslation(item) {
  return {
    category: item.category,
    label: item.label,
    title: item.title,
    thesis: item.thesis,
    whyNow: item.whyNow,
    counterpoint: item.counterpoint,
    horizon: item.horizon,
    confidence: item.confidence,
    evidence: item.evidence.map((entry) => ({
      ref: entry.ref,
      sourceName: entry.sourceName,
      sourceKind: entry.sourceKind,
      originalTitle: entry.title,
      takeaway: entry.takeaway,
    })),
    crossValidation: item.crossValidation,
    article: item.article,
  };
}

function publicExploreItem(item) {
  return {
    ...item,
    evidence: item.evidence.map(
      ({ key: _key, feedBatchAt: _feedBatchAt, ...entry }) => entry,
    ),
    references: item.evidence.map(
      ({
        key: _key,
        feedBatchAt: _feedBatchAt,
        role: _role,
        takeaway: _takeaway,
        ...entry
      }) => entry,
    ),
  };
}

const radar = JSON.parse(await readFile(radarPath, "utf8"));
const missingCount = Math.max(
  0,
  targetExploreCount - radar.exploreSignals.length,
);

if (!missingCount) {
  console.log(
    `Explore depth already satisfied: ${radar.exploreSignals.length}/${targetExploreCount}.`,
  );
  process.exit(0);
}

if (!radar.translations?.zh?.exploreSignals || !radar.translations?.en?.exploreSignals) {
  throw new Error("Aligned zh and en Explore translations are required.");
}

const { seeds, evidence, evidenceEntries } = compactInput(radar);
if (seeds.length < 20 || evidenceEntries.length < 24) {
  throw new Error(
    `Not enough published Radar evidence to deepen Explore: ${seeds.length} seeds, ${evidenceEntries.length} evidence items.`,
  );
}

const auth = await loadSubscriptionAuth();
const editorialInstructions = await loadEditorialWritingSkill();
console.log(
  `Generating ${missingCount} evidence-bound Explore directions from ${seeds.length} published Radar stories...`,
);
const chineseResult = await callWithFallback({
  prompt: buildChinesePrompt({
    radar,
    seeds,
    evidence,
    requestedCount: missingCount,
  }),
  auth,
  reasoningEffort: "high",
  instructions: editorialInstructions,
  validate: (raw) =>
    validateChineseItems({
      raw,
      requestedCount: missingCount,
      radar,
      evidenceEntries,
    }),
});

console.log(`Writing English editions for ${missingCount} Explore directions...`);
const englishResult = await callWithFallback({
  prompt: buildEnglishPrompt(chineseResult.value),
  auth,
  reasoningEffort: "low",
  instructions: editorialInstructions,
  validate: (raw) => validateEnglishItems(raw, chineseResult.value),
});

radar.exploreSignals.push(
  ...chineseResult.value.map((item) => publicExploreItem(item)),
);
radar.translations.zh.exploreSignals.push(
  ...chineseResult.value.map(chineseTranslation),
);
radar.translations.en.exploreSignals.push(...englishResult.value);
radar.exploreDepth = {
  minimum: targetExploreCount,
  generatedAt: new Date().toISOString(),
  zhModel: chineseResult.model,
  enModel: englishResult.model,
};

await writeFile(radarPath, `${JSON.stringify(radar, null, 2)}\n`, "utf8");
console.log(
  `Done: Explore now contains ${radar.exploreSignals.length} curated directions.`,
);
