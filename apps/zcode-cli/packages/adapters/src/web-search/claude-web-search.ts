// ============================================================
// Claude WebSearch Backend - Anthropic Messages API 服务端 web_search 工具（默认 Haiku）
// 规则见 apps/zcode-cli/docs/specs/web-search-claude.md。
// ============================================================

import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import {
  CoreErrorType,
  createCoreError,
  type ClaudeWebSearchConfig,
  type HttpClientPort,
  type HttpClientResponse,
  type WebSearchBackendPort,
  type WebSearchBackendRequest,
  type WebSearchBackendResult,
  type WebSearchBackendRunOptions,
  type WebSearchSource,
} from "@zcode/contracts";

/** 配置文件未给 apiKey 时读取的环境变量。 */
export const CLAUDE_API_KEY_ENV_VARS = ["ANTHROPIC_API_KEY"] as const;

const PROVIDER = "claude";
const ANTHROPIC_VERSION = "2023-06-01";
const WEB_SEARCH_TOOL_TYPE = "web_search_20250305";
const WEB_SEARCH_TOOL_NAME = "web_search";
const MAX_TOKENS = 4096;
const MAX_SEARCHES = 5;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504, 529]);
const RATE_LIMITED_STATUS = 429;
const MAX_RETRIES = 2;
const BASE_RETRY_DELAY_MS = 1_000;
const ERROR_SNIPPET_MAX_CHARS = 500;
const REDACTED = "[redacted]";
const SYSTEM_INSTRUCTION = [
  "You are a web search assistant. Use the web_search tool to answer the query with current, factual information.",
  "Be concise, prefer primary sources, and state dates for time-sensitive facts.",
].join(" ");

// 只声明用到的字段；未知字段被丢弃，上游新增 block 类型不会让解析失败。
const ClaudeMessageResponseSchema = z.object({
  model: z.string().optional(),
  content: z
    .array(
      z.object({
        type: z.string(),
        text: z.string().optional(),
        name: z.string().optional(),
        input: z.unknown().optional(),
        citations: z
          .array(z.object({ url: z.string().optional(), title: z.string().nullish() }))
          .nullish(),
        // web_search_tool_result：成功是 result 数组，失败是单个 error 对象。
        content: z.unknown().optional(),
      }),
    )
    .optional(),
});

export interface ClaudeWebSearchBackendOptions {
  config: ClaudeWebSearchConfig;
  /** 仅用于 apiKey 缺省时的环境变量回退；env 读取停留在 adapter 层。 */
  env?: Record<string, string | undefined>;
  httpClientPort: HttpClientPort;
}

export function createClaudeWebSearchBackend(
  options: ClaudeWebSearchBackendOptions,
): WebSearchBackendPort {
  const apiKey =
    options.config.apiKey?.trim() ||
    CLAUDE_API_KEY_ENV_VARS.map((name) => options.env?.[name]?.trim()).find(Boolean);
  const model = options.config.model.trim();

  return {
    provider: PROVIDER,
    model,
    search: async (request, runOptions = {}) => {
      if (!apiKey) {
        throw configurationError(
          `Claude WebSearch is enabled (webSearch.provider = "claude") but no API key is configured. ` +
            `Set webSearch.claude.apiKey in the ZCode user config or the ${CLAUDE_API_KEY_ENV_VARS.join(" / ")} environment variable.`,
        );
      }
      const url = resolveMessagesUrl(options.config.baseUrl);
      const body = new TextEncoder().encode(JSON.stringify(buildRequestBody(model, request)));
      const response = await postWithRetry(options.httpClientPort, {
        apiKey,
        body,
        runOptions,
        url,
      });
      let payload: unknown;
      try {
        payload = JSON.parse(new TextDecoder().decode(response.body));
      } catch {
        payload = undefined;
      }
      return toResult(payload, model);
    },
  };
}

function buildRequestBody(model: string, request: WebSearchBackendRequest): Record<string, unknown> {
  const allowed = normalizeDomains(request.allowedDomains);
  const blocked = normalizeDomains(request.blockedDomains);
  return {
    model,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_INSTRUCTION,
    messages: [{ role: "user", content: `Perform a web search for the query: ${request.query.trim()}` }],
    tools: [
      {
        type: WEB_SEARCH_TOOL_TYPE,
        name: WEB_SEARCH_TOOL_NAME,
        max_uses: MAX_SEARCHES,
        // Anthropic 要求二者互斥；输入层已校验，这里再保证只发其一。
        ...(allowed.length > 0
          ? { allowed_domains: allowed }
          : blocked.length > 0
            ? { blocked_domains: blocked }
            : {}),
      },
    ],
  };
}

function normalizeDomains(domains: string[] | undefined): string[] {
  return (domains ?? [])
    .map((domain) => domain.trim().replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, ""))
    .filter((domain) => domain.length > 0);
}

function resolveMessagesUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw configurationError(`webSearch.claude.baseUrl must be an absolute URL: ${baseUrl}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw configurationError("webSearch.claude.baseUrl must use HTTP or HTTPS");
  }
  // 兼容把 `/v1` 一并写进 baseUrl 的网关写法。
  return trimmed.endsWith("/v1") ? `${trimmed}/messages` : `${trimmed}/v1/messages`;
}

async function postWithRetry(
  httpClientPort: HttpClientPort,
  input: {
    apiKey: string;
    body: Uint8Array;
    runOptions: WebSearchBackendRunOptions;
    url: string;
  },
): Promise<HttpClientResponse> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await httpClientPort.request(
      {
        url: input.url,
        method: "POST",
        headers: {
          "x-api-key": input.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: input.body,
        trace: input.runOptions.trace,
      },
      { signal: input.runOptions.signal },
    );
    if (response.status >= 200 && response.status < 300) return response;
    if (RETRYABLE_STATUSES.has(response.status) && attempt < MAX_RETRIES) {
      await sleep(BASE_RETRY_DELAY_MS * 2 ** attempt, undefined, {
        signal: input.runOptions.signal,
      });
      continue;
    }
    throw upstreamError(response, input.apiKey);
  }
}

function toResult(payload: unknown, configuredModel: string): WebSearchBackendResult {
  const parsed = ClaudeMessageResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw modelError("Claude API returned an unrecognized response body");
  }
  const blocks = parsed.data.content ?? [];
  const summary = blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("")
    .trim();
  const searchQueries = new Set<string>();
  const sources: WebSearchSource[] = [];
  const errorCodes: string[] = [];

  for (const block of blocks) {
    if (block.type === "server_tool_use" && block.name === WEB_SEARCH_TOOL_NAME) {
      const query = (block.input as { query?: unknown } | undefined)?.query;
      if (typeof query === "string" && query.trim()) searchQueries.add(query.trim());
    } else if (block.type === "web_search_tool_result") {
      collectToolResult(block.content, sources, errorCodes);
    } else if (block.type === "text") {
      for (const citation of block.citations ?? []) {
        const url = citation.url?.trim();
        if (!url) continue;
        const title = citation.title?.trim();
        sources.push(title ? { url, title } : { url });
      }
    }
  }

  const deduped = dedupeSources(sources);
  if (!summary && deduped.length === 0) {
    throw modelError(
      errorCodes.length > 0
        ? `Claude web_search failed: ${errorCodes.join(", ")}`
        : "Claude API returned an empty search response",
    );
  }
  return {
    provider: PROVIDER,
    model: parsed.data.model?.trim() || configuredModel,
    ...(summary ? { summary } : {}),
    sources: deduped,
    searchQueries: [...searchQueries],
  };
}

function collectToolResult(content: unknown, sources: WebSearchSource[], errorCodes: string[]): void {
  if (Array.isArray(content)) {
    for (const item of content) {
      if (typeof item !== "object" || item === null) continue;
      const { url, title } = item as { url?: unknown; title?: unknown };
      if (typeof url !== "string" || !url.trim()) continue;
      sources.push(
        typeof title === "string" && title.trim()
          ? { url: url.trim(), title: title.trim() }
          : { url: url.trim() },
      );
    }
    return;
  }
  if (typeof content === "object" && content !== null) {
    const { error_code: code } = content as { error_code?: unknown };
    if (typeof code === "string") errorCodes.push(code);
  }
}

/** 按 URL 去重并保留首次出现的标题；搜索结果与 citations 常指向同一页面。 */
function dedupeSources(sources: WebSearchSource[]): WebSearchSource[] {
  const seen = new Set<string>();
  const result: WebSearchSource[] = [];
  for (const source of sources) {
    if (seen.has(source.url)) continue;
    seen.add(source.url);
    result.push(source);
  }
  return result;
}

function upstreamError(response: HttpClientResponse, apiKey: string): Error {
  const text = new TextDecoder()
    .decode(response.body)
    .split(apiKey)
    .join(REDACTED)
    .slice(0, ERROR_SNIPPET_MAX_CHARS);
  const rateLimited = response.status === RATE_LIMITED_STATUS;
  return createCoreError(
    rateLimited ? CoreErrorType.ModelRateLimited : CoreErrorType.ModelError,
    `Claude WebSearch request failed (${response.status}): ${text}`,
    {
      context: { provider: PROVIDER, status: response.status },
      recoverable: true,
      retryable: RETRYABLE_STATUSES.has(response.status),
    },
  );
}

function configurationError(message: string): Error {
  return createCoreError(CoreErrorType.ConfigurationError, message, {
    context: { provider: PROVIDER },
    recoverable: true,
  });
}

function modelError(message: string): Error {
  return createCoreError(CoreErrorType.ModelError, message, {
    context: { provider: PROVIDER },
    recoverable: true,
  });
}
