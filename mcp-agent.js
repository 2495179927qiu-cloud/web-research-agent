require("dotenv").config();

const path = require("node:path");
const readline = require("node:readline/promises");
const { stdin: input, stdout: output } = require("node:process");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

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
const MAX_HISTORY_MESSAGES = 24;
const MODEL_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 120000);
const OPENAI_MAX_RETRIES = Number(process.env.OPENAI_MAX_RETRIES || 2);
const DEFAULT_SHOW_PROCESS = /^(1|true|yes|on)$/i.test(
  String(process.env.SHOW_AGENT_PROCESS || "").trim(),
);

const MCP_SERVER_COMMAND = String(process.env.MCP_SERVER_COMMAND || process.execPath).trim();
const MCP_SERVER_CWD = String(process.env.MCP_SERVER_CWD || __dirname).trim();
const DEFAULT_MCP_SERVER_ARGS = [path.resolve(__dirname, "mcp-server.js")];

if (!process.env.OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY. Add it in .env then retry.");
  process.exit(1);
}

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

function safeParseJson(jsonText) {
  try {
    return JSON.parse(jsonText || "{}");
  } catch {
    return {};
  }
}

function parseEnvArgs(raw) {
  const text = String(raw || "").trim();
  if (!text) {
    return null;
  }

  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
        return parsed;
      }
    } catch {
      // Ignore JSON parse failures and fallback to split mode.
    }
  }

  return text
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveMcpServerArgs() {
  return parseEnvArgs(process.env.MCP_SERVER_ARGS) || DEFAULT_MCP_SERVER_ARGS;
}

function createProcessReporter(enabled) {
  let eventIndex = 0;

  return {
    enabled: Boolean(enabled),
    log(title, details = []) {
      if (!enabled) {
        return;
      }

      eventIndex += 1;
      const idx = String(eventIndex).padStart(2, "0");
      console.log(`\n[过程 ${idx}] ${title}`);
      for (const line of details) {
        console.log(`  - ${line}`);
      }
    },
  };
}

function summarizeSearchResult(result) {
  const lines = [];
  const count = Number(result?.results_count || 0);
  const engine = String(result?.engine || "unknown");
  lines.push(`搜索引擎: ${engine}`);
  lines.push(`命中数量: ${count}`);

  const top = Array.isArray(result?.results) ? result.results.slice(0, 3) : [];
  for (let i = 0; i < top.length; i += 1) {
    const item = top[i];
    lines.push(`${i + 1}. ${clipText(item?.title || "(无标题)", 70)} | ${item?.url || ""}`);
  }
  return lines;
}

function summarizeFetchResult(result) {
  const textLen = String(result?.text || "").length;
  return [
    `URL: ${result?.url || ""}`,
    `标题: ${clipText(result?.title || "(无标题)", 90)}`,
    `正文长度: ${textLen} 字符`,
    `抓取方式: ${result?.method || "unknown"}`,
  ];
}

function parseCliArgs(argv) {
  const questionParts = [];
  let showProcess = DEFAULT_SHOW_PROCESS;

  for (const rawArg of argv) {
    const arg = String(rawArg || "").trim();
    if (!arg) {
      continue;
    }

    if (arg === "--show-process") {
      showProcess = true;
      continue;
    }
    if (arg === "--hide-process") {
      showProcess = false;
      continue;
    }
    questionParts.push(rawArg);
  }

  return {
    question: questionParts.join(" ").trim(),
    showProcess,
  };
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

async function fetchWithTimeout(url, options = {}, timeoutMs = MODEL_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function callResponsesApi(payload, reporter, stageLabel = "模型请求") {
  const endpoint = `${API_BASE_URL.replace(/\/+$/, "")}/responses`;
  let lastError;

  for (let attempt = 0; attempt <= OPENAI_MAX_RETRIES; attempt += 1) {
    const attemptIndex = attempt + 1;
    const maxAttempts = OPENAI_MAX_RETRIES + 1;
    try {
      reporter?.log(`${stageLabel} (尝试 ${attemptIndex}/${maxAttempts})`, [
        `模型: ${payload?.model || ACTIVE_MODEL}`,
      ]);

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
        reporter?.log(`${stageLabel} 失败`, [`HTTP ${response.status}`]);
        const error = new Error(`model request failed: HTTP ${response.status} ${parseApiError(raw)}`);
        if (isRetriableStatus(response.status) && attempt < OPENAI_MAX_RETRIES) {
          await sleep(1000 * (attempt + 1));
          continue;
        }
        throw error;
      }

      try {
        reporter?.log(`${stageLabel} 成功`);
        return JSON.parse(raw);
      } catch {
        throw new Error(`model request failed: invalid JSON response (${clipText(raw, 200)})`);
      }
    } catch (error) {
      lastError = error;
      reporter?.log(`${stageLabel} 异常`, [error.message || String(error)]);
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

async function synthesizeFromToolOutputs(userQuestion, toolOutputs, reporter) {
  const evidence = formatToolOutputs(toolOutputs);
  const response = await callResponsesApi(
    {
      model: ACTIVE_MODEL,
      input: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `用户问题：${userQuestion}\n\n以下是工具返回的检索资料（JSON）：\n${evidence}\n\n请基于这些资料回答，并附上参考来源链接。`,
        },
      ],
      temperature: 0.2,
    },
    reporter,
    "回退合成回答",
  );

  return extractAssistantText(response) || "没有生成可读答案。";
}

function getCallName(call) {
  return call.name || call.function?.name || "";
}

function getCallArgs(call) {
  return call.arguments || call.function?.arguments || "{}";
}

function normalizeToolParameters(schema) {
  const fallback = {
    type: "object",
    properties: {},
    additionalProperties: false,
  };

  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return fallback;
  }

  const normalized = JSON.parse(JSON.stringify(schema));
  if (!normalized.type) {
    normalized.type = "object";
  }

  if (normalized.type !== "object") {
    return {
      type: "object",
      properties: {
        input: normalized,
      },
      required: ["input"],
      additionalProperties: false,
    };
  }

  if (!normalized.properties || typeof normalized.properties !== "object") {
    normalized.properties = {};
  }
  if (normalized.additionalProperties === undefined) {
    normalized.additionalProperties = false;
  }

  return normalized;
}

function toOpenAiToolDefinitions(mcpTools) {
  const seen = new Set();
  const definitions = [];

  for (const tool of mcpTools) {
    const name = String(tool?.name || "").trim();
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);

    definitions.push({
      type: "function",
      name,
      description: String(tool?.description || "").trim() || `MCP tool: ${name}`,
      parameters: normalizeToolParameters(tool?.inputSchema),
    });
  }

  return definitions;
}

function extractCallToolText(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  return content
    .filter((item) => item?.type === "text" && typeof item?.text === "string")
    .map((item) => item.text)
    .join("\n")
    .trim();
}

function parseCallToolPayload(result) {
  if (result?.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }

  const text = extractCallToolText(result);
  if (!text) {
    return { content: Array.isArray(result?.content) ? result.content : [] };
  }

  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

class McpToolRuntime {
  constructor() {
    this.client = null;
    this.transport = null;
    this.openAiTools = [];
  }

  getToolDefinitions() {
    return this.openAiTools;
  }

  async connect(reporter) {
    const serverArgs = resolveMcpServerArgs();
    if (!MCP_SERVER_COMMAND) {
      throw new Error("MCP server command is empty");
    }

    this.client = new Client({
      name: "web-research-agent-mcp-client",
      version: "1.0.0",
    });
    this.client.onerror = (error) => {
      reporter?.log("MCP 客户端异常", [error?.message || String(error)]);
    };

    this.transport = new StdioClientTransport({
      command: MCP_SERVER_COMMAND,
      args: serverArgs,
      cwd: MCP_SERVER_CWD,
      env: process.env,
      stderr: "pipe",
    });

    if (this.transport.stderr) {
      this.transport.stderr.on("data", (chunk) => {
        const text = clipText(String(chunk || "").replace(/\r?\n/g, " "), 200);
        if (text) {
          reporter?.log("MCP 服务日志", [text]);
        }
      });
    }

    await this.client.connect(this.transport);
    const listed = await this.client.listTools();
    this.openAiTools = toOpenAiToolDefinitions(listed.tools || []);

    reporter?.log("MCP 连接成功", [
      `命令: ${MCP_SERVER_COMMAND} ${serverArgs.join(" ")}`,
      `可用工具: ${this.openAiTools.map((tool) => tool.name).join(", ") || "(无)"}`,
    ]);
  }

  async close() {
    if (this.client) {
      try {
        await this.client.close();
      } catch {
        // Ignore close errors to avoid masking the original task outcome.
      }
    }
    if (this.transport) {
      try {
        await this.transport.close();
      } catch {
        // Ignore close errors to avoid masking the original task outcome.
      }
    }

    this.client = null;
    this.transport = null;
    this.openAiTools = [];
  }

  async callTool(toolName, args) {
    if (!this.client) {
      throw new Error("MCP runtime not connected");
    }
    return this.client.callTool({
      name: toolName,
      arguments: args,
    });
  }
}

async function runToolCall(toolCall, runtime, reporter) {
  const toolName = getCallName(toolCall);
  const args = safeParseJson(getCallArgs(toolCall));
  reporter?.log(`调用 MCP 工具: ${toolName}`, [JSON.stringify(args)]);

  try {
    const mcpResult = await runtime.callTool(toolName, args);
    if (mcpResult?.isError) {
      const message = extractCallToolText(mcpResult) || `tool ${toolName} returned error`;
      reporter?.log(`工具失败: ${toolName}`, [message]);
      return { ok: false, error: message };
    }

    const result = parseCallToolPayload(mcpResult);
    if (toolName === "search_web") {
      reporter?.log(`工具完成: ${toolName}`, summarizeSearchResult(result));
    } else if (toolName === "fetch_page") {
      reporter?.log(`工具完成: ${toolName}`, summarizeFetchResult(result));
    } else {
      reporter?.log(`工具完成: ${toolName}`);
    }

    return { ok: true, result };
  } catch (error) {
    const message = error?.message || String(error);
    reporter?.log(`工具异常: ${toolName}`, [message]);
    return { ok: false, error: message };
  }
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

async function askAgent(userQuestion, history = [], options = {}, runtime) {
  const reporter = createProcessReporter(Boolean(options.showProcess));
  const tools = runtime.getToolDefinitions();

  const seedInput = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.map((message) => ({
      role: message.role,
      content: String(message.content || ""),
    })),
    { role: "user", content: userQuestion },
  ];

  const initialPayload = {
    model: ACTIVE_MODEL,
    input: seedInput,
    temperature: 0.2,
  };
  if (tools.length) {
    initialPayload.tools = tools;
  }

  reporter.log("收到问题", [clipText(userQuestion, 120)]);
  let modelResponse = await callResponsesApi(initialPayload, reporter, "初始推理");

  for (let step = 1; step <= MAX_AGENT_STEPS; step += 1) {
    const calls = extractFunctionCalls(modelResponse);
    if (!calls.length) {
      const answer = extractAssistantText(modelResponse) || "没有生成可读答案。";
      reporter.log("完成回答", [`答案长度: ${answer.length} 字符`]);
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

    reporter.log(`进入 Step ${step}`, [`工具调用数: ${calls.length}`]);
    const toolOutputs = [];
    for (const call of calls) {
      const result = await runToolCall(call, runtime, reporter);
      toolOutputs.push({
        type: "function_call_output",
        call_id: call.id,
        output: JSON.stringify(result),
      });
    }

    try {
      const continuationPayload = {
        model: ACTIVE_MODEL,
        previous_response_id: modelResponse.id,
        input: toolOutputs,
        temperature: 0.2,
      };
      if (tools.length) {
        continuationPayload.tools = tools;
      }

      modelResponse = await callResponsesApi(continuationPayload, reporter, `Step ${step} 续推理`);
    } catch {
      reporter.log(`Step ${step} 续推理失败`, ["切换到回退合成回答"]);
      const answer = await synthesizeFromToolOutputs(userQuestion, toolOutputs, reporter);
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

async function runSingleQuestion(question, runtime, options = {}) {
  const { answer } = await askAgent(question, [], { showProcess: Boolean(options.showProcess) }, runtime);
  console.log(answer);
}

async function runInteractive(runtime, options = {}) {
  let showProcess = Boolean(
    options.showProcess !== undefined ? options.showProcess : DEFAULT_SHOW_PROCESS,
  );

  console.log(`MCP Web Research Agent running with model: ${ACTIVE_MODEL}`);
  console.log(`OpenAI base URL: ${API_BASE_URL}`);
  console.log(`MCP server command: ${MCP_SERVER_COMMAND} ${resolveMcpServerArgs().join(" ")}`);
  console.log(`过程可视化: ${showProcess ? "开启" : "关闭"}`);
  console.log("输入 /process on 或 /process off 可动态切换过程可视化。");
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

      if (normalized === "/process") {
        console.log(`\nAgent> 当前过程可视化: ${showProcess ? "开启" : "关闭"}`);
        continue;
      }

      if (normalized === "/process on" || normalized === "/过程 开") {
        showProcess = true;
        console.log("\nAgent> 已开启过程可视化。");
        continue;
      }

      if (normalized === "/process off" || normalized === "/过程 关") {
        showProcess = false;
        console.log("\nAgent> 已关闭过程可视化。");
        continue;
      }

      try {
        const result = await askAgent(question, history, { showProcess }, runtime);
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

  const cli = parseCliArgs(process.argv.slice(2));
  const startupReporter = createProcessReporter(Boolean(cli.showProcess));
  const runtime = new McpToolRuntime();

  try {
    await runtime.connect(startupReporter);

    if (cli.question) {
      await runSingleQuestion(cli.question, runtime, { showProcess: cli.showProcess });
      return;
    }

    await runInteractive(runtime, { showProcess: cli.showProcess });
  } finally {
    await runtime.close();
  }
}

main().catch((error) => {
  console.error(`Fatal error: ${error.message || String(error)}`);
  process.exit(1);
});

