import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { modelRoutes } from "./model-routing.mjs";
import {
  modelReasoningEffort,
  modelSearchContextSize,
  modelTaskInstructions,
} from "./model-prompts.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const radarPath = resolve(projectRoot, "data/daily-radar.json");
const authPath = resolve(homedir(), ".codex/auth.json");
const editorialSkillDirectory = resolve(
  homedir(),
  ".codex/skills/radar-editorial-research",
);
const endpoint = "https://chatgpt.com/backend-api/codex/responses";
const preferredModels = modelRoutes.standardWriting;
const processNarration =
  /单一来源假设|尚待.{0,30}(?:验证|确认)|由于.{0,45}(?:没有|未).{0,45}(?:不作|无法|不能).{0,24}(?:判断|结论|beat|miss)|single-source hypothesis|without.{0,40}consensus.{0,40}(?:cannot|can't|do not|won't)/iu;
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

function argumentValue(name) {
  const prefix = `--${name}=`;
  return process.argv
    .find((argument) => argument.startsWith(prefix))
    ?.slice(prefix.length);
}

function cleanText(value = "") {
  return String(value).replace(/\s+/g, " ").trim();
}

function articleText(article) {
  return [
    article?.lead,
    ...(article?.sections ?? []).flatMap((section) => [
      section?.heading,
      section?.body,
    ]),
    article?.outlook,
  ]
    .map(cleanText)
    .join(" ");
}

function completeArticle(article, label) {
  if (
    !cleanText(article?.lead) ||
    !Array.isArray(article?.sections) ||
    article.sections.length !== 3 ||
    !cleanText(article?.outlook)
  ) {
    throw new Error(`${label} article is incomplete.`);
  }
  const value = {
    lead: cleanText(article.lead).slice(0, 1_200),
    sections: article.sections.map((section, index) => {
      const heading = cleanText(section?.heading).slice(0, 140);
      const body = cleanText(section?.body).slice(0, 1_800);
      if (!heading || !body) {
        throw new Error(`${label} section ${index + 1} is incomplete.`);
      }
      return { heading, body };
    }),
    outlook: cleanText(article.outlook).slice(0, 1_000),
  };
  if (processNarration.test(articleText(value))) {
    throw new Error(`${label} narrates a research limitation.`);
  }
  return value;
}

async function loadEditorialSkill() {
  try {
    const [skill, matrices, writing] = await Promise.all([
      readFile(resolve(editorialSkillDirectory, "SKILL.md"), "utf8"),
      readFile(
        resolve(editorialSkillDirectory, "references/research-matrices.md"),
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

function buildPrompt(stories) {
  const inputs = stories.map(({ signal, zh, en }) => ({
    id: signal.id,
    category: signal.category,
    title: signal.title,
    summary: signal.summary,
    why: signal.why,
    impact: signal.impact,
    shiftFrom: signal.shiftFrom,
    shiftTo: signal.shiftTo,
    crossValidation: signal.crossValidation,
    article: signal.article,
    evidence: signal.evidence.map((evidence, index) => ({
      ref: evidence.ref,
      sourceName: evidence.sourceName,
      sourceKind: evidence.sourceKind,
      title: evidence.title,
      url: evidence.url,
      publishedAt: evidence.publishedAt,
      summary: cleanText(evidence.summary).slice(0, 1_000),
      takeaway: zh.evidence?.[index]?.takeaway ?? evidence.takeaway,
      englishTakeaway: en.evidence?.[index]?.takeaway,
    })),
  }));

  return `使用 live web search 研究并重写以下 All We Need 动态稿件。当前稿件把“没有完成研究”写进正文；你的任务是主动补齐 material facts，重新选择文章中心。

要求：
- 对每篇稿件使用 earnings/filing research matrix。主动搜索 company IR、SEC filing、earnings release、presentation、call transcript，以及具名 provider 的 analyst consensus。
- reported actuals、GAAP/non-GAAP EPS、guidance、consensus 和 market reaction 必须分开。
- beat/miss 需要可比的 actual 与具名 consensus；否则选择 growth、margin、cash flow、guidance 或关键 KPI 作为中心，不得解释为何没有写 beat/miss。
- newSources 只返回现有 evidence 之外的 canonical 原文，最多 4 条。搜索结果页或 snippet 不能成为 source。
- 中文稿和英文稿都必须是完整文章，只有一个 central claim。正文不得出现研究过程、反复 disclaimer 或“尚待更多验证”。
- 保留真实的不确定性，但只在影响某个具体判断的位置说明一次。
- 专有名词保持原文，不写投资建议。
- 所有输入 id 必须原样返回。

只返回合法 JSON：
{
  "stories": [
    {
      "id": 11,
      "centralClaim": "一句话中心判断",
      "signal": {
        "title": "中文标题",
        "summary": "中文事实摘要",
        "why": "为什么重要",
        "impact": "审慎影响",
        "shiftFrom": "此前状态",
        "shiftTo": "当前变化",
        "crossValidation": "逐项说明来源贡献",
        "article": {
          "lead": "导语",
          "sections": [
            {"heading": "小标题", "body": "正文"},
            {"heading": "小标题", "body": "正文"},
            {"heading": "小标题", "body": "正文"}
          ],
          "outlook": "下一验证点"
        }
      },
      "translation": {
        "title": "English title",
        "summary": "English factual summary",
        "why": "Why it matters",
        "impact": "Measured impact",
        "shiftFrom": "Prior state",
        "shiftTo": "Current change",
        "crossValidation": "Source-specific evidence relationship",
        "article": {
          "lead": "Lead",
          "sections": [
            {"heading": "Heading", "body": "Body"},
            {"heading": "Heading", "body": "Body"},
            {"heading": "Heading", "body": "Body"}
          ],
          "outlook": "Next verification point"
        }
      },
      "newSources": [
        {
          "title": "Source title",
          "url": "https://...",
          "publisher": "Publisher",
          "publishedAt": "ISO 8601 or null",
          "sourceKind": "Official|IR|SEC|Media|Research",
          "summary": "Source-specific factual summary",
          "roleZh": "主张|佐证|背景|反例",
          "takeawayZh": "该来源具体提供的事实",
          "roleEn": "Claim|Support|Context|Counterpoint",
          "takeawayEn": "The specific fact supplied by this source"
        }
      ]
    }
  ]
}

输入：
${JSON.stringify(inputs)}`;
}

function buildCompanyPrompt(radar) {
  const inputs = radar.companySignals.map((signal, index) => ({
    id: `company-${index}`,
    entity: signal.entity,
    signalType: signal.signalType,
    stance: signal.stance,
    headline: signal.headline,
    whatChanged: signal.whatChanged,
    investmentRead: signal.investmentRead,
    catalyst: signal.catalyst,
    risk: signal.risk,
    watchNext: signal.watchNext,
    evidence: signal.evidence.map((evidence, evidenceIndex) => ({
      ref: evidence.ref,
      sourceName: evidence.sourceName,
      sourceKind: evidence.sourceKind,
      title: evidence.title,
      url: evidence.url,
      publishedAt: evidence.publishedAt,
      summary: cleanText(evidence.summary).slice(0, 1_200),
      takeaway:
        radar.translations.zh.companySignals[index]?.evidence?.[evidenceIndex]
          ?.takeaway ?? evidence.takeaway,
      englishTakeaway:
        radar.translations.en.companySignals[index]?.evidence?.[evidenceIndex]
          ?.takeaway,
    })),
  }));

  return `使用 live web search 研究并重写以下 All We Need「投资与公司信号」。它们目前只是短字段拼接，不是达到编辑标准的公司稿。

逐条执行：
- 保留 entity，但重新判断最值得写的 central claim。文章必须围绕一个发生变化的业务变量：demand、pricing、margin、capital intensity、competitive position、distribution、regulatory exposure 或 management credibility。
- 使用对应 research matrix 主动补齐 primary announcement、filing、official product or security record、reported actuals、可比基准、adoption evidence 和独立背景。
- 现有 Blog、Newsletter、YouTube 或社区来源只是输入证据，不自动等于事实。重要外部事实要回溯到一手来源，或由两个独立可靠来源确认。
- 如果原判断证据不足，缩小或重构判断；不得把“尚待验证”“单一来源假设”或研究过程写进正文。
- headline 与 lead 必须表达同一个中心判断。三段正文依次建立变化与可比状态、解释业务机制、给出最强反方解释。outlook 指向下一项具体 KPI、披露或事件。
- investmentRead 是审慎的公司价值或行业利润池含义，不得给投资建议。
- crossValidation 必须点名每条来源分别提供什么，以及它们如何连接或冲突。
- newSources 只返回现有 evidence 之外的 canonical 原文，优先 Official、IR、SEC、Regulator、Research、Repository；最多 5 条。搜索结果页和 snippet 不能作为来源。
- 中文保留 company、product、model、benchmark、API、AI、Agent、LLM、inference、open-source、workflow 等清晰的专有名词。
- 所有输入 id 必须原样返回。

只返回合法 JSON：
{
  "stories": [
    {
      "id": "company-0",
      "centralClaim": "一句话中心判断",
      "signal": {
        "signalType": "产品采用|竞争格局|平台扩张|资本事件|商业模式|风险",
        "stance": "偏积极|观察|分化|风险",
        "headline": "中文标题",
        "whatChanged": "此前状态到当前状态的具体变化",
        "investmentRead": "对公司价值、护城河或行业利润池的审慎含义",
        "catalyst": "强化判断的具体催化因素",
        "risk": "最强反方解释或反证",
        "watchNext": "下一项可观察 KPI、披露或事件",
        "crossValidation": "逐项说明来源贡献及其关系",
        "article": {
          "lead": "导语",
          "sections": [
            {"heading": "小标题", "body": "变化、此前状态与关键比较"},
            {"heading": "小标题", "body": "业务机制与公司含义"},
            {"heading": "小标题", "body": "最强反方解释及其影响"}
          ],
          "outlook": "下一验证点"
        }
      },
      "translation": {
        "signalType": "English taxonomy",
        "stance": "English stance",
        "headline": "English headline",
        "whatChanged": "Changed state",
        "investmentRead": "Measured company or profit-pool implication",
        "catalyst": "Concrete catalyst",
        "risk": "Strongest countercase",
        "watchNext": "Next observable KPI, disclosure, or event",
        "crossValidation": "Source-specific evidence relationship",
        "article": {
          "lead": "Lead",
          "sections": [
            {"heading": "Heading", "body": "Change, prior state, and comparison"},
            {"heading": "Heading", "body": "Business mechanism and company implication"},
            {"heading": "Heading", "body": "Strongest countercase and consequence"}
          ],
          "outlook": "Next verification point"
        }
      },
      "newSources": [
        {
          "title": "Source title",
          "url": "https://...",
          "publisher": "Publisher",
          "publishedAt": "ISO 8601 or null",
          "sourceKind": "Official|IR|SEC|Regulator|Research|Repository|Media",
          "summary": "该来源支持的具体事实与比较",
          "roleZh": "主张|佐证|背景|反例",
          "takeawayZh": "该来源具体提供的事实",
          "roleEn": "Claim|Support|Context|Counterpoint",
          "takeawayEn": "The specific fact supplied by this source"
        }
      ]
    }
  ]
}

输入：
${JSON.stringify(inputs)}`;
}

async function callModel({
  model,
  prompt,
  instructions,
  accessToken,
  accountId,
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
      instructions: modelTaskInstructions({
        model,
        task: "research",
        fallbackInstructions:
          `${instructions}\n\nResearch every supplied story with live web search and return only the requested JSON.`,
      }),
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: prompt }],
        },
      ],
      tools: [
        {
          type: "web_search",
          search_context_size: modelSearchContextSize({
            model,
            fallbackSize: "high",
          }),
          external_web_access: true,
        },
      ],
      tool_choice: "required",
      reasoning: {
        effort: modelReasoningEffort({
          model,
          task: "research",
          fallbackEffort: "high",
        }),
      },
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

function safeSource(source, generatedAt, existingUrls) {
  let url;
  try {
    url = new URL(cleanText(source?.url));
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol)) return null;
  if (
    /(?:^|\.)cls\.cn$|(?:^|\.)cailianpress\.com$/iu.test(url.hostname) ||
    existingUrls.has(url.toString())
  ) {
    return null;
  }
  const title = cleanText(source?.title).slice(0, 260);
  const publisher = cleanText(source?.publisher).slice(0, 120);
  const summary = cleanText(source?.summary).slice(0, 1_200);
  if (!title || !publisher || !summary) return null;
  existingUrls.add(url.toString());
  const publishedAt = Number.isFinite(Date.parse(source?.publishedAt ?? ""))
    ? new Date(source.publishedAt).toISOString()
    : generatedAt;
  return {
    ref: "",
    sourceId: "editorial-research",
    sourceName: publisher,
    sourcePublisher: publisher,
    sourceKind: [
      "Official",
      "IR",
      "SEC",
      "Regulator",
      "Media",
      "Research",
      "Repository",
    ].includes(source?.sourceKind)
      ? source.sourceKind
      : "Media",
    title,
    url: url.toString(),
    publishedAt,
    fetchedAt: generatedAt,
    summary,
    role: ["主张", "佐证", "背景", "反例"].includes(source?.roleZh)
      ? source.roleZh
      : "佐证",
    takeaway: cleanText(source?.takeawayZh).slice(0, 240),
    roleEn: cleanText(source?.roleEn).slice(0, 80) || "Support",
    takeawayEn: cleanText(source?.takeawayEn).slice(0, 300),
  };
}

function validate(raw, selected) {
  if (
    !Array.isArray(raw?.stories) ||
    raw.stories.length !== selected.length
  ) {
    throw new Error(`Expected ${selected.length} rewritten stories.`);
  }
  const expectedIds = new Set(selected.map(({ signal }) => String(signal.id)));
  return raw.stories.map((entry) => {
    if (!expectedIds.delete(String(entry?.id))) {
      throw new Error(`Unexpected or duplicate story id ${entry?.id}.`);
    }
    for (const [label, copy] of [
      ["zh", entry.signal],
      ["en", entry.translation],
    ]) {
      for (const field of [
        "title",
        "summary",
        "why",
        "impact",
        "shiftFrom",
        "shiftTo",
        "crossValidation",
      ]) {
        if (!cleanText(copy?.[field])) {
          throw new Error(`${label}.${entry.id}.${field} is missing.`);
        }
      }
    }
    return {
      id: String(entry.id),
      signal: {
        title: cleanText(entry.signal.title).slice(0, 140),
        summary: cleanText(entry.signal.summary).slice(0, 800),
        why: cleanText(entry.signal.why).slice(0, 600),
        impact: cleanText(entry.signal.impact).slice(0, 600),
        shiftFrom: cleanText(entry.signal.shiftFrom).slice(0, 240),
        shiftTo: cleanText(entry.signal.shiftTo).slice(0, 240),
        crossValidation: cleanText(entry.signal.crossValidation).slice(0, 1_200),
        article: completeArticle(entry.signal.article, `zh.${entry.id}`),
      },
      translation: {
        title: cleanText(entry.translation.title).slice(0, 180),
        summary: cleanText(entry.translation.summary).slice(0, 1_000),
        why: cleanText(entry.translation.why).slice(0, 800),
        impact: cleanText(entry.translation.impact).slice(0, 800),
        shiftFrom: cleanText(entry.translation.shiftFrom).slice(0, 300),
        shiftTo: cleanText(entry.translation.shiftTo).slice(0, 300),
        crossValidation: cleanText(entry.translation.crossValidation).slice(
          0,
          1_500,
        ),
        article: completeArticle(entry.translation.article, `en.${entry.id}`),
      },
      newSources: Array.isArray(entry.newSources)
        ? entry.newSources.slice(0, 4)
        : [],
    };
  });
}

function validateCompanyRewrite(raw, companySignals) {
  if (
    !Array.isArray(raw?.stories) ||
    raw.stories.length !== companySignals.length
  ) {
    throw new Error(
      `Expected ${companySignals.length} rewritten company signals.`,
    );
  }
  const expectedIds = new Set(
    companySignals.map((_, index) => `company-${index}`),
  );
  return raw.stories.map((entry) => {
    if (!expectedIds.delete(String(entry?.id))) {
      throw new Error(`Unexpected or duplicate company id ${entry?.id}.`);
    }
    for (const [label, copy] of [
      ["zh", entry.signal],
      ["en", entry.translation],
    ]) {
      for (const field of [
        "signalType",
        "stance",
        "headline",
        "whatChanged",
        "investmentRead",
        "catalyst",
        "risk",
        "watchNext",
        "crossValidation",
      ]) {
        if (!cleanText(copy?.[field])) {
          throw new Error(`${label}.${entry.id}.${field} is missing.`);
        }
      }
    }
    return {
      id: String(entry.id),
      signal: {
        signalType: cleanText(entry.signal.signalType).slice(0, 80),
        stance: cleanText(entry.signal.stance).slice(0, 80),
        headline: cleanText(entry.signal.headline).slice(0, 180),
        whatChanged: cleanText(entry.signal.whatChanged).slice(0, 220),
        investmentRead: cleanText(entry.signal.investmentRead).slice(0, 260),
        catalyst: cleanText(entry.signal.catalyst).slice(0, 180),
        risk: cleanText(entry.signal.risk).slice(0, 220),
        watchNext: cleanText(entry.signal.watchNext).slice(0, 180),
        crossValidation: cleanText(entry.signal.crossValidation).slice(
          0,
          1_500,
        ),
        article: completeArticle(entry.signal.article, `zh.${entry.id}`),
      },
      translation: {
        signalType: cleanText(entry.translation.signalType).slice(0, 100),
        stance: cleanText(entry.translation.stance).slice(0, 100),
        headline: cleanText(entry.translation.headline).slice(0, 220),
        whatChanged: cleanText(entry.translation.whatChanged).slice(0, 420),
        investmentRead: cleanText(entry.translation.investmentRead).slice(
          0,
          520,
        ),
        catalyst: cleanText(entry.translation.catalyst).slice(0, 320),
        risk: cleanText(entry.translation.risk).slice(0, 420),
        watchNext: cleanText(entry.translation.watchNext).slice(0, 320),
        crossValidation: cleanText(entry.translation.crossValidation).slice(
          0,
          1_800,
        ),
        article: completeArticle(
          entry.translation.article,
          `en.${entry.id}`,
        ),
      },
      newSources: Array.isArray(entry.newSources)
        ? entry.newSources.slice(0, 5)
        : [],
    };
  });
}

async function rewriteCompanySignals() {
  const radar = JSON.parse(await readFile(radarPath, "utf8"));
  if (!Array.isArray(radar.companySignals) || !radar.companySignals.length) {
    console.log("No company signals require editorial rewrite.");
    return;
  }
  const [auth, instructions] = await Promise.all([
    loadSubscriptionAuth(),
    loadEditorialSkill(),
  ]);
  const prompt = buildCompanyPrompt(radar);
  let result;
  let usedModel;
  let lastError;
  for (const model of preferredModels) {
    try {
      console.log(
        `Researching and rewriting ${radar.companySignals.length} company signals with ${model}...`,
      );
      result = validateCompanyRewrite(
        parseJsonOutput(
          await callModel({ model, prompt, instructions, ...auth }),
        ),
        radar.companySignals,
      );
      usedModel = model;
      break;
    } catch (error) {
      lastError = error;
      console.warn(
        `${model} company rewrite failed: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  }
  if (!result) {
    throw new Error("All company rewrite calls failed.", {
      cause: lastError,
    });
  }

  const generatedAt = new Date().toISOString();
  for (const rewrite of result) {
    const index = Number(rewrite.id.replace("company-", ""));
    const signal = radar.companySignals[index];
    if (!signal) {
      throw new Error(`Company signal ${rewrite.id} is unavailable.`);
    }
    const existingUrls = new Set(signal.evidence.map((item) => item.url));
    const newEvidence = rewrite.newSources
      .map((source) => safeSource(source, generatedAt, existingUrls))
      .filter(Boolean)
      .map((source, sourceIndex) => ({
        ...source,
        ref: `CR${index + 1}-${sourceIndex + 1}`,
      }));
    const mergedEvidence = [
      ...signal.evidence,
      ...newEvidence.map(
        ({ roleEn: _roleEn, takeawayEn: _takeawayEn, ...item }) => item,
      ),
    ];
    const sourceNames = [
      ...new Set(
        mergedEvidence.map(
          (item) => item.sourcePublisher ?? item.sourceName,
        ),
      ),
    ];
    const sourceKinds = [
      ...new Set(mergedEvidence.map((item) => item.sourceKind)),
    ];
    Object.assign(signal, rewrite.signal, {
      evidence: mergedEvidence,
      references: mergedEvidence.map(
        ({ role: _role, takeaway: _takeaway, ...item }) => item,
      ),
      sourceNames,
      sourceKinds,
      sourceCount: sourceNames.length,
      validationType:
        sourceKinds.length > 1 ? "跨平台验证" : "多账号验证",
      editorialRewrittenAt: generatedAt,
    });

    Object.assign(radar.translations.zh.companySignals[index], rewrite.signal, {
      evidence: [
        ...radar.translations.zh.companySignals[index].evidence,
        ...newEvidence.map((source) => ({
          ref: source.ref,
          sourceName: source.sourceName,
          sourceKind: source.sourceKind,
          originalTitle: source.title,
          takeaway: source.takeaway,
        })),
      ],
    });
    Object.assign(
      radar.translations.en.companySignals[index],
      rewrite.translation,
      {
        evidence: [
          ...radar.translations.en.companySignals[index].evidence,
          ...newEvidence.map((source) => ({
            ref: source.ref,
            sourceName: source.sourceName,
            sourceKind: source.sourceKind,
            originalTitle: source.title,
            takeaway: source.takeawayEn,
          })),
        ],
      },
    );
  }

  radar.generatedAt = generatedAt;
  radar.editorialCompanyRewrite = {
    generatedAt,
    model: usedModel,
    signalIds: result.map((item) => item.id),
  };
  await writeFile(radarPath, `${JSON.stringify(radar, null, 2)}\n`, "utf8");
  console.log(
    `Done: rewrote ${result.length} company signals with ${usedModel}.`,
  );
}

async function main() {
  const radar = JSON.parse(await readFile(radarPath, "utf8"));
  const requestedIds = new Set(
    (argumentValue("ids") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const selected = radar.signals
    .map((signal, index) => ({
      signal,
      index,
      zh: radar.translations.zh.signals[index],
      en: radar.translations.en.signals[index],
    }))
    .filter(({ signal }) =>
      requestedIds.size
        ? requestedIds.has(String(signal.id))
        : processNarration.test(articleText(signal.article)),
    );
  if (!selected.length) {
    console.log("No Radar stories require editorial rewrite.");
    return;
  }

  const [auth, instructions] = await Promise.all([
    loadSubscriptionAuth(),
    loadEditorialSkill(),
  ]);
  const prompt = buildPrompt(selected);
  let result;
  let usedModel;
  let lastError;
  for (const model of preferredModels) {
    try {
      console.log(
        `Researching and rewriting ${selected.length} stories with ${model}...`,
      );
      result = validate(
        parseJsonOutput(
          await callModel({ model, prompt, instructions, ...auth }),
        ),
        selected,
      );
      usedModel = model;
      break;
    } catch (error) {
      lastError = error;
      console.warn(
        `${model} editorial rewrite failed: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  }
  if (!result) {
    throw new Error("All editorial rewrite calls failed.", {
      cause: lastError,
    });
  }

  const generatedAt = new Date().toISOString();
  for (const rewrite of result) {
    const selectedStory = selected.find(
      ({ signal }) => String(signal.id) === rewrite.id,
    );
    const { signal, index } = selectedStory;
    const existingUrls = new Set(signal.evidence.map((item) => item.url));
    const newEvidence = rewrite.newSources
      .map((source) => safeSource(source, generatedAt, existingUrls))
      .filter(Boolean)
      .map((source, sourceIndex) => ({
        ...source,
        ref: `ER${signal.id}-${sourceIndex + 1}`,
      }));
    const mergedEvidence = [
      ...signal.evidence,
      ...newEvidence.map(
        ({ roleEn: _roleEn, takeawayEn: _takeawayEn, ...item }) => item,
      ),
    ];
    const sourceNames = [
      ...new Set(
        mergedEvidence.map(
          (item) => item.sourcePublisher ?? item.sourceName,
        ),
      ),
    ];
    const sourceKinds = [
      ...new Set(mergedEvidence.map((item) => item.sourceKind)),
    ];
    Object.assign(signal, rewrite.signal, {
      evidence: mergedEvidence,
      references: mergedEvidence.map(
        ({ role: _role, takeaway: _takeaway, ...item }) => item,
      ),
      sourceNames,
      sources: sourceKinds,
      sourceCount: sourceNames.length,
      validationType:
        sourceNames.length === 1
          ? "单一来源"
          : sourceKinds.length > 1
            ? "跨平台验证"
            : "多账号验证",
      editorialRewrittenAt: generatedAt,
    });

    const zh = radar.translations.zh.signals[index];
    Object.assign(zh, rewrite.signal, {
      evidence: [
        ...(zh.evidence ?? []),
        ...newEvidence.map((source) => ({
          role: source.role,
          takeaway: source.takeaway,
        })),
      ],
    });
    const en = radar.translations.en.signals[index];
    Object.assign(en, rewrite.translation, {
      evidence: [
        ...(en.evidence ?? []),
        ...newEvidence.map((source) => ({
          role: source.roleEn,
          takeaway: source.takeawayEn,
        })),
      ],
    });
  }

  radar.generatedAt = generatedAt;
  radar.editorialRewrite = {
    generatedAt,
    model: usedModel,
    storyIds: result.map((item) => Number(item.id)),
  };
  await writeFile(radarPath, `${JSON.stringify(radar, null, 2)}\n`, "utf8");
  console.log(
    `Done: rewrote ${result.length} stories with ${usedModel}.`,
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--company")) {
    await rewriteCompanySignals();
  } else {
    await main();
  }
}
