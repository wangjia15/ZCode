// ============================================================
// code-intel MCP server：暴露 lsp / debug 两个工具（规格见 apps/zcode-cli/docs/specs/code-intel-plugin.md）
// ============================================================

import { pathToFileURL } from "node:url";
import { INVALID_PARAMS, Server } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createDebugTool } from "./dap/tool.js";
import { createLspTool } from "./lsp/tool.js";
import { CodeIntelInvalidParamsError, type CodeIntelTool } from "./tool-contract.js";

const SERVER_NAME = "code-intel";
const SERVER_VERSION = "0.1.0";
const SERVER_INSTRUCTIONS = [
  "code-intel provides language-server code intelligence (`lsp`) and local debugging via the Debug Adapter Protocol (`debug`).",
  "Prefer `lsp` over text search for definitions, references, hover types, diagnostics and safe renames.",
  "Use `debug` to reproduce a bug under a debugger: launch, set breakpoints, continue, inspect variables, then terminate.",
].join("\n");

export interface CodeIntelRuntime {
  server: Server;
  dispose(): Promise<void>;
}

export function createCodeIntelRuntime(cwd: string = process.cwd()): CodeIntelRuntime {
  const tools: CodeIntelTool[] = [createLspTool(), createDebugTool()];
  const byName = new Map(tools.map((tool) => [tool.definition.name, tool]));
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  server.setRequestHandler("tools/list", async () => ({
    tools: tools.map((tool) => tool.definition),
  }));
  server.setRequestHandler("tools/call", async (request, extra) => {
    const tool = byName.get(request.params.name);
    if (!tool) {
      throw Object.assign(new Error(`Tool ${request.params.name} not found`), {
        code: INVALID_PARAMS,
      });
    }
    try {
      const result = await tool.call(request.params.arguments ?? {}, {
        signal: extra.mcpReq.signal,
        cwd,
      });
      return {
        content: [{ type: "text" as const, text: result.text }],
        ...(result.isError ? { isError: true } : {}),
      };
    } catch (error) {
      if (error instanceof CodeIntelInvalidParamsError) {
        throw Object.assign(new Error(error.message), { code: INVALID_PARAMS });
      }
      // 未预期异常转成工具错误文本，让模型看到原因而不是断开 MCP 连接。
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text" as const, text: `${tool.definition.name} failed: ${message}` }], isError: true };
    }
  });

  let disposed: Promise<void> | undefined;
  return {
    server,
    dispose: () => {
      disposed ??= Promise.allSettled(tools.map((tool) => tool.dispose())).then(() => undefined);
      return disposed;
    },
  };
}

export async function main(): Promise<void> {
  const runtimes = new Set<CodeIntelRuntime>();
  const handle = serveStdio(
    () => {
      const runtime = createCodeIntelRuntime();
      runtimes.add(runtime);
      return runtime.server;
    },
    { legacy: "serve" },
  );
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // 语言服务器与调试适配器是子进程，必须在退出前关闭，避免成为孤儿进程。
    void Promise.allSettled([...runtimes].map((runtime) => runtime.dispose()))
      .then(() => handle.close())
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  process.stdin.once("end", shutdown);
  process.stdin.once("close", shutdown);
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  void main();
}
