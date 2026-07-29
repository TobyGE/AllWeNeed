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

function cleanText(value = "") {
  return String(value).replace(/\s+/g, " ").trim();
}

function compactExplore(radar, locale) {
  const localized = radar.translations?.[locale]?.exploreSignals;
  if (
    !Array.isArray(localized) ||
    localized.length !== radar.exploreSignals.length
  ) {
    throw new Error(`Missing aligned ${locale} Explore copy.`);
  }

  return radar.exploreSignals.map((signal, index) => {
    const copy = localized[index];
    return {
      id: signal.id,
      category: copy.category,
      label: copy.label,
      title: copy.title,
      thesis: copy.thesis,
      whyNow: copy.whyNow,
      counterpoint: copy.counterpoint,
      horizon: copy.horizon,
      confidence: copy.confidence,
      validationType: signal.validationType,
      evidence: signal.evidence.map((evidence, evidenceIndex) => ({
        ref: evidence.ref,
        sourceName: evidence.sourceName,
        sourceKind: evidence.sourceKind,
        originalTitle: evidence.title,
        sourceSummary: cleanText(evidence.summary).slice(0, 520),
        takeaway:
          copy.evidence[evidenceIndex]?.takeaway ?? evidence.takeaway,
      })),
    };
  });
}

function buildPrompt(radar, locale) {
  const inputs = compactExplore(radar, locale);
  const languageRules =
    locale === "zh"
      ? `Write natural Simplified Chinese for technology and investment readers.
- Keep company, product, model, person, publication, platform, benchmark, protocol, API, AI, Agent, LLM, token, context, inference, open-source, workflow, moat, and margin in English where professionals naturally do so.
- Do not translate proper nouns. Do not sprinkle English into ordinary Chinese.`
      : `Write polished editorial English.
- Use direct prose and short paragraphs.
- Preserve uncertainty with words such as may, could, suggests, and inference.`;

  return `You are the Explore editor for Signal Radar.

Turn each supplied Explore thesis into a source-backed exploratory essay. Explore is intentionally bold, contrarian, and diverse, but it must never turn an inference into a reported fact.

${languageRules}

Editorial rules:
- Preserve input order and id exactly. Return all ${inputs.length} items.
- Use only the evidence attached to that Explore item. Do not add facts, names, numbers, dates, causal claims, or background from memory.
- The article must be cohesive editorial prose, not a concatenation of thesis, whyNow, and counterpoint.
- The three sections must do distinct jobs:
  1. identify the observable signal and what the sources actually report;
  2. explain the non-obvious connection or second-order thesis, clearly labeling editorial inference;
  3. present the strongest counterargument, uncertainty, and what would falsify the thesis.
- crossValidation must say what each independent source contributes and how they connect. If there is only one source, explicitly call it a single-source hypothesis rather than cross-validation.
- outlook must name observable developments that would strengthen or weaken the thesis within its stated horizon.
- Do not write investment advice or use inevitable future tense.

Return valid JSON only:
{
  "exploreSignals": [
    {
      "id": "explore-1",
      "crossValidation": "60-120 words or 80-160 Chinese characters",
      "article": {
        "lead": "90-150 words or 100-180 Chinese characters",
        "sections": [
          {
            "heading": "specific editorial heading",
            "body": "110-190 words or 140-260 Chinese characters"
          },
          {
            "heading": "specific editorial heading",
            "body": "110-190 words or 140-260 Chinese characters"
          },
          {
            "heading": "specific editorial heading",
            "body": "100-170 words or 130-230 Chinese characters"
          }
        ],
        "outlook": "70-120 words or 90-160 Chinese characters"
      }
    }
  ]
}

Input:
${JSON.stringify(inputs)}`;
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
        "Return valid JSON only. Stay evidence-bound and preserve every Explore id and array order.",
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
      `HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`,
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
          `response.failed: ${JSON.stringify(event).slice(0, 500)}`,
        );
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
  if (start < 0 || end <= start) {
    throw new Error("No JSON object returned.");
  }
  return JSON.parse(unfenced.slice(start, end + 1));
}

function validateOutput(radar, raw, locale) {
  const items = raw?.exploreSignals;
  if (
    !Array.isArray(items) ||
    items.length !== radar.exploreSignals.length
  ) {
    throw new Error(
      `${locale}.exploreSignals must contain ${radar.exploreSignals.length} items.`,
    );
  }

  return items.map((item, index) => {
    const expectedId = radar.exploreSignals[index].id;
    if (item?.id !== expectedId) {
      throw new Error(
        `${locale}.exploreSignals[${index}] expected ${expectedId}.`,
      );
    }
    if (
      !cleanText(item.crossValidation) ||
      !cleanText(item.article?.lead) ||
      !cleanText(item.article?.outlook) ||
      !Array.isArray(item.article?.sections) ||
      item.article.sections.length !== 3
    ) {
      throw new Error(`${locale}.${expectedId} has an incomplete article.`);
    }
    const sections = item.article.sections.map((section, sectionIndex) => {
      const heading = cleanText(section?.heading);
      const body = cleanText(section?.body);
      if (!heading || !body) {
        throw new Error(
          `${locale}.${expectedId}.sections[${sectionIndex}] is incomplete.`,
        );
      }
      return {
        heading: heading.slice(0, 120),
        body: body.slice(0, 1400),
      };
    });
    return {
      id: expectedId,
      crossValidation: cleanText(item.crossValidation).slice(0, 800),
      article: {
        lead: cleanText(item.article.lead).slice(0, 1000),
        sections,
        outlook: cleanText(item.article.outlook).slice(0, 800),
      },
    };
  });
}

const radar = JSON.parse(await readFile(radarPath, "utf8"));
const auth = await loadSubscriptionAuth();
const editions = {};
const usedModels = {};

for (const locale of ["zh", "en"]) {
  const prompt = buildPrompt(radar, locale);
  let lastError;
  for (const model of [...new Set(preferredModels)]) {
    try {
      console.log(`Writing ${locale} Explore articles with ${model}...`);
      const raw = parseJsonOutput(
        await callSubscriptionModel({ model, prompt, ...auth }),
      );
      editions[locale] = validateOutput(radar, raw, locale);
      usedModels[locale] = model;
      break;
    } catch (error) {
      lastError = error;
      console.warn(
        `${model} ${locale} Explore expansion failed: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  }
  if (!editions[locale]) {
    throw new Error(`All ${locale} Explore expansion calls failed.`, {
      cause: lastError,
    });
  }
}

for (const [index, signal] of radar.exploreSignals.entries()) {
  signal.crossValidation = editions.zh[index].crossValidation;
  signal.article = editions.zh[index].article;
  for (const locale of ["zh", "en"]) {
    Object.assign(radar.translations[locale].exploreSignals[index], {
      crossValidation: editions[locale][index].crossValidation,
      article: editions[locale][index].article,
    });
  }
}

radar.exploreArticleModels = usedModels;
await writeFile(radarPath, `${JSON.stringify(radar, null, 2)}\n`, "utf8");
console.log("Done: source-backed zh and en Explore articles added.");
