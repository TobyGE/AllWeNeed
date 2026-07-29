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
const lookbackMs = 72 * 60 * 60 * 1_000;
const maxCandidateItems = 160;
const maxMajorEventsPerRun = 4;

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
  const previousTime = Date.parse(
    state?.lastScanAt ??
      previousSnapshot.generatedAt ??
      scannedSnapshot.generatedAt,
  );
  const processedUrls = new Set(
    state?.processedUrls?.length
      ? state.processedUrls
      : previousSnapshot.items.map((item) => item.url),
  );
  const cutoff = Math.max(
    snapshotTime - lookbackMs,
    previousTime - overlapMs,
  );

  return scannedSnapshot.items
    .filter((item) => {
      if (!item.url || processedUrls.has(item.url)) return false;
      return itemTime(item, snapshotTime) >= cutoff;
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
    .map((signal) => signal.title)
    .join("；");
  const compactItems = candidates
    .map(
      (item) =>
        `${item.ref} | ${item.publishedAt ?? "unknown"} | ${item.sourceKind} | ${item.sourceName} | publisher=${item.sourcePublisher}\n` +
        `标题: ${cleanText(item.title).slice(0, 240)}\n` +
        `摘要: ${cleanText(item.summary).slice(0, 500) || "无摘要"}`,
    )
    .join("\n\n");

  return `你是 Signal Radar 的增量新闻编辑。你只能检查“本次新增条目”，不得重写、重新排序或重新概括旧新闻。

任务：判断新增条目中是否出现足以追加到新闻列表的重大事件。没有就返回空数组；绝不为了每日更新而凑数。

重大事件门槛：
- Federal Reserve：FOMC 决议、利率或资产负债表行动、政策措辞显著变化、重要官方经济判断。
- SEC/公司：最新财报或 earnings 8-K 中对收入、利润、现金流、guidance 或业务结构有显著含义的披露。不得在没有一致预期数据时声称 beat/miss。
- AI/科技：重要 model 或产品发布、重大安全事故、收购/融资、监管行动、关键基础设施变化。
- 普通博客、YouTube、Newsletter 必须至少由两个不同 publisher 相互验证。
- Federal Reserve 或 SEC 的正式一手文件允许单一官方来源，但必须明确标为“单一来源”，不要伪装成 cross-validation。
- importance 低于 80 的内容不得输出。每次最多 ${maxMajorEventsPerRun} 条。
- 与旧新闻语义重复的事件不得输出，即使换了标题或新增了一个重复来源。
- 所有事实和数字必须来自 evidence；编辑判断必须使用审慎语气。
- 每条都要写成完整站内稿件，并同时提供中文与英文。专有名词保持原文。

现有新闻标题，用于去重：
${existingTitles}

只返回合法 JSON：
{
  "majorEvents": [
    {
      "importance": 80,
      "signal": {
        "category": "AI & 模型|Agents|算力|投资|科技|宏观",
        "eyebrow": "必须知道|趋势变化|资本信号|风险预警|产品信号",
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
        "Apply the major-event threshold strictly. Return only valid JSON.",
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

export function hydrateMajorEvents({
  raw,
  candidates,
  radar,
  generatedAt,
}) {
  const events = Array.isArray(raw?.majorEvents)
    ? raw.majorEvents.slice(0, maxMajorEventsPerRun)
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
    if (Number(event.importance) < 80) continue;
    const titleKey = normalizeTitle(event.signal?.title);
    if (!titleKey || existingTitles.has(titleKey)) continue;

    const evidence = [];
    const publishers = new Set();
    for (const entry of event.signal?.evidence ?? []) {
      const item = itemMap.get(entry?.ref);
      const publisher = item?.sourcePublisher ?? item?.sourceName;
      if (!item || publishers.has(publisher)) continue;
      publishers.add(publisher);
      evidence.push({
        ...item,
        role: ["主张", "佐证", "背景", "反例"].includes(entry.role)
          ? entry.role
          : "佐证",
        takeaway: cleanText(entry.takeaway).slice(0, 120),
      });
      if (evidence.length === 4) break;
    }
    if (!evidence.length) continue;

    const officialSingleSource =
      evidence.length === 1 && ["Fed", "SEC"].includes(evidence[0].sourceKind);
    if (publishers.size < 2 && !officialSingleSource) continue;

    const sourceKinds = [...new Set(evidence.map((item) => item.sourceKind))];
    const sourceNames = [
      ...new Set(
        evidence.map((item) => item.sourcePublisher ?? item.sourceName),
      ),
    ];
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
    const id = nextId + hydrated.length + 1;
    const signal = {
      id,
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
      validationType,
      sources: sourceKinds,
      sourceNames,
      sourceCount: sourceNames.length,
      age: formatAge(newest, generatedAt),
      score: Math.max(60, Math.min(99, Number(event.signal.score) || 80)),
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

export function mergeMajorEvents({
  radar,
  hydratedEvents,
  scannedSnapshot,
}) {
  if (!hydratedEvents.length) return radar;
  const addedAt = new Date().toISOString();
  const signals = hydratedEvents.map((event) => event.signal);
  const zhSignals = hydratedEvents.map((event) => event.zhTranslation);
  const enSignals = hydratedEvents.map((event) => event.enTranslation);
  return {
    ...radar,
    generatedAt: addedAt,
    basedOnSnapshotAt: scannedSnapshot.generatedAt,
    totalFetchedItemCount: scannedSnapshot.items.length,
    signals: [...signals, ...radar.signals],
    translations: {
      ...radar.translations,
      zh: {
        ...radar.translations.zh,
        signals: [...zhSignals, ...radar.translations.zh.signals],
      },
      en: {
        ...radar.translations.en,
        signals: [...enSignals, ...radar.translations.en.signals],
      },
    },
    incremental: {
      lastAddedAt: addedAt,
      lastScanAt: scannedSnapshot.generatedAt,
      lastAddedCount: hydratedEvents.length,
      totalAppended:
        Number(radar.incremental?.totalAppended ?? 0) + hydratedEvents.length,
    },
  };
}

function nextState({ state, previousSnapshot, scannedSnapshot }) {
  const urls = new Set([
    ...(state?.processedUrls ?? previousSnapshot.items.map((item) => item.url)),
    ...scannedSnapshot.items.map((item) => item.url),
  ]);
  return {
    lastScanAt: scannedSnapshot.generatedAt,
    processedUrls: [...urls].slice(-20_000),
  };
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
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
      majorEventCount: 0,
      addedTitles: [],
      publishRequired: false,
      dryRun: true,
      candidateTitles: candidates.slice(0, 20).map((item) => item.title),
    };
    await writeJson(resultPath, result);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  let hydratedEvents = [];
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
        hydratedEvents = hydrateMajorEvents({
          raw: parseJsonOutput(output),
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
    nextState({ state, previousSnapshot, scannedSnapshot }),
  );

  if (hydratedEvents.length) {
    const mergedRadar = mergeMajorEvents({
      radar,
      hydratedEvents,
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
    majorEventCount: hydratedEvents.length,
    addedTitles: hydratedEvents.map((event) => event.signal.title),
    publishRequired: hydratedEvents.length > 0,
    dryRun: false,
  };
  await writeJson(resultPath, result);
  console.log(JSON.stringify(result, null, 2));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
