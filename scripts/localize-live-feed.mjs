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
  return `Evaluate these newly discovered items for All We Need's six-hour Live feed.

Rules:
- Include a concrete, current AI or core-technology event from a direct source.
- Include material releases, official lab or major-company announcements, security events, policy decisions, infrastructure changes, or original reporting with a concrete new fact.
- Exclude generic earnings or market chatter, promotion, paper explanations, unsupported speculation, pure opinion, minor commentary, stale non-events, and semantic duplicates.
- Priority affects ordering only; it must not be the sole reason to exclude a genuine new event.
- Preserve every id and array order. Return every input exactly once.
- Never rewrite the English title or URL.
- For include decisions, translate the complete source title into natural Simplified Chinese without adding facts.
- For exclude decisions, titleZh must be an empty string.
- reason must be one of: material_event, duplicate, opinion_or_explainer, generic_finance, promotion, stale_or_non_event, off_topic.
- Return JSON only in this exact shape:
{"items":[{"id":"unchanged id","decision":"include","titleZh":"忠实的中文标题","reason":"material_event"}]}

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
          "Strictly select material current AI and core-technology events, translate included source titles losslessly, account for every id, and return only valid JSON.",
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
    translatedById.set(source.id, translated.titleZh.trim());
  }
  return items.map((item) => ({
    ...item,
    titleZh: translatedById.get(item.id),
  }));
}

const liveDecisionReasons = new Set([
  "material_event",
  "duplicate",
  "opinion_or_explainer",
  "generic_finance",
  "promotion",
  "stale_or_non_event",
  "off_topic",
]);

export function applyLiveEditorialDecisions(
  items,
  result,
  { model, decidedAt },
) {
  if (!Array.isArray(result?.items) || result.items.length !== items.length) {
    throw new Error("Live editorial gate returned the wrong item count.");
  }
  const included = [];
  const excluded = [];
  for (const [index, source] of items.entries()) {
    const decision = result.items[index];
    if (
      decision?.id !== source.id ||
      !["include", "exclude"].includes(decision.decision) ||
      !liveDecisionReasons.has(decision.reason)
    ) {
      throw new Error(
        `Live editorial gate does not match item ${source.id}.`,
      );
    }
    if (decision.decision === "include") {
      if (
        decision.reason !== "material_event" ||
        typeof decision.titleZh !== "string" ||
        !decision.titleZh.trim()
      ) {
        throw new Error(
          `Included Live item ${source.id} has an invalid translation.`,
        );
      }
      included.push({
        ...source,
        titleZh: decision.titleZh.trim(),
        liveDecision: "include",
        liveDecisionModel: model,
        liveDecisionAt: decidedAt,
      });
      continue;
    }
    if (
      typeof decision.titleZh !== "string" ||
      decision.titleZh.trim()
    ) {
      throw new Error(
        `Excluded Live item ${source.id} must not have a translation.`,
      );
    }
    excluded.push({
      id: source.id,
      reason: decision.reason,
    });
  }
  return { included, excluded };
}

export function isLiveModelCoolingDown(feed, now = Date.now()) {
  const lastDecisionAt = Date.parse(feed?.liveDecisionAt ?? "");
  if (!Number.isFinite(lastDecisionAt)) return false;
  return (
    now - lastDecisionAt <
    liveModelCooldownMinutes * 60 * 1_000
  );
}

async function main() {
  const feedPath = argumentValue("feed", "data/live-feed.json");
  const feed = JSON.parse(await readFile(feedPath, "utf8"));
  const missing = (feed.items ?? []).filter(
    (item) =>
      !item.titleZh?.trim() ||
      item.liveDecision !== "include" ||
      !item.liveDecisionModel,
  );
  if (!missing.length) {
    if (feed.pendingItemCount) {
      feed.pendingItemCount = 0;
      await writeFile(
        feedPath,
        `${JSON.stringify(feed, null, 2)}\n`,
        "utf8",
      );
    }
    console.log(
      `Live editorial gate unchanged: ${feed.items.length} cached decisions; no GPT call.`,
    );
    return;
  }

  if (isLiveModelCoolingDown(feed)) {
    const pendingIds = new Set(missing.map((item) => item.id));
    feed.items = (feed.items ?? []).filter(
      (item) => !pendingIds.has(item.id),
    );
    feed.pendingItemCount = missing.length;
    await writeFile(
      feedPath,
      `${JSON.stringify(feed, null, 2)}\n`,
      "utf8",
    );
    console.log(
      `Queued ${missing.length} new Live items during the ${liveModelCooldownMinutes}-minute GPT cooldown; ${feed.items.length} cached items remain public.`,
    );
    return;
  }

  const auth = await loadSubscriptionAuth();
  const prompt = buildPrompt(missing);
  let lastError;
  for (const model of [...new Set(modelRoutes.live)]) {
    try {
      console.log(
        `Evaluating ${missing.length} new Live items with ${model}...`,
      );
      const decidedAt = new Date().toISOString();
      const { included, excluded } = applyLiveEditorialDecisions(
        missing,
        parseJsonOutput(
          await callSubscriptionModel({ model, prompt, ...auth }),
        ),
        { model, decidedAt },
      );
      const includedById = new Map(
        included.map((item) => [item.id, item]),
      );
      const excludedById = new Map(
        excluded.map((item) => [item.id, item]),
      );
      const missingIds = new Set(missing.map((item) => item.id));
      feed.items = feed.items.flatMap((item) => {
        if (!missingIds.has(item.id)) return [item];
        const accepted = includedById.get(item.id);
        return accepted ? [accepted] : [];
      });
      const currentExcluded = missing
        .filter((item) => excludedById.has(item.id))
        .map((item) => ({
          id: item.id,
          title: item.title,
          url: item.url,
          reason: excludedById.get(item.id).reason,
          liveDecisionModel: model,
          liveDecisionAt: decidedAt,
        }));
      const exclusionKey = (item) =>
        `${item.url?.trim() ?? ""}\n${item.title?.trim() ?? ""}`;
      feed.excludedItems = [
        ...(feed.excludedItems ?? []),
        ...currentExcluded,
      ].filter(
        (item, index, values) =>
          values.findIndex(
            (candidate) =>
              exclusionKey(candidate) === exclusionKey(item),
          ) === index,
      );
      feed.localizationModel = model;
      feed.localizedAt = decidedAt;
      feed.liveDecisionModel = model;
      feed.liveDecisionAt = decidedAt;
      feed.pendingItemCount = 0;
      await writeFile(
        feedPath,
        `${JSON.stringify(feed, null, 2)}\n`,
        "utf8",
      );
      console.log(
        `Live editorial gate included ${included.length}, excluded ${excluded.length}, and kept ${feed.items.length} items in the current window.`,
      );
      return;
    } catch (error) {
      lastError = error;
      console.warn(
        `${model} Live editorial gate failed: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  }
  throw new Error("All Live editorial gate model calls failed.", {
    cause: lastError,
  });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
