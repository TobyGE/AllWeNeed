import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { modelRoutes } from "./model-routing.mjs";
import {
  modelReasoningEffort,
  modelTaskInstructions,
} from "./model-prompts.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultFeedPath = resolve(projectRoot, "data/live-feed.json");
const authPath = resolve(homedir(), ".codex/auth.json");
const endpoint = "https://chatgpt.com/backend-api/codex/responses";

function argumentValue(name, fallback) {
  const prefix = `--${name}=`;
  const value = process.argv.find((argument) =>
    argument.startsWith(prefix),
  );
  return resolve(projectRoot, value ? value.slice(prefix.length) : fallback);
}

function buildPrompt(items) {
  return `Translate these current-news headlines into natural Simplified Chinese.

Rules:
- Preserve every fact, number, uncertainty marker, company, product, model, person, and publication name.
- Keep established names and technical terms such as OpenAI, GPT, LLM, AI, API, GPU, open-weight, Agent, and benchmark in English when that is clearer.
- Translate the whole editorial proposition, not just isolated words.
- Do not summarize, embellish, explain, censor, or add punctuation-based labels.
- Keep array order and every id exactly unchanged.
- Return JSON only in this exact shape:
{"items":[{"id":"unchanged id","titleZh":"自然、简洁的中文标题"}]}

Input:
${JSON.stringify(items.map(({ id, title }) => ({ id, title })))}`;
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
        task: "localization",
        fallbackInstructions:
          "Translate the supplied headlines losslessly and return only valid JSON.",
      }),
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: prompt }],
        },
      ],
      reasoning: {
        effort: modelReasoningEffort({
          model,
          task: "localization",
          fallbackEffort: "low",
        }),
      },
      stream: true,
      store: false,
    }),
    signal: AbortSignal.timeout(90_000),
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
  if (start < 0 || end <= start) throw new Error("No JSON object returned.");
  return JSON.parse(unfenced.slice(start, end + 1));
}

export function mergeLiveTitleTranslations(items, result) {
  if (!Array.isArray(result?.items) || result.items.length !== items.length) {
    throw new Error("Live title localization returned the wrong item count.");
  }
  const translatedById = new Map();
  for (const [index, source] of items.entries()) {
    const translated = result.items[index];
    if (
      translated?.id !== source.id ||
      typeof translated.titleZh !== "string" ||
      !translated.titleZh.trim()
    ) {
      throw new Error(
        `Live title localization does not match item ${source.id}.`,
      );
    }
    translatedById.set(source.id, translated.titleZh.trim());
  }
  return items.map((item) => ({
    ...item,
    titleZh: translatedById.get(item.id),
  }));
}

async function main() {
  const feedPath = argumentValue("feed", "data/live-feed.json");
  const feed = JSON.parse(await readFile(feedPath, "utf8"));
  const missing = (feed.items ?? []).filter(
    (item) => !item.titleZh?.trim(),
  );
  if (!missing.length) {
    console.log(
      `Live title localization unchanged: ${feed.items.length} cached titles.`,
    );
    return;
  }

  const auth = await loadSubscriptionAuth();
  const prompt = buildPrompt(missing);
  let lastError;
  for (const model of [...new Set(modelRoutes.localization)]) {
    try {
      console.log(
        `Localizing ${missing.length} new Live titles with ${model}...`,
      );
      const localizedMissing = mergeLiveTitleTranslations(
        missing,
        parseJsonOutput(
          await callSubscriptionModel({ model, prompt, ...auth }),
        ),
      );
      const localizedById = new Map(
        localizedMissing.map((item) => [item.id, item.titleZh]),
      );
      feed.items = feed.items.map((item) => ({
        ...item,
        titleZh: item.titleZh ?? localizedById.get(item.id),
      }));
      feed.localizationModel = model;
      feed.localizedAt = new Date().toISOString();
      await writeFile(
        feedPath,
        `${JSON.stringify(feed, null, 2)}\n`,
        "utf8",
      );
      console.log(
        `Localized ${missing.length} new Live titles; ${feed.items.length} cached in the current window.`,
      );
      return;
    } catch (error) {
      lastError = error;
      console.warn(
        `${model} Live title localization failed: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  }
  throw new Error("All Live title localization model calls failed.", {
    cause: lastError,
  });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
