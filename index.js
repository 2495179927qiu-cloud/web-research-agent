require("dotenv").config();

const cheerio = require("cheerio");
const readline = require("node:readline/promises");
const { stdin: input, stdout: output } = require("node:process");

function normalizeBaseUrl(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) {
    return "";
  }

  const noTrailing = trimmed.replace(/\/+$/, "");
  try {
    const parsed = new URL(noTrailing);
    if (!parsed.pathname || parsed.pathname === "/") {
      return `${noTrailing}/v1`;
    }
  } catch {
    return noTrailing;
  }
  return noTrailing;
}

const RAW_BASE_URL = process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE || "";
const API_BASE_URL = normalizeBaseUrl(RAW_BASE_URL) || "https://api.openai.com/v1";
const DEFAULT_MODEL = API_BASE_URL.includes("api.openai.com") ? "gpt-4.1-mini" : "gpt-5.1";
let ACTIVE_MODEL = process.env.OPENAI_MODEL || DEFAULT_MODEL;

const MAX_AGENT_STEPS = Number(process.env.MAX_AGENT_STEPS || 6);
const SEARCH_RESULTS = Number(process.env.SEARCH_RESULTS || 6);
const PAGE_MAX_CHARS = Number(process.env.PAGE_MAX_CHARS || 12000);
const MAX_HISTORY_MESSAGES = 24;
const WEB_TIMEOUT_MS = Number(process.env.WEB_TIMEOUT_MS || 15000);
const MODEL_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 120000);
const OPENAI_MAX_RETRIES = Number(process.env.OPENAI_MAX_RETRIES || 2);

if (!process.env.OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY. Add it in .env then retry.");
  process.exit(1);
}

const TOOL_DEFINITIONS = [
  {
    type: "function",
    name: "search_web",
    description: "Search the public web for recent or factual information and return candidate pages.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query.",
        },
        max_results: {
          type: "integer",
          description: "Max search results to return (1-8).",
          minimum: 1,
          maximum: 8,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "fetch_page",
    description: "Fetch a webpage and extract readable text content so you can ground your answer.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The URL to fetch.",
        },
        max_chars: {
          type: "integer",
          description: "Max text length to return (500-40000).",
          minimum: 500,
          maximum: 40000,
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
];

const SYSTEM_PROMPT = `
你是一个“可联网研究”的问答助手。

行为准则：
1. 涉及事实、数据、时效性信息时，优先调用工具搜索并阅读页面，再回答。
2. 不要编造来源。只引用你实际检索到的网页。
3. 回答使用简体中文，并在结尾给出“参考来源”列表，格式为 Markdown 链接。
4. 当信息存在不确定性或冲突时，要明确写出不确定点。
5. 若用户只是闲聊或主观问题，可直接回答，不必强制检索。
`;

function clipText(value, maxChars) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

function normalizeUrl(rawUrl) {
  let candidate = String(rawUrl || "").trim();
  if (!candidate) {
    throw new Error("url is required");
  }

  if (!/^https?:\/\//i.test(candidate)) {
    candidate = `https://${candidate}`;
  }

  const parsed = new URL(candidate);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("only http/https URLs are supported");
  }
  return parsed.toString();
}

function decodeHtmlText(value) {
  if (!value) {
    return "";
  }
  return cheerio.load(`<div>${value}</div>`)("div").text().trim();
}

async function fetchWithTimeout(url, options = {}, timeoutMs = WEB_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function extractTextFromHtml(html) {
  const $ = cheerio.load(html);
  $("script,style,noscript,iframe,svg,canvas,form,nav,footer,header,aside").remove();

  const title = clipText($("title").first().text(), 200);
  const bodyText = clipText($("body").text(), 500000);
  return { title, text: bodyText };
}

async function searchWeb({ query, max_results }) {
  const q = clipText(query, 300);
  if (!q) {
    throw new Error("query cannot be empty");
  }

  const maxResults = Number(max_results || SEARCH_RESULTS);
  const count = Number.isFinite(maxResults)
    ? Math.min(Math.max(maxResults, 1), 8)
    : SEARCH_RESULTS;

  const searchUrl = new URL("https://www.bing.com/search");
  searchUrl.searchParams.set("q", q);

  const response = await fetchWithTimeout(searchUrl.toString(), {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  if (!response.ok) {
    throw new Error(`search request failed: HTTP ${response.status}`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);
  const results = [];
  const seen = new Set();

  $("li.b_algo, .b_algo").each((_, element) => {
    if (results.length >= count) {
      return;
    }

    const anchor = $(element).find("h2 a").first();
    const url = anchor.attr("href");
    if (!url || !/^https?:\/\//i.test(url) || seen.has(url)) {
      return;
    }
    seen.add(url);

    const title = clipText(decodeHtmlText(anchor.text()), 200);
    const snippet = clipText(
      decodeHtmlText(
        $(element).find(".b_caption p").first().text() || $(element).find("p").first().text(),
      ),
      400,
    );
    results.push({ title, url, snippet });
  });

  return {
    query: q,
    engine: "bing",
    results_count: results.length,
    results,
  };
}

async function fetchViaJina(url, maxChars) {
  const noProtocol = url.replace(/^https?:\/\//i, "");
  const jinaUrl = `https://r.jina.ai/http://${noProtocol}`;
  const response = await fetchWithTimeout(
    jinaUrl,
    {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "text/plain,text/markdown",
      },
    },
    WEB_TIMEOUT_MS,
  );

  if (!response.ok) {
    throw new Error(`jina fallback failed: HTTP ${response.status}`);
  }

  const text = clipText(await response.text(), maxChars);
  return {
    url,
    title: "",
    text,
    method: "jina_fallback",
    fetched_at: new Date().toISOString(),
  };
}

async function fetchPage({ url, max_chars }) {
  const pageUrl = normalizeUrl(url);
  const maxCharsRaw = Number(max_chars || PAGE_MAX_CHARS);
  const maxChars = Number.isFinite(maxCharsRaw)
    ? Math.min(Math.max(maxCharsRaw, 500), 40000)
    : PAGE_MAX_CHARS;

  try {
    const response = await fetchWithTimeout(
      pageUrl,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,text/plain",
          "Accept-Language": "en-US,en;q=0.9",
        },
        redirect: "follow",
      },
      WEB_TIMEOUT_MS,
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const contentType = response.headers.get("content-type") || "";
    const raw = await response.text();
    if (!raw) {
      throw new Error("empty response body");
    }

    if (contentType.includes("html")) {
      const extracted = extractTextFromHtml(raw);
      if (extracted.text.length < 200) {
        throw new Error("insufficient text from HTML extraction");
      }
      return {
        url: pageUrl,
        title: extracted.title,
        text: clipText(extracted.text, maxChars),
        method: "direct_html",
        fetched_at: new Date().toISOString(),
      };
    }

    return {
      url: pageUrl,
      title: "",
      text: clipText(raw, maxChars),
      method: "direct_text",
      fetched_at: new Date().toISOString(),
    };
  } catch {
    return fetchViaJina(pageUrl, maxChars);
  }
}

const TOOL_HANDLERS = {
  search_web: searchWeb,
  fetch_page: fetchPage,
};

function safeParseJson(jsonText) {
  try {
    return JSON.parse(jsonText || "{}");
  } catch {
    return {};
  }
}

function getCallName(call) {
  return call.name || call.function?.name || "";
}

function getCallArgs(call) {
  return call.arguments || call.function?.arguments || "{}";
}

async function runToolCall(toolCall) {
  const toolName = getCallName(toolCall);
  const handler = TOOL_HANDLERS[toolName];

  if (!handler) {
    return {
      ok: false,
      error: `unknown tool: ${toolName}`,
    };
  }

  const args = safeParseJson(getCallArgs(toolCall));
  console.log(`[tool] ${toolName} ${JSON.stringify(args)}`);

  try {
    const result = await handler(args);
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

function trimHistory(messages) {
  if (messages.length <= MAX_HISTORY_MESSAGES) {
    return messages;
  }
  return messages.slice(messages.length - MAX_HISTORY_MESSAGES);
}

function modelRequestHeaders() {
  const headers = {
    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
  };

  if (!API_BASE_URL.includes("api.openai.com")) {
    try {
      const base = new URL(API_BASE_URL);
      const origin = `${base.protocol}//${base.host}`;
      headers.Origin = origin;
      headers.Referer = `${origin}/`;
    } catch {
      // Ignore header enrichment errors for invalid custom base URLs.
    }
  }

  return headers;
}

function parseApiError(rawText) {
  const text = String(rawText || "").trim();
  try {
    const parsed = JSON.parse(text);
    if (parsed?.error?.message) {
      return parsed.error.message;
    }
    if (parsed?.message) {
      return parsed.message;
    }
  } catch {
    // Ignore non-JSON payloads.
  }
  return clipText(text || "unknown error", 300);
}

function isRetriableStatus(statusCode) {
  return [408, 409, 429, 500, 502, 503, 504].includes(statusCode);
}

function isRetriableNetworkError(error) {
  const message = String(error?.message || error || "");
  return /aborted|timeout|fetch failed|network|econn|und_err/i.test(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callResponsesApi(payload) {
  const endpoint = `${API_BASE_URL.replace(/\/+$/, "")}/responses`;
  let lastError;

  for (let attempt = 0; attempt <= OPENAI_MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetchWithTimeout(
        endpoint,
        {
          method: "POST",
          headers: modelRequestHeaders(),
          body: JSON.stringify(payload),
        },
        MODEL_TIMEOUT_MS,
      );

      const raw = await response.text();
      if (!response.ok) {
        const error = new Error(`model request failed: HTTP ${response.status} ${parseApiError(raw)}`);
        if (isRetriableStatus(response.status) && attempt < OPENAI_MAX_RETRIES) {
          await sleep(1000 * (attempt + 1));
          continue;
        }
        throw error;
      }

      try {
        return JSON.parse(raw);
      } catch {
        throw new Error(`model request failed: invalid JSON response (${clipText(raw, 200)})`);
      }
    } catch (error) {
      lastError = error;
      if (isRetriableNetworkError(error) && attempt < OPENAI_MAX_RETRIES) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error("model request failed");
}

function extractFunctionCalls(modelResponse) {
  const output = Array.isArray(modelResponse?.output) ? modelResponse.output : [];
  const calls = [];

  for (const item of output) {
    if (item?.type !== "function_call") {
      continue;
    }

    calls.push({
      id: item.call_id || item.id,
      name: item.name || "",
      arguments: item.arguments || "{}",
    });
  }

  return calls.filter((call) => call.id && call.name);
}

function extractAssistantText(modelResponse) {
  if (typeof modelResponse?.output_text === "string" && modelResponse.output_text.trim()) {
    return modelResponse.output_text.trim();
  }

  const output = Array.isArray(modelResponse?.output) ? modelResponse.output : [];
  const chunks = [];

  for (const item of output) {
    if (item?.type === "output_text" && item.text) {
      chunks.push(String(item.text));
      continue;
    }

    if (item?.type === "message" && Array.isArray(item.content)) {
      for (const contentItem of item.content) {
        if (contentItem?.type === "output_text" && contentItem.text) {
          chunks.push(String(contentItem.text));
        } else if (typeof contentItem?.text === "string") {
          chunks.push(contentItem.text);
        }
      }
    }
  }

  return chunks.join("\n").trim();
}

function formatToolOutputs(toolOutputs, maxChars = 50000) {
  const lines = [];
  for (const item of toolOutputs) {
    lines.push(`[call_id=${item.call_id}]`);
    lines.push(String(item.output || ""));
    lines.push("");
  }
  return clipText(lines.join("\n"), maxChars);
}

async function synthesizeFromToolOutputs(userQuestion, toolOutputs) {
  const evidence = formatToolOutputs(toolOutputs);
  const response = await callResponsesApi({
    model: ACTIVE_MODEL,
    input: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `用户问题：${userQuestion}\n\n以下是工具返回的检索资料（JSON）：\n${evidence}\n\n请基于这些资料回答，并附上参考来源链接。`,
      },
    ],
    temperature: 0.2,
  });

  return extractAssistantText(response) || "没有生成可读答案。";
}

async function fetchAvailableModels() {
  const endpoint = `${API_BASE_URL.replace(/\/+$/, "")}/models`;
  const response = await fetchWithTimeout(
    endpoint,
    {
      headers: modelRequestHeaders(),
    },
    30000,
  );

  if (!response.ok) {
    return [];
  }

  try {
    const payload = await response.json();
    return Array.isArray(payload?.data)
      ? payload.data.map((item) => item?.id).filter((id) => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

async function ensureActiveModel() {
  const models = await fetchAvailableModels();
  if (!models.length) {
    return;
  }

  if (models.includes(ACTIVE_MODEL)) {
    return;
  }

  ACTIVE_MODEL = models[0];
  console.log(`[model] OPENAI_MODEL unavailable; switched to ${ACTIVE_MODEL}`);
}

async function askAgent(userQuestion, history = []) {
  const seedInput = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.map((message) => ({
      role: message.role,
      content: String(message.content || ""),
    })),
    { role: "user", content: userQuestion },
  ];

  let modelResponse = await callResponsesApi({
    model: ACTIVE_MODEL,
    input: seedInput,
    tools: TOOL_DEFINITIONS,
    temperature: 0.2,
  });

  for (let step = 1; step <= MAX_AGENT_STEPS; step += 1) {
    const calls = extractFunctionCalls(modelResponse);
    if (!calls.length) {
      const answer = extractAssistantText(modelResponse) || "没有生成可读答案。";
      return {
        answer,
        history: trimHistory([
          ...history,
          { role: "user", content: userQuestion },
          { role: "assistant", content: answer },
        ]),
      };
    }

    if (!modelResponse.id) {
      throw new Error("model response missing id; cannot continue tool loop");
    }

    const toolOutputs = [];
    for (const call of calls) {
      const result = await runToolCall(call);
      toolOutputs.push({
        type: "function_call_output",
        call_id: call.id,
        output: JSON.stringify(result),
      });
    }

    try {
      modelResponse = await callResponsesApi({
        model: ACTIVE_MODEL,
        previous_response_id: modelResponse.id,
        input: toolOutputs,
        tools: TOOL_DEFINITIONS,
        temperature: 0.2,
      });
    } catch {
      const answer = await synthesizeFromToolOutputs(userQuestion, toolOutputs);
      return {
        answer,
        history: trimHistory([
          ...history,
          { role: "user", content: userQuestion },
          { role: "assistant", content: answer },
        ]),
      };
    }
  }

  throw new Error(`agent reached max steps (${MAX_AGENT_STEPS}). Increase MAX_AGENT_STEPS if needed.`);
}

async function runSingleQuestion(question) {
  const { answer } = await askAgent(question, []);
  console.log(answer);
}

async function runInteractive() {
  console.log(`Web Research Agent running with model: ${ACTIVE_MODEL}`);
  console.log(`OpenAI base URL: ${API_BASE_URL}`);
  console.log("输入问题开始对话；输入 exit / quit / 退出 结束。");

  let history = [];
  const rl = readline.createInterface({ input, output });

  try {
    while (true) {
      const question = (await rl.question("\n你> ")).trim();
      if (!question) {
        continue;
      }

      const normalized = question.toLowerCase();
      if (normalized === "exit" || normalized === "quit" || normalized === "退出") {
        break;
      }

      try {
        const result = await askAgent(question, history);
        history = result.history;
        console.log(`\nAgent> ${result.answer}`);
      } catch (error) {
        console.error(`\nAgent error: ${error.message || String(error)}`);
      }
    }
  } finally {
    rl.close();
  }
}

async function main() {
  await ensureActiveModel();

  const singleQuestion = process.argv.slice(2).join(" ").trim();
  if (singleQuestion) {
    await runSingleQuestion(singleQuestion);
    return;
  }
  await runInteractive();
}

main().catch((error) => {
  console.error(`Fatal error: ${error.message || String(error)}`);
  process.exit(1);
});
