// ============================================================
// WebSearch Backend Port - search execution independent of the active chat model
// ============================================================

import type { TraceContext } from "../tracing/tracer.js";
import type { WebSearchSource } from "../tools/websearch.js";

/** 可替换的搜索后端 id；端口在场即表示 WebSearch 走该后端，而不是当前模型的原生搜索。 */
export type WebSearchBackendProvider = "gemini";

export interface WebSearchBackendRequest {
  query: string;
  allowedDomains?: string[];
  blockedDomains?: string[];
}

export interface WebSearchBackendRunOptions {
  signal?: AbortSignal;
  trace?: TraceContext;
}

export interface WebSearchBackendResult {
  provider: WebSearchBackendProvider;
  /** 实际响应的模型版本；后端未返回时为配置的模型 id。 */
  model: string;
  summary?: string;
  /** 已去重的来源；grounding 重定向链接已尽力解析为真实 URL。 */
  sources: WebSearchSource[];
  /** 后端实际发出的搜索查询词，用于计数与审计。 */
  searchQueries: string[];
}

/**
 * 错误语义：配置缺失抛 `configuration_error`，上游 HTTP 失败抛 `model_error`，
 * 取消/超时沿 HttpClientPort 错误冒泡。实现负责 IO 边界上的重试。
 */
export interface WebSearchBackendPort {
  readonly provider: WebSearchBackendProvider;
  readonly model: string;
  search(
    request: WebSearchBackendRequest,
    options?: WebSearchBackendRunOptions,
  ): Promise<WebSearchBackendResult>;
}
