// code-intel MCP server 与各工具模块之间的唯一契约；server.ts 只认这个接口。

import type { Tool } from "@modelcontextprotocol/server";

/** 直接作为 MCP tools/list 的条目。 */
export type CodeIntelToolDefinition = Tool;

export interface CodeIntelToolResult {
  text: string;
  isError?: boolean;
}

export interface CodeIntelCallContext {
  /** MCP 请求取消信号；挂起的 LSP/DAP 请求必须随之中止。 */
  signal: AbortSignal;
  /** 工作区根目录（MCP server 的 cwd，由插件清单设为 ${ZCODE_PROJECT_DIR}）。 */
  cwd: string;
}

export interface CodeIntelTool {
  definition: CodeIntelToolDefinition;
  /**
   * 参数非法时抛出 `CodeIntelInvalidParamsError`；可预期的业务失败（找不到服务器、超时等）
   * 返回 `{ isError: true }`，不抛异常。
   */
  call(args: unknown, context: CodeIntelCallContext): Promise<CodeIntelToolResult>;
  /** 关闭该工具持有的全部子进程（语言服务器 / 调试适配器）。幂等。 */
  dispose(): Promise<void>;
}

export class CodeIntelInvalidParamsError extends Error {
  override readonly name = "CodeIntelInvalidParamsError";
}
