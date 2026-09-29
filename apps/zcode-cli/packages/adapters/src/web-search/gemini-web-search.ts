// ============================================================
// Gemini WebSearch Backend - Google Search grounding via Gemini Developer API
// 规则见 apps/zcode-cli/docs/specs/web-search-gemini.md；实现参考 omp 的 gemini 搜索 provider。
// ============================================================

import { setTimeout as sleep } from "node:timers/promises";
import {
  CoreErrorType,
  createCoreError,
  type GeminiWebSearchConfig,
  type HttpClientPort,
  type HttpClientResponse,
  type WebSearchBackendPort,
  type WebSearchBackendRequest,
  type WebSearchBackendResult,
  type WebSearchBackendRunOptions,
  type WebSearchSource,
} from "@zcode/contracts";
import {
  dedupeSources,
  isGroundingRedirectUrl,
  parseGeminiSearchResponse,
  type ParsedGeminiSearch,
} from "./gemini-response.js";

/** 配置文件未给 apiKey 时按顺序读取的 Google 生态既有环境变量。 */
export const GEMINI_API_KEY_ENV_VARS = ["GEMINI_API_KEY", "GOOGLE_API_KEY"] as const;

const PROVIDER = "gemini";
const API_KEY_HEADER = "x-goog-api-key";
const MODEL_PATH_PREFIX = "models/";
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const RATE_LIMITED_STATUS = 429;
const MAX_RETRIES = 2;
const BASE_RETRY_DELAY_MS = 1_000;
const REDIRECT_RESOLVE_TIMEOUT_MS = 5_000;
const REDIRECT_MAX_RESPONSE_BYTES = 64 * 1024;
const ERROR_SNIPPET_MAX_CHARS = 500;
const REDACTED = "[redacted]";
const SYSTEM_INSTRUCTION = [
  "You are a web search assistant. Use Google Search to answer the query with current, factual information.",
  "Be concise, prefer primary sources, and state dates for time-sensitive facts.",
].join(" ");

export interface GeminiWebSearchBackendOptions {
  config: GeminiWebSearchConfig;
  /** 仅用于 apiKey 缺省时的环境变量回退；env 读取停留在 adapter 层。 */
  env?: Record<string, string | undefined>;
  httpClientPort: HttpClientPort;
}

export function createGeminiWebSearchBackend(
  options: GeminiWebSearchBackendOptions,
): WebSearchBackendPort {
  const apiKey =
    options.config.apiKey?.trim() ||
    GEMINI_API_KEY_ENV_VARS.map((name) => options.env?.[name]?.trim()).find(Boolean);
  const configuredModel = options.config.model.trim();
  // 兼容把 REST 资源名 `models/<id>` 直接写进配置的写法。
  const model = configuredModel.startsWith(MODEL_PATH_PREFIX)
    ? configuredModel.slice(MODEL_PATH_PREFIX.length)
    : configuredModel;

  return {
    provider: PROVIDER,
    model,
    search: async (request, runOptions = {}) => {
      if (!apiKey) {
        throw configurationError(
          `Gemini WebSearch is enabled (webSearch.provider = "gemini") but no API key is configured. ` +
            `Set webSearch.gemini.apiKey in the ZCode user config or the ${GEMINI_API_KEY_ENV_VARS.join(" / ")} environment variable.`,
        );
      }
      const url = `${resolveEndpoint(options.config.baseUrl)}/${MODEL_PATH_PREFIX}${encodeURIComponent(model)}:generateContent`;
      const body = new TextEncoder().encode(
        JSON.stringify({
          contents: [{ role: "user", parts: [{ text: buildSearchQuery(request) }] }],
          tools: [{ googleSearch: {} }],
          systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        }),
      );
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
      const parsed = parseGeminiSearchResponse(payload);
      return finalizeResult(options.httpClientPort, parsed, model, runOptions);
    },
  };
}

/** Gemini googleSearch 没有域名参数，按 Google 搜索运算符编码进查询词。 */
export function buildSearchQuery(request: WebSearchBackendRequest): string {
  const allowed = normalizeDomains(request.allowedDomains);
  const blocked = normalizeDomains(request.blockedDomains);
  const parts = [request.query.trim()];
  if (allowed.length === 1) parts.push(`site:${allowed[0]}`);
  if (allowed.length > 1) parts.push(`(${allowed.map((domain) => `site:${domain}`).join(" OR ")})`);
  for (const domain of blocked) parts.push(`-site:${domain}`);
  return parts.join(" ");
}

function normalizeDomains(domains: string[] | undefined): string[] {
  return (domains ?? [])
    .map((domain) => domain.trim().replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, ""))
    .filter((domain) => domain.length > 0);
}

function resolveEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw configurationError(`webSearch.gemini.baseUrl must be an absolute URL: ${baseUrl}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw configurationError("webSearch.gemini.baseUrl must use HTTP or HTTPS");
  }
  return trimmed;
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
          [API_KEY_HEADER]: input.apiKey,
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

async function finalizeResult(
  httpClientPort: HttpClientPort,
  parsed: ParsedGeminiSearch | undefined,
  model: string,
  runOptions: WebSearchBackendRunOptions,
): Promise<WebSearchBackendResult> {
  if (!parsed) {
    throw modelError("Gemini API returned an unrecognized response body");
  }
  if (parsed.blockReason) {
    throw modelError(`Gemini blocked the search prompt: ${parsed.blockReason}`);
  }
  if (!parsed.answer && parsed.sources.length === 0) {
    throw modelError("Gemini API returned an empty grounded response");
  }
  return {
    provider: PROVIDER,
    model: parsed.model ?? model,
    ...(parsed.answer ? { summary: parsed.answer } : {}),
    sources: await resolveGroundingRedirects(httpClientPort, parsed.sources, runOptions),
    searchQueries: parsed.searchQueries,
  };
}

/**
 * grounding 来源是 vertexaisearch 代理链接，模型后续 WebFetch 与引用都需要真实地址。
 * 解析是 best-effort：失败保留代理链接（它本身可跳转），不让一次 HEAD 失败拖垮整次搜索。
 */
async function resolveGroundingRedirects(
  httpClientPort: HttpClientPort,
  sources: WebSearchSource[],
  runOptions: WebSearchBackendRunOptions,
): Promise<WebSearchSource[]> {
  const resolved = await Promise.all(
    sources.map(async (source) => {
      if (!isGroundingRedirectUrl(source.url)) return source;
      try {
        const response = await httpClientPort.request(
          {
            url: source.url,
            method: "HEAD",
            redirect: "manual",
            timeoutMs: REDIRECT_RESOLVE_TIMEOUT_MS,
            maxResponseBytes: REDIRECT_MAX_RESPONSE_BYTES,
            trace: runOptions.trace,
          },
          { signal: runOptions.signal },
        );
        const location = response.headers["location"];
        if (!location) return source;
        const target = new URL(location, source.url);
        return target.protocol === "http:" || target.protocol === "https:"
          ? { ...source, url: target.toString() }
          : source;
      } catch {
        return source;
      }
    }),
  );
  runOptions.signal?.throwIfAborted();
  return dedupeSources(resolved);
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
    `Gemini WebSearch request failed (${response.status}): ${text}`,
    {
      context: { provider: PROVIDER, status: response.status },
      recoverable: true,
      retryable: rateLimited || RETRYABLE_STATUSES.has(response.status),
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
