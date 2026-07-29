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
const endpoint = "https://chatgpt.com/backend-api/codex/responses";
const preferredModels = [
  process.env.SIGNAL_RADAR_MODEL?.trim(),
  "gpt-5.6-sol",
  "gpt-5.5",
].filter(Boolean);
const overlapMs = 6 * 60 * 60 * 1_000;
const requestedCandidateItems = Number(
  argumentValue("limit") ?? process.env.SIGNAL_RADAR_BATCH_SIZE ?? 24,
);
const maxCandidateItems =
  Number.isInteger(requestedCandidateItems) && requestedCandidateItems > 0
    ? Math.min(requestedCandidateItems, 24)
    : 24;
const maxFeedStoriesPerRun = 24;

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
  return Number.isFinite(parsed) ? parsed : fallback;
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
  const termScore = terms.reduce(
    (score, term) => score + (text.includes(term) ? 2 : 0),
    0,
  );
  return officialBonus + termScore + Math.max(0, 36 - ageHours) / 6;
}

export function selectIncrementalItems({
  scannedSnapshot,
  previousSnapshot,
  state,
}) {
  const snapshotTime = Date.parse(scannedSnapshot.generatedAt);
  const processedUrls = new Set(
    state?.processedUrls?.length
      ? state.processedUrls
      : previousSnapshot.items.map((item) => item.url),
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
        !processedUrls.has(item.url)
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
        `id=${signal.id} | ${signal.title} | ${cleanText(signal.summary).slice(0, 120)}`,
    )
    .join("\n");
  const compactItems = candidates
    .map(
      (item) =>
        `${item.ref} | ${item.publishedAt ?? "unknown"} | ${item.sourceKind} | ${item.sourceName} | publisher=${item.sourcePublisher}\n` +
        `标题: ${cleanText(item.title).slice(0, 240)}\n` +
        `摘要: ${cleanText(item.summary).slice(0, 500) || "无摘要"}`,
    )
    .join("\n\n");

  return `你是 Signal Radar 持续信息流的增量编辑。这里没有“日报”或日期版次；你只能处理本次新增条目，不得重写旧稿。

任务：逐条处理本次新增内容，先聚合同一事件，再按照编辑价值决定进入“动态”、进入“探索”，或归档不展示。处理过但未入选的条目不会在以后重新候选，因此每个 ref 都必须有明确去向。

收录规则：
- 每个 ref 必须且只能出现在一个 feedStory、existingUpdate 或 ignored 中。
- bucket=dynamic 只用于已经发生的明确状态变化：发布、财报、监管、融资、产品上线、政策决定或有实质新证据的事件。必须有足够正文和可核验事实；官方一手来源可以单独成立。
- bucket=explore 用于有清晰 thesis、二阶影响、跨界连接或值得持续验证的非共识判断。不能只是把单篇内容换句话复述。
- 内容单薄、题目党、未经验证的规模数字、过窄教程、个人随感、与 Radar 重点弱相关的条目放进 ignored，并在 reason 前加“归档：”。“已处理”不等于“必须发布”。
- 单一 Blog、YouTube、Newsletter、Fed 或 SEC 来源都允许收录，并标为“单一来源”；出现更多独立来源时再做 cross-validation。
- 多条新增内容讲同一事件时合并成一篇稿件，逐项列出不同来源提供的事实或观点。
- 若新增内容只是在佐证现有事件，或为现有事件补充了后续进展，放进 existingUpdates，追加“最新进展”和新 evidence；不得重写旧稿正文。只有出现可独立理解的新事件时才新建 feedStory。
- Fed statement 若没有利率决定、投票和关键措辞，SEC 业绩文件若只有 filing metadata 而没有财务数字或附件正文，不得生成稿件；放进 ignored 并注明“等待官方正文 enrichment”，留给后续新证据更新。
- SEC 财报不得在没有一致预期数据时声称 beat/miss。
- 所有事实和数字必须来自 evidence；编辑判断必须使用审慎语气。
- 每条都要提供完整中文稿和英文稿，专有名词保持原文。
- 本批最多 ${maxFeedStoriesPerRun} 篇；如果多个条目属于同一事件，应优先聚类而不是截断。

现有新闻标题，用于避免把完全相同的内容重复成稿：
${existingTitles}

只返回合法 JSON：
{
  "feedStories": [
    {
      "bucket": "dynamic|explore",
      "priority": 0,
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
      "priority": 0,
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
        "Classify every new source item exactly once. Publish only qualified dynamic events or substantive explore theses; archive weak items. Return only valid JSON.",
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

export function validateFeedCoverage(raw, candidates) {
  const expected = new Set(candidates.map((item) => item.ref));
  const covered = new Map();
  const claim = (ref, disposition) => {
    if (!expected.has(ref)) {
      throw new Error(`Model returned unknown source ref ${ref}`);
    }
    if (covered.has(ref)) {
      throw new Error(`Source ref ${ref} was assigned more than once`);
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
  return {
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
            (Number(right?.priority) || 0) - (Number(left?.priority) || 0),
        )
        .slice(0, maxFeedStoriesPerRun)
    : [];
  const itemMap = new Map(candidates.map((item) => [item.ref, item]));
  const existingTitles = new Set(
    radar.signals.map((signal) => normalizeTitle(signal.title)),
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
    const titleKey = normalizeTitle(event.signal?.title);
    if (!titleKey || existingTitles.has(titleKey)) continue;

    const evidence = [];
    const seenUrls = new Set();
    for (const entry of event.signal?.evidence ?? []) {
      const item = itemMap.get(entry?.ref);
      if (!item || seenUrls.has(item.url)) continue;
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

    const metadata = evidenceMetadata(evidence);
    const newest = evidence
      .map((item) => item.publishedAt)
      .filter(Boolean)
      .sort()
      .at(-1);
    const id = nextId + hydrated.length + 1;
    const signal = {
      id,
      editorialBucket: event.bucket,
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
          Number(event.priority) || Number(event.signal.score) || 50,
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
      if (!item || seenUrls.has(item.url)) continue;
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
      priority: Math.max(0, Math.min(99, Number(entry.priority) || 50)),
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
  const signals = hydratedStories.map((event) => event.signal);
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
      score: Math.max(Number(previous.score) || 0, hydrated.priority),
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
  return {
    lastScanAt: scannedSnapshot.generatedAt,
    windowStartAt: scannedSnapshot.generatedAt,
    initializedSourceIds: scannedSnapshot.statuses
      .filter((status) => status.status === "ok")
      .map((status) => String(status.sourceId)),
    processedUrls: [
      ...new Set(
        scannedSnapshot.items.map((item) => item.url).filter(Boolean),
      ),
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
  const allInitializedSourceIds = new Set([
    ...initializedSourceIds,
    ...successfulSourceIds,
  ]);
  const remainingEligibleItems = scannedSnapshot.items.filter((item) => {
    if (!item.url || urls.has(item.url)) return false;
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
  };
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

  const candidates = selectIncrementalItems({
    scannedSnapshot,
    previousSnapshot,
    state,
  });
  const baseResult = {
    scannedAt: scannedSnapshot.generatedAt,
    newItemCount: candidates.length,
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
      candidateTitles: candidates.slice(0, 20).map((item) => item.title),
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
  if (candidates.length) {
    const auth = await loadSubscriptionAuth();
    const prompt = buildPrompt({ candidates, radar, scannedSnapshot });
    let lastError;
    for (const candidateModel of preferredModels) {
      try {
        const output = await callSubscriptionModel({
          model: candidateModel,
          prompt,
          ...auth,
        });
        const raw = parseJsonOutput(output);
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
    nextState({ state, previousSnapshot, candidates, scannedSnapshot }),
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
