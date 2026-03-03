# 原始 Agent 分析（`index.js`）

## 1. 架构概览

- **执行形态**：单文件 CLI Agent（Node.js + CommonJS）。
- **模型接口**：通过 OpenAI 兼容 `responses` API 做多步 function-calling 推理。
- **内置工具**：
  - `search_web`：Bing HTML 结果页解析。
  - `fetch_page`：网页正文抓取（直抓失败时用 `r.jina.ai` 兜底）。
- **流程控制**：
  - 最多 `MAX_AGENT_STEPS` 轮工具调用与续推理。
  - 支持 `--show-process` 和交互命令 `/process on|off` 查看过程。
  - 支持单次提问与多轮会话（保留裁剪后的历史消息）。

## 2. 核心调用链

1. 用户问题进入 `askAgent`。
2. 首次调用 `responses`，携带系统提示词与工具定义。
3. 若模型返回 `function_call`：
   - 调用本地 `runToolCall` 执行工具；
   - 结果作为 `function_call_output` 回传 `responses`（`previous_response_id` 续推理）。
4. 若模型直接返回文本，则输出答案并更新 history。
5. 若续推理失败，触发 `synthesizeFromToolOutputs` 做一次回退合成回答。

## 3. 工程优点

- **可运行闭环完整**：检索、抓取、推理、引用都打通。
- **抗失败能力较好**：
  - 模型请求有重试（网络和部分 HTTP 状态码）。
  - 页面抓取有 `jina` 兜底。
  - 续推理失败仍可用工具结果回退合成。
- **可观测性**：过程日志对调试很实用。

## 4. 主要局限

- **工具协议耦合**：工具是内嵌实现，难复用到其他 MCP 客户端/宿主。
- **文件组织偏集中**：一个文件承载网络、工具、模型、CLI 全部职责，后续扩展成本上升。
- **搜索源单一**：当前只解析 Bing HTML，受页面结构变化影响较大。

## 5. MCP 化改造目标

本次新增 MCP 版本的目标是把“网页搜索+页面抓取”能力标准化为 MCP tools，并提供一个通过 MCP 客户端驱动的研究 Agent：

- `mcp-server.js`：MCP 服务端，暴露 `search_web`、`fetch_page`。
- `mcp-agent.js`：MCP 客户端 Agent，动态读取工具列表并走同样的 `responses + function-calling` 循环。

