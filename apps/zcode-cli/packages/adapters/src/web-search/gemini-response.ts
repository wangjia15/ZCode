// Gemini generateContent 响应解析：grounded 文本、来源与搜索词。
// 字段形状参考 Gemini Developer API 的 GenerateContentResponse 与 omp 的 gemini 搜索 provider。

import { z } from "zod";
import type { WebSearchSource } from "@zcode/contracts";

// 只声明用到的字段；z.object 默认丢弃未知字段，上游新增字段不会让解析失败。
const GeminiGenerateContentResponseSchema = z.object({
  candidates: z
    .array(
      z.object({
        content: z
          .object({
            parts: z
              .array(z.object({ text: z.string().optional(), thought: z.boolean().optional() }))
              .optional(),
          })
          .optional(),
        groundingMetadata: z
          .object({
            groundingChunks: z
              .array(
                z.object({
                  web: z
                    .object({ uri: z.string().optional(), title: z.string().optional() })
                    .optional(),
                }),
              )
              .optional(),
            webSearchQueries: z.array(z.string()).optional(),
          })
          .optional(),
      }),
    )
    .optional(),
  promptFeedback: z.object({ blockReason: z.string().optional() }).optional(),
  modelVersion: z.string().optional(),
});

export interface ParsedGeminiSearch {
  answer: string;
  sources: WebSearchSource[];
  searchQueries: string[];
  model?: string;
  blockReason?: string;
}

const GROUNDING_REDIRECT_HOST = "vertexaisearch.cloud.google.com";
const GROUNDING_REDIRECT_PATH = "/grounding-api-redirect";

/** 返回 undefined 表示响应不是可识别的 GenerateContentResponse。 */
export function parseGeminiSearchResponse(value: unknown): ParsedGeminiSearch | undefined {
  const parsed = GeminiGenerateContentResponseSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const response = parsed.data;
  const candidate = response.candidates?.[0];
  const answer = (candidate?.content?.parts ?? [])
    // thinking 模型可能返回 thought part；那不是给用户的答案。
    .filter((part) => part.thought !== true)
    .map((part) => part.text ?? "")
    .join("");
  const metadata = candidate?.groundingMetadata;
  const sources = (metadata?.groundingChunks ?? []).flatMap((chunk) => {
    const url = chunk.web?.uri?.trim();
    if (!url) return [];
    const title = chunk.web?.title?.trim();
    return [title ? { url, title } : { url }];
  });

  return {
    answer: answer.trim(),
    sources: dedupeSources(sources),
    searchQueries: [
      ...new Set((metadata?.webSearchQueries ?? []).filter((query) => query.trim().length > 0)),
    ],
    model: response.modelVersion?.trim() || undefined,
    blockReason: response.promptFeedback?.blockReason?.trim() || undefined,
  };
}

export function isGroundingRedirectUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === GROUNDING_REDIRECT_HOST &&
      parsed.pathname.startsWith(GROUNDING_REDIRECT_PATH)
    );
  } catch {
    return false;
  }
}

/** 按 URL 去重并保留首次出现的标题；重定向解析后不同代理链接可能落到同一真实地址。 */
export function dedupeSources(sources: WebSearchSource[]): WebSearchSource[] {
  const seen = new Set<string>();
  const result: WebSearchSource[] = [];
  for (const source of sources) {
    if (seen.has(source.url)) continue;
    seen.add(source.url);
    result.push(source);
  }
  return result;
}
