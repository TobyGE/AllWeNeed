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
const preferredModels = [
  process.env.SIGNAL_RADAR_MODEL?.trim(),
  "gpt-5.6-sol",
  "gpt-5.5",
].filter(Boolean);
const requestedChunkSize = Number(
  process.env.SIGNAL_RADAR_EXPLORE_REWRITE_CHUNK ?? 10,
);
const chunkSize =
  Number.isInteger(requestedChunkSize) && requestedChunkSize > 0
    ? Math.min(requestedChunkSize, 12)
    : 10;

function cleanText(value = "") {
  return String(value).replace(/\s+/g, " ").trim();
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
    return "Write one centered, source-backed thesis. Use uncertainty locally once; do not let caveats displace the article's central argument.";
  }
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

function buildPrompt(inputs, locale) {
  const languageRules =
    locale === "zh"
      ? `Write natural Simplified Chinese for technology and investment readers.
- Keep company, product, model, person, publication, platform, benchmark, protocol, API, AI, Agent, LLM, token, context, inference, open-source, workflow, moat, and margin in English where professionals naturally do so.
- Do not translate proper nouns. Do not sprinkle English into ordinary Chinese.`
      : `Write polished editorial English.
- Use direct prose and short paragraphs.
- Preserve uncertainty with words such as may, could, suggests, and inference.`;

  return `You are the Explore editor for All We Need.

Turn each supplied Explore thesis into a source-backed exploratory essay. Explore is intentionally bold, contrarian, and diverse, but it must never turn an inference into a reported fact.

${languageRules}

Editorial rules:
- Preserve input order and id exactly. Return all ${inputs.length} items.
- Use only the evidence attached to that Explore item. Do not add facts, names, numbers, dates, causal claims, or background from memory.
- The article must be cohesive editorial prose, not a concatenation of thesis, whyNow, and counterpoint.
- The article must have one central thesis. Spend roughly 70-80% of the essay establishing the evidence connection and mechanism.
- The three sections must do distinct jobs:
  1. establish the observable signal and the thesis it supports;
  2. explain the non-obvious mechanism or second-order consequence;
  3. contain the strongest counterargument and falsification conditions in one bounded section.
- crossValidation must say what each independent source contributes and how they connect. If there is only one source, explicitly call it a single-source hypothesis rather than cross-validation.
- Keep single-source status in crossValidation metadata only. Do not repeat “single-source hypothesis”, “not yet verified”, or missing-research narration in the lead, article sections, or outlook. Narrow the thesis when evidence is thin.
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

async function callSubscriptionModel({
  model,
  prompt,
  accessToken,
  accountId,
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
        `${instructions}\n\nReturn valid JSON only. Stay evidence-bound and preserve every Explore id and array order.`,
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

function validateOutput(inputs, raw, locale) {
  const items = raw?.exploreSignals;
  if (
    !Array.isArray(items) ||
    items.length !== inputs.length
  ) {
    throw new Error(
      `${locale}.exploreSignals must contain ${inputs.length} items.`,
    );
  }

  return items.map((item, index) => {
    const expectedId = inputs[index].id;
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
    const validated = {
      id: expectedId,
      crossValidation: cleanText(item.crossValidation).slice(0, 800),
      article: {
        lead: cleanText(item.article.lead).slice(0, 1000),
        sections,
        outlook: cleanText(item.article.outlook).slice(0, 800),
      },
    };
    if (
      /单一来源假设|尚待.{0,30}(?:验证|确认)|由于.{0,45}(?:没有|未).{0,45}(?:不作|无法|不能).{0,24}(?:判断|结论|beat|miss)|single-source hypothesis/iu.test(
        JSON.stringify(validated.article),
      )
    ) {
      throw new Error(
        `${locale}.${expectedId} narrates a research limitation.`,
      );
    }
    return validated;
  });
}

const radar = JSON.parse(await readFile(radarPath, "utf8"));
const auth = await loadSubscriptionAuth();
const editorialInstructions = await loadEditorialWritingSkill();
const editions = {};
const usedModels = {};

for (const locale of ["zh", "en"]) {
  const inputs = compactExplore(radar, locale);
  const localizedEditions = [];
  const localizedModels = [];
  for (let offset = 0; offset < inputs.length; offset += chunkSize) {
    const chunk = inputs.slice(offset, offset + chunkSize);
    const prompt = buildPrompt(chunk, locale);
    let chunkEdition;
    let lastError;
    for (const model of [...new Set(preferredModels)]) {
      try {
        console.log(
          `Writing ${locale} Explore articles ${offset + 1}-${offset + chunk.length}/${inputs.length} with ${model}...`,
        );
        const raw = parseJsonOutput(
          await callSubscriptionModel({
            model,
            prompt,
            ...auth,
            instructions: editorialInstructions,
          }),
        );
        chunkEdition = validateOutput(chunk, raw, locale);
        localizedModels.push(model);
        break;
      } catch (error) {
        lastError = error;
        console.warn(
          `${model} ${locale} Explore ${offset + 1}-${offset + chunk.length} failed: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }
    if (!chunkEdition) {
      throw new Error(
        `All ${locale} Explore expansion calls failed for ${offset + 1}-${offset + chunk.length}.`,
        { cause: lastError },
      );
    }
    localizedEditions.push(...chunkEdition);
  }
  editions[locale] = localizedEditions;
  usedModels[locale] = [...new Set(localizedModels)].join(", ");
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
