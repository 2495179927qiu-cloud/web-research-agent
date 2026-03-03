# Web Research Agent (Node.js + MCP)

一个可运行的命令行 Agent：会自主调用“网页搜索”和“页面抓取”工具，再基于检索结果回答问题并给出来源。

仓库内同时提供两种实现：

- **直连版 Agent**（`index.js`）：工具逻辑内嵌在 Agent 内部。
- **MCP 版 Agent**（`mcp-agent.js` + `mcp-server.js`）：工具通过 MCP 协议暴露和调用。

## 功能

- 自动搜索网页（Bing HTML 结果页解析）
- 自动抓取网页正文（直抓 + `r.jina.ai` 兜底）
- OpenAI 兼容 `responses` + function-calling 循环，模型自己决定是否继续检索
- 支持“过程可视化”开关（可显示 Agent 的分步检索与工具调用过程）
- 支持单次提问和多轮对话
- 支持 MCP 版（工具可复用给任意 MCP 客户端）

## 快速开始

1. 安装依赖

```bash
npm install
```

2. 配置环境变量

```bash
copy .env.example .env
```

编辑 `.env`，至少填入：

```env
OPENAI_API_KEY=你的Key
```

如果你走的是 OpenAI 兼容网关（非 `api.openai.com`），再加：

```env
OPENAI_BASE_URL=https://你的网关/v1
```

3. 运行

- 直连版（原版）

- 交互模式：

```bash
npm start
```

- 单次提问：

```bash
node index.js "今天英伟达股价最新是多少？"
```

- 单次提问并显示检索过程：

```bash
node index.js --show-process "今天英伟达股价最新是多少？"
```

交互模式下可随时输入：

```text
/process on
/process off
```

- MCP 版

先启动 MCP server（终端 A）：

```bash
npm run start:mcp-server
```

再启动 MCP agent（终端 B）：

```bash
npm run start:mcp-agent
```

单次提问：

```bash
node mcp-agent.js "今天英伟达股价最新是多少？"
```

单次提问并显示过程：

```bash
node mcp-agent.js --show-process "今天英伟达股价最新是多少？"
```

> `mcp-agent.js` 默认会自动拉起本地 `mcp-server.js`，因此通常只运行 `mcp-agent.js` 也可以。

## 环境变量

- `OPENAI_API_KEY` 必填
- `OPENAI_BASE_URL` 可选（默认直连 OpenAI；如使用兼容网关请配置）
- `OPENAI_MODEL` 默认 `gpt-4.1-mini`
- `OPENAI_MAX_RETRIES` 默认 `2`
- `SHOW_AGENT_PROCESS` 默认 `false`（是否默认显示 Agent 过程）
- `MAX_AGENT_STEPS` 默认 `6`
- `SEARCH_RESULTS` 默认 `6`
- `PAGE_MAX_CHARS` 默认 `12000`
- `OPENAI_TIMEOUT_MS` 默认 `120000`
- `WEB_TIMEOUT_MS` 默认 `15000`
- `MCP_SERVER_COMMAND` 默认当前 Node 可执行文件（用于 `mcp-agent.js` 拉起 MCP server）
- `MCP_SERVER_ARGS` 可选，支持 JSON 数组或空格分隔字符串；默认 `["<repo>/mcp-server.js"]`
- `MCP_SERVER_CWD` 默认仓库根目录（`mcp-agent.js` 拉起 MCP server 时的工作目录）

## 说明

- 这是一个通用研究 Agent，不保证每个网站都可抓取（反爬、登录墙、地区限制等会影响）。
- 对高风险场景（医疗、法律、投资）请二次核验原始来源。
- 设计分析见 `AGENT_ANALYSIS.md`。
