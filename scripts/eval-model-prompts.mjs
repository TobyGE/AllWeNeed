import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { modelTaskInstructions } from "./model-prompts.mjs";

const endpoint = "https://chatgpt.com/backend-api/codex/responses";
const authPath = resolve(homedir(), ".codex/auth.json");
const models = argumentList("models", [
  "gpt-5.6-terra",
  "gpt-5.6-luna",
]);
const tasks = argumentList("tasks", ["dynamic", "explore"]);
const reasoningEffort = argumentValue("effort") ?? "high";

const publicFacts = [
  "DeepSeek-V4-Flash-0731 API进入public beta，调用model name仍为deepseek-v4-flash。",
  "相较4月Preview，架构与尺寸不变，只进行re-post-training；官方称Agent能力增强。",
  "官方披露Terminal Bench 2.1为82.7、Cybergym为76.7、DeepSWE为54.4，尚无独立复测。",
  "API支持1M context、最高384K output、Responses API与Codex适配。",
  "公开权重为284B total、13B active，MIT license，可自托管。",
  "cache-miss input与output价格分别为每百万token 0.14美元和0.28美元，并发上限2500。",
];

function argumentList(name, fallback) {
  const prefix = `--${name}=`;
  const value = process.argv
    .find((argument) => argument.startsWith(prefix))
    ?.slice(prefix.length);
  return value
    ? value.split(",").map((item) => item.trim()).filter(Boolean)
    : fallback;
}

function argumentValue(name) {
  const prefix = `--${name}=`;
  return process.argv
    .find((argument) => argument.startsWith(prefix))
    ?.slice(prefix.length);
}

function promptForTask(task) {
  const facts = publicFacts.map((fact, index) => `E${index + 1}: ${fact}`).join("\n");
  if (task === "dynamic") {
    return `Write a Simplified Chinese Dynamic article using only this public evidence.
Return {"headline":"","lead":"","sections":[{"heading":"","body":""},{"heading":"","body":""},{"heading":"","body":""}],"outlook":""}.
Total length: 500-750 Chinese characters.

${facts}`;
  }
  if (task === "explore") {
    return `Write a Simplified Chinese Explore essay using only this public evidence.
Choose one non-obvious, falsifiable thesis about how open-weight Agent models
compete. Return {"headline":"","thesis":"","lead":"","sections":[{"heading":"","body":""},{"heading":"","body":""},{"heading":"","body":""}],"outlook":""}.
Total length: 550-800 Chinese characters.

${facts}`;
  }
  if (task === "research") {
    return `Use live web search to verify this public lead:
"DeepSeek-V4-Flash-0731 entered public beta with new Agent benchmarks,
Responses API/Codex support, published pricing, and open weights."

Return {"status":"researched|conflicted|unresolved","centralClaim":"",
"comparisons":"","unresolved":"","sources":[{"title":"","url":"",
"publisher":"","role":"Primary|Comparison|Context|Counterevidence",
"summary":""}]}. Use at most four canonical sources.`;
  }
  throw new Error(`Unsupported eval task: ${task}`);
}

async function loadAuth() {
  const auth = JSON.parse(await readFile(authPath, "utf8"));
  const tokens = auth.tokens ?? {};
  if (!tokens.access_token || !tokens.account_id) {
    throw new Error("ChatGPT subscription auth is unavailable");
  }
  return {
    accessToken: tokens.access_token,
    accountId: tokens.account_id,
  };
}

async function callModel({ model, task, auth }) {
  const startedAt = Date.now();
  const body = {
    model,
    instructions: modelTaskInstructions({
      model,
      task: task === "dynamic" ? "editorial" : task,
    }),
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: promptForTask(task) }],
      },
    ],
    reasoning: {
      effort: task === "research" ? "medium" : reasoningEffort,
    },
    stream: true,
    store: false,
  };
  if (task === "research") {
    body.tools = [
      {
        type: "web_search",
        search_context_size: "medium",
        external_web_access: true,
      },
    ];
    body.tool_choice = "required";
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${auth.accessToken}`,
      "chatgpt-account-id": auth.accountId,
      "content-type": "application/json",
      accept: "text/event-stream",
      "openai-beta": "responses=v1",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(task === "research" ? 180_000 : 120_000),
  });
  if (!response.ok) {
    throw new Error(
      `${model}/${task} HTTP ${response.status}: ${(await response.text()).slice(0, 400)}`,
    );
  }

  let buffer = "";
  let output = "";
  let usage = null;
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
      } else if (event.type === "response.completed") {
        usage = event.response?.usage ?? null;
      } else if (event.type === "response.failed") {
        throw new Error(
          `${model}/${task} failed: ${JSON.stringify(event).slice(0, 400)}`,
        );
      }
    }
  }

  const clean = output
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const result = JSON.parse(clean);
  return {
    model,
    task,
    latencyMs: Date.now() - startedAt,
    usage,
    diagnostics: diagnose(task, result),
    result,
  };
}

function diagnose(task, result) {
  const humanText = [
    result.headline,
    result.thesis,
    result.lead,
    ...(result.sections ?? []).flatMap((section) => [
      section.heading,
      section.body,
    ]),
    result.outlook,
  ]
    .filter(Boolean)
    .join(" ");
  const text = task === "research" ? JSON.stringify(result) : humanText;
  const caveatMentions =
    text.match(/独立复测|尚未|未验证|unresolved|not independently/giu)?.length ?? 0;
  const processNarration =
    /由于.{0,40}(?:没有|未).{0,40}(?:不作|无法|不能)|尚待更多来源验证|单一来源假设/iu.test(
      text,
    );
  const exposedRefs = /(?:^|[^\p{L}\p{N}])[ENR]\d+(?:[^\p{L}\p{N}]|$)/u.test(
    text,
  );
  const researchLabels =
    /(?:核心判断|事实|比较|编辑判断)\s*[:：]/u.test(text);
  const sections = result.sections ?? [];
  const headings = sections.map((section) => section.heading).filter(Boolean);
  const uniqueHeadings = new Set(headings).size;
  const missingNumbers =
    task === "research"
      ? []
      : ["82.7", "76.7", "54.4", "1M", "384K", "0.14", "0.28", "2500"]
          .filter((number) => !text.includes(number));
  const expectedTopLevelKeys =
    task === "dynamic"
      ? ["headline", "lead", "sections", "outlook"]
      : task === "explore"
        ? ["headline", "thesis", "lead", "sections", "outlook"]
        : ["status", "centralClaim", "comparisons", "unresolved", "sources"];
  const unexpectedKeys = Object.keys(result).filter(
    (key) => !expectedTopLevelKeys.includes(key),
  );
  return {
    validShape:
      task === "research"
        ? Array.isArray(result.sources)
        : sections.length === 3 && uniqueHeadings === 3,
    caveatMentions,
    processNarration,
    exposedRefs,
    researchLabels,
    missingNumbers,
    unexpectedKeys,
  };
}

const auth = await loadAuth();
const results = [];
for (const task of tasks) {
  for (const model of models) {
    try {
      results.push(await callModel({ model, task, auth }));
    } catch (error) {
      results.push({
        model,
        task,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
console.log(JSON.stringify(results, null, 2));
