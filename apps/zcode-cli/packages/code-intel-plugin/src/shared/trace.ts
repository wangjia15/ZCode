// 调试入口：设置 ZCODE_CODE_INTEL_TRACE=1 时把 LSP/DAP 原始消息写到 stderr（MCP 宿主日志可见）。
// 默认关闭：消息可能包含源码与变量值。

const TRACE_ENABLED = process.env.ZCODE_CODE_INTEL_TRACE === "1";
const MAX_TRACE_CHARS = 2_000;

export function traceMessage(direction: ">>" | "<<", peer: string, message: unknown): void {
  if (!TRACE_ENABLED) return;
  const text = JSON.stringify(message) ?? "";
  process.stderr.write(`[code-intel ${peer} ${direction}] ${text.slice(0, MAX_TRACE_CHARS)}\n`);
}
