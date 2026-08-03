import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { modelRoutes } from "./model-routing.mjs";
import {
  modelReasoningEffort,
  modelTaskInstructions,
} from "./model-prompts.mjs";
import { globalModelCooldownMinutes } from "./update-policy.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultFeedPath = resolve(projectRoot, "data/live-feed.json");
const authPath = resolve(homedir(), ".codex/auth.json");
const endpoint = "https://chatgpt.com/backend-api/codex/responses";
export const liveModelCooldownMinutes = globalModelCooldownMinutes;

function argumentValue(name, fallback) {
  const prefix = `--${name}=`;
  const value = process.argv.find((argument) =>
    argument.startsWith(prefix),
  );
  return resolve(projectRoot, value ? value.slice(prefix.length) : fallback);
}

function buildPrompt(items) {
  return `Translate these already-selected items for All We Need's six-hour Live feed.

Rules:
- Every input item has already passed deterministic source, freshness, scope, and deduplication checks. Do not make an editorial include/exclude decision.
- Preserve every id and array order. Return every input exactly once.
- Never rewrite the English title or URL.
- Translate the complete source title into natural Simplified Chinese without adding, removing, or interpreting facts.
- Lead with the news subject or claim. Never mechanically begin a Chinese title with an unfamiliar surname plus “说” or “称” (for example, “朱说，…”). When an English title ends with a brief attribution and the input does not identify that person, preserve that it is a claim with neutral wording such as “被指” instead of inventing an identity or turning the opinion into fact.
- Return JSON only in this exact shape:
{"items":[{"id":"unchanged id","titleZh":"忠实的中文标题"}]}

Input:
${JSON.stringify(
  items.map(
    ({
      id,
      sourceName,
      sourceKind,
      title,
      url,
      publishedAt,
      prominence,
    }) => ({
      id,
      sourceName,
      sourceKind,
      title,
      url,
      publishedAt,
      prominence,
    }),
  ),
)}`;
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
        task: "live",
        fallbackInstructions:
          "Translate every supplied Live source title losslessly into Simplified Chinese, preserve every id and array order, make no editorial decision, and return only valid JSON.",
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
          task: "live",
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
    if (
      /,\s*["'’]?\s*[A-Z][\p{L}'’-]{1,30}\s+(?:says|said)\s*$/iu.test(
        source.title ?? "",
      ) &&
      /^[\p{Script=Han}]{1,4}(?:说|称)[，,:：]/u.test(
        translated.titleZh.trim(),
      )
    ) {
      throw new Error(
        `Live title localization has a dangling surname attribution for ${source.id}.`,
      );
    }
    if (
      /,\s*["'’]?\s*[A-Z][\p{L}'’-]{1,30}\s+(?:says|said)\s*$/iu.test(
        source.title ?? "",
      ) &&
      !/(?:被指|表示|认为|声称|指出|据|称|说|访谈)/u.test(
        translated.titleZh.trim(),
      )
    ) {
      throw new Error(
        `Live title localization dropped a material attribution for ${source.id}.`,
      );
    }
    translatedById.set(source.id, translated.titleZh.trim());
  }
  return items.map((item) => ({
    ...item,
    titleZh: translatedById.get(item.id),
  }));
}

export function isLiveLocalizationCoolingDown(feed, now = Date.now()) {
  const lastLocalizedAt = Date.parse(feed?.localizedAt ?? "");
  if (!Number.isFinite(lastLocalizedAt)) return false;
  return (
    now - lastLocalizedAt <
    liveModelCooldownMinutes * 60 * 1_000
  );
}

export function shouldDeferLiveLocalization(
  feed,
  { required = false, now = Date.now() } = {},
) {
  return !required && isLiveLocalizationCoolingDown(feed, now);
}

export function assertLiveLocalizationComplete(feed) {
  const missing = (feed.items ?? []).filter(
    (item) => !item.titleZh?.trim(),
  );
  if (missing.length || Number(feed.pendingItemCount ?? 0) > 0) {
    throw new Error(
      `Live localization is incomplete: ${missing.length} untranslated item(s).`,
    );
  }
}

function removeLegacyEditorialState(feed) {
  let changed = false;
  for (const key of [
    "excludedItems",
    "liveDecisionModel",
    "liveDecisionAt",
  ]) {
    if (key in feed) {
      delete feed[key];
      changed = true;
    }
  }
  for (const item of feed.items ?? []) {
    for (const key of [
      "liveDecision",
      "liveDecisionModel",
      "liveDecisionAt",
    ]) {
      if (key in item) {
        delete item[key];
        changed = true;
      }
    }
  }
  return changed;
}

async function main() {
  const feedPath = argumentValue("feed", "data/live-feed.json");
  const required = process.argv.includes("--required");
  const feed = JSON.parse(await readFile(feedPath, "utf8"));
  const removedLegacyState = removeLegacyEditorialState(feed);
  const missing = (feed.items ?? []).filter(
    (item) => !item.titleZh?.trim(),
  );
  if (!missing.length) {
    if (feed.pendingItemCount || removedLegacyState) {
      feed.pendingItemCount = 0;
      await writeFile(
        feedPath,
        `${JSON.stringify(feed, null, 2)}\n`,
        "utf8",
      );
    }
    console.log(
      `Live localization unchanged: ${feed.items.length} items already translated; no GPT call.`,
    );
    return;
  }

  if (shouldDeferLiveLocalization(feed, { required })) {
    feed.pendingItemCount = missing.length;
    await writeFile(
      feedPath,
      `${JSON.stringify(feed, null, 2)}\n`,
      "utf8",
    );
    console.log(
      `Kept ${missing.length} untranslated Live items public during the ${liveModelCooldownMinutes}-minute localization cooldown.`,
    );
    return;
  }

  let auth;
  try {
    auth = await loadSubscriptionAuth();
  } catch (error) {
    feed.pendingItemCount = missing.length;
    await writeFile(
      feedPath,
      `${JSON.stringify(feed, null, 2)}\n`,
      "utf8",
    );
    console.warn(
      `Live items remain public in English because localization credentials are unavailable: ${
        error instanceof Error ? error.message : error
      }`,
    );
    if (required) throw error;
    return;
  }
  const prompt = buildPrompt(missing);
  let lastError;
  for (const model of [...new Set(modelRoutes.live)]) {
    try {
      console.log(
        `Translating ${missing.length} new Live items with ${model}...`,
      );
      const localizedAt = new Date().toISOString();
      const translated = mergeLiveTitleTranslations(
        missing,
        parseJsonOutput(
          await callSubscriptionModel({ model, prompt, ...auth }),
        ),
      );
      const translatedById = new Map(
        translated.map((item) => [item.id, item.titleZh]),
      );
      feed.items = feed.items.map((item) =>
        translatedById.has(item.id)
          ? { ...item, titleZh: translatedById.get(item.id) }
          : item,
      );
      feed.localizationModel = model;
      feed.localizedAt = localizedAt;
      feed.pendingItemCount = 0;
      await writeFile(
        feedPath,
        `${JSON.stringify(feed, null, 2)}\n`,
        "utf8",
      );
      console.log(
        `Live localization translated ${translated.length} items and kept all ${feed.items.length} deterministic selections public.`,
      );
      return;
    } catch (error) {
      lastError = error;
      console.warn(
        `${model} Live localization failed: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  }
  feed.pendingItemCount = missing.length;
  await writeFile(
    feedPath,
    `${JSON.stringify(feed, null, 2)}\n`,
    "utf8",
  );
  console.warn(
    `All Live localization model calls failed; ${missing.length} items remain public in English: ${
      lastError instanceof Error ? lastError.message : lastError
    }`,
  );
  if (required) {
    throw new Error(
      `Required Live localization failed for ${missing.length} item(s).`,
      { cause: lastError },
    );
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
