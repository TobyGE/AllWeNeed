import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const radarPath = resolve(projectRoot, "data/daily-radar.json");
const authPath = resolve(homedir(), ".codex/auth.json");
const endpoint = "https://chatgpt.com/backend-api/codex/responses";
const preferredModels = [
  process.env.SIGNAL_RADAR_MODEL?.trim(),
  "gpt-5.6-sol",
  "gpt-5.5",
].filter(Boolean);

function compactRadar(radar) {
  return {
    editorNote: radar.editorNote,
    signals: radar.signals.map((signal) => ({
      category: signal.category,
      eyebrow: signal.eyebrow,
      title: signal.title,
      summary: signal.summary,
      why: signal.why,
      impact: signal.impact,
      shiftFrom: signal.shiftFrom,
      shiftTo: signal.shiftTo,
      crossValidation: signal.crossValidation,
      evidence: signal.evidence.map((item) => ({
        ref: item.ref,
        sourceName: item.sourceName,
        sourceKind: item.sourceKind,
        originalTitle: item.title,
        role: item.role,
        takeaway: item.takeaway,
      })),
    })),
    exploreSignals: radar.exploreSignals.map((signal) => ({
      category: signal.category,
      label: signal.label,
      title: signal.title,
      thesis: signal.thesis,
      whyNow: signal.whyNow,
      counterpoint: signal.counterpoint,
      horizon: signal.horizon,
      confidence: signal.confidence,
      evidence: signal.evidence.map((item) => ({
        ref: item.ref,
        sourceName: item.sourceName,
        sourceKind: item.sourceKind,
        originalTitle: item.title,
        takeaway: item.takeaway,
      })),
    })),
    trends: radar.trends.map(({ name, change }) => ({ name, change })),
    discoveries: radar.discoveries.map(({ name, detail, source }) => ({
      name,
      detail,
      source,
    })),
    investmentThesis: {
      quote: radar.investmentThesis.quote,
      confidence: radar.investmentThesis.confidence,
    },
    companySignals: radar.companySignals.map((signal) => ({
      entity: signal.entity,
      signalType: signal.signalType,
      stance: signal.stance,
      headline: signal.headline,
      whatChanged: signal.whatChanged,
      investmentRead: signal.investmentRead,
      catalyst: signal.catalyst,
      risk: signal.risk,
      watchNext: signal.watchNext,
      evidence: signal.evidence.map((item) => ({
        ref: item.ref,
        sourceName: item.sourceName,
        sourceKind: item.sourceKind,
        originalTitle: item.title,
        takeaway: item.takeaway,
      })),
    })),
  };
}

function buildPrompt(radar) {
  return `You are the bilingual copy editor for Signal Radar, an AI, technology, and investment intelligence product.

Create two parallel editorial versions of the supplied analysis:

1. "zh": natural Simplified Chinese with deliberate English code-switching.
2. "en": polished, concise editorial English.

Chinese style rules:
- NEVER translate company, product, model, person, publication, platform, benchmark, protocol, or API names.
- Keep standard industry terms in English when Chinese professionals naturally use them: AI, Agent, LLM, token, context, cache, inference, benchmark, open-source, open-weight, API, workflow, product-market fit, moat, margin, hyperscaler.
- Prefer phrases like "AI coding 工具的 benchmark" over stiff fully translated jargon.
- Do not sprinkle English randomly into ordinary Chinese. Code-switch only for proper nouns and established technical/business terms.
- Treat category, eyebrow, label, signalType, stance, horizon, confidence, and evidence role as interface taxonomy. These fields must use concise Simplified Chinese, except for true proper nouns such as AI, GPT, X, YouTube, company names, product names, and model names.
- In those interface-taxonomy fields, translate generic terms such as Agent to 智能体, Models to 模型, Compute to 算力, Risk to 风险, Watch to 观察, and Product signal to 产品信号. Use Chinese punctuation and “与”, never “&”.
- Keep numbers and factual meaning unchanged.

English style rules:
- Rewrite naturally; do not mirror Chinese word order.
- Preserve uncertainty markers such as "may", "could", and "inference".
- Keep titles punchy and body text compact.

Evidence rules:
- Do not add facts, names, numbers, or conclusions.
- Preserve every sourceName, sourceKind, ref, and originalTitle exactly.
- Preserve array order and array lengths exactly.
- Only rewrite human-facing text fields.

Return valid JSON only with this exact top-level shape:
{
  "zh": {
    "editorNote": "...",
    "signals": [{
      "category": "...", "eyebrow": "...", "title": "...", "summary": "...",
      "why": "...", "impact": "...", "shiftFrom": "...", "shiftTo": "...",
      "crossValidation": "...",
      "evidence": [{"ref": "I1", "role": "...", "takeaway": "..."}]
    }],
    "exploreSignals": [{
      "category": "...", "label": "...", "title": "...", "thesis": "...",
      "whyNow": "...", "counterpoint": "...", "horizon": "...", "confidence": "...",
      "evidence": [{"ref": "I1", "takeaway": "..."}]
    }],
    "trends": [{"name": "..."}],
    "discoveries": [{"name": "...", "detail": "..."}],
    "investmentThesis": {"quote": "...", "confidence": "..."},
    "companySignals": [{
      "signalType": "...", "stance": "...", "headline": "...", "whatChanged": "...",
      "investmentRead": "...", "catalyst": "...", "risk": "...", "watchNext": "...",
      "evidence": [{"ref": "I1", "takeaway": "..."}]
    }]
  },
  "en": {
    "editorNote": "...",
    "signals": [{
      "category": "...", "eyebrow": "...", "title": "...", "summary": "...",
      "why": "...", "impact": "...", "shiftFrom": "...", "shiftTo": "...",
      "crossValidation": "...",
      "evidence": [{"ref": "I1", "role": "...", "takeaway": "..."}]
    }],
    "exploreSignals": [{
      "category": "...", "label": "...", "title": "...", "thesis": "...",
      "whyNow": "...", "counterpoint": "...", "horizon": "...", "confidence": "...",
      "evidence": [{"ref": "I1", "takeaway": "..."}]
    }],
    "trends": [{"name": "..."}],
    "discoveries": [{"name": "...", "detail": "..."}],
    "investmentThesis": {"quote": "...", "confidence": "..."},
    "companySignals": [{
      "signalType": "...", "stance": "...", "headline": "...", "whatChanged": "...",
      "investmentRead": "...", "catalyst": "...", "risk": "...", "watchNext": "...",
      "evidence": [{"ref": "I1", "takeaway": "..."}]
    }]
  }
}

Input:
${JSON.stringify(compactRadar(radar))}`;
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
        "Return only valid JSON. Preserve facts, proper nouns, array order, and evidence refs exactly.",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: prompt }],
        },
      ],
      reasoning: { effort: "low" },
      stream: true,
      store: false,
    }),
    signal: AbortSignal.timeout(240_000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
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
        throw new Error(`response.failed: ${JSON.stringify(event).slice(0, 500)}`);
      }
    }
  }
  return output;
}

function parseJsonOutput(text) {
  const unfenced = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("No JSON object returned.");
  return JSON.parse(unfenced.slice(start, end + 1));
}

function assertParallel(radar, translations) {
  for (const locale of ["zh", "en"]) {
    const copy = translations?.[locale];
    if (!copy) throw new Error(`Missing ${locale} translation.`);
    for (const key of ["signals", "exploreSignals", "trends", "discoveries", "companySignals"]) {
      if (!Array.isArray(copy[key]) || copy[key].length !== radar[key].length) {
        throw new Error(`${locale}.${key} does not match source length.`);
      }
    }
    for (const [index, signal] of radar.signals.entries()) {
      if (copy.signals[index].evidence?.length !== signal.evidence.length) {
        throw new Error(`${locale}.signals[${index}].evidence does not match.`);
      }
    }
    for (const [index, signal] of radar.exploreSignals.entries()) {
      if (copy.exploreSignals[index].evidence?.length !== signal.evidence.length) {
        throw new Error(`${locale}.exploreSignals[${index}].evidence does not match.`);
      }
    }
    for (const [index, signal] of radar.companySignals.entries()) {
      if (copy.companySignals[index].evidence?.length !== signal.evidence.length) {
        throw new Error(`${locale}.companySignals[${index}].evidence does not match.`);
      }
    }
  }
}

const radar = JSON.parse(await readFile(radarPath, "utf8"));
const prompt = buildPrompt(radar);
const auth = await loadSubscriptionAuth();
let translations;
let usedModel;
let lastError;

for (const model of [...new Set(preferredModels)]) {
  try {
    console.log(`Localizing radar with ${model}...`);
    translations = parseJsonOutput(
      await callSubscriptionModel({ model, prompt, ...auth }),
    );
    assertParallel(radar, translations);
    usedModel = model;
    break;
  } catch (error) {
    lastError = error;
    console.warn(
      `${model} localization failed: ${error instanceof Error ? error.message : error}`,
    );
  }
}

if (!translations) {
  throw new Error("All localization model calls failed.", { cause: lastError });
}

radar.translations = translations;
radar.localizationModel = usedModel;
await writeFile(radarPath, `${JSON.stringify(radar, null, 2)}\n`, "utf8");
console.log("Done: zh mixed-language and en editions added.");
