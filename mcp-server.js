require("dotenv").config();

const cheerio = require("cheerio");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");

const SEARCH_RESULTS = Number(process.env.SEARCH_RESULTS || 6);
const PAGE_MAX_CHARS = Number(process.env.PAGE_MAX_CHARS || 12000);
const WEB_TIMEOUT_MS = Number(process.env.WEB_TIMEOUT_MS || 15000);

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

function toToolSuccess(result) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result),
      },
    ],
    structuredContent: result,
  };
}

function toToolError(error) {
  const message = error?.message || String(error);
  return {
    content: [
      {
        type: "text",
        text: message,
      },
    ],
    isError: true,
  };
}

const server = new McpServer({
  name: "web-research-agent-mcp-server",
  version: "1.0.0",
});

server.registerTool(
  "search_web",
  {
    description: "Search the public web for recent or factual information and return candidate pages.",
    inputSchema: {
      query: z.string().min(1).max(300).describe("The search query."),
      max_results: z.number().int().min(1).max(8).optional().describe("Max search results to return (1-8)."),
    },
  },
  async (input) => {
    try {
      const result = await searchWeb(input);
      return toToolSuccess(result);
    } catch (error) {
      return toToolError(error);
    }
  },
);

server.registerTool(
  "fetch_page",
  {
    description: "Fetch a webpage and extract readable text content so you can ground your answer.",
    inputSchema: {
      url: z.string().min(1).describe("The URL to fetch."),
      max_chars: z
        .number()
        .int()
        .min(500)
        .max(40000)
        .optional()
        .describe("Max text length to return (500-40000)."),
    },
  },
  async (input) => {
    try {
      const result = await fetchPage(input);
      return toToolSuccess(result);
    } catch (error) {
      return toToolError(error);
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(`MCP server fatal error: ${error?.message || String(error)}`);
  process.exit(1);
});

