import { glob, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { LspClient } from "./client.js";
import { formatDiagnostics, formatDocumentSymbols, formatHover, formatLocations, toLocations } from "./format.js";
import type { LspManager } from "./manager.js";
import { resolvePosition } from "./position.js";
import type { Diagnostic, DocumentSymbol, SymbolInformation } from "./types.js";
import { displayPath, fileToUri, uriToFile } from "./uri.js";
import { ToolFailure } from "../shared/args.js";
import { getLspConfig } from "./config.js";

export interface LspActionContext {
  manager: LspManager;
  cwd: string;
  signal: AbortSignal;
  timeoutMs: number;
}

export interface PositionArgs {
  file: string;
  line?: number;
  symbol?: string;
  column?: number;
}

const DIAGNOSTICS_SETTLE_MS = 10_000;
const MAX_DIAGNOSTIC_FILES = 50;
const WORKSPACE_ALL = "*";

export function resolveFile(file: string, cwd: string): string {
  return isAbsolute(file) ? file : resolve(cwd, file);
}

/** 取主服务器、同步文件，并等工程加载（work-done progress）结束后再发工程级请求。 */
export async function readyClient(context: LspActionContext, filePath: string): Promise<LspClient> {
  const client = await context.manager.primaryClient(filePath, context.signal);
  await client.syncFile(filePath);
  await client.waitUntilIdle(context.timeoutMs, context.signal);
  return client;
}

async function positioned(context: LspActionContext, args: PositionArgs) {
  const filePath = resolveFile(args.file, context.cwd);
  const client = await readyClient(context, filePath);
  const position = await resolvePosition(filePath, args.line, args.symbol, args.column);
  return { client, filePath, params: { textDocument: { uri: fileToUri(filePath) }, position } };
}

const NAVIGATION_METHODS = {
  definition: "textDocument/definition",
  type_definition: "textDocument/typeDefinition",
  implementation: "textDocument/implementation",
  references: "textDocument/references",
} as const;

export async function navigate(
  context: LspActionContext,
  action: keyof typeof NAVIGATION_METHODS,
  args: PositionArgs,
): Promise<string> {
  const { client, params } = await positioned(context, args);
  const request = action === "references" ? { ...params, context: { includeDeclaration: true } } : params;
  const result = await client.request(NAVIGATION_METHODS[action], request, context);
  const locations = toLocations(result);
  const header = action === "references" ? `${locations.length} reference(s):\n` : "";
  return header + (await formatLocations(locations, context.cwd));
}

export async function hover(context: LspActionContext, args: PositionArgs): Promise<string> {
  const { client, params } = await positioned(context, args);
  return formatHover(await client.request("textDocument/hover", params, context));
}

export async function symbols(context: LspActionContext, file: string | undefined, query: string | undefined): Promise<string> {
  if (file && file !== WORKSPACE_ALL) {
    const filePath = resolveFile(file, context.cwd);
    const client = await readyClient(context, filePath);
    const result = await client.request("textDocument/documentSymbol", { textDocument: { uri: fileToUri(filePath) } }, context);
    return formatDocumentSymbols((result ?? []) as Array<DocumentSymbol | SymbolInformation>, context.cwd);
  }
  if (!query) throw new ToolFailure('workspace symbol search needs `query` (use file: "*")');
  const clients = await workspaceClients(context);
  const results = await Promise.all(
    clients.map((client) => client.request("workspace/symbol", { query }, context).catch(() => [])),
  );
  const seen = new Set<string>();
  const merged = (results.flat() as SymbolInformation[]).filter((symbol) => {
    if (!symbol?.location) return false;
    const key = `${symbol.name}@${symbol.location.uri}:${symbol.location.range.start.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return formatDocumentSymbols(merged, context.cwd);
}

/** 工作区级请求需要至少一个已启动的主服务器；没有时按配置启动第一个可用的类型检查器。 */
async function workspaceClients(context: LspActionContext): Promise<LspClient[]> {
  const running = (await context.manager.runningClients()).filter((client) => !client.server.isLinter);
  if (running.length) return running;
  const config = await getLspConfig(context.cwd);
  const server = config.servers.find((candidate) => !candidate.isLinter);
  if (!server) throw new ToolFailure("No language server available for this workspace.");
  return [await context.manager.clientFor(server, resolve(context.cwd, "__workspace__"), context.signal)];
}

async function expandFiles(pattern: string, cwd: string): Promise<string[]> {
  if (!/[*?[{]/.test(pattern)) return [resolveFile(pattern, cwd)];
  const files: string[] = [];
  for await (const entry of glob(pattern, { cwd, exclude: (name) => name === "node_modules" || name === ".git" })) {
    const full = resolve(cwd, entry);
    if (await stat(full).then((info) => info.isFile(), () => false)) files.push(full);
    if (files.length >= MAX_DIAGNOSTIC_FILES) break;
  }
  return files;
}

async function fileDiagnostics(context: LspActionContext, filePath: string): Promise<Diagnostic[]> {
  const clients = await context.manager.allClients(filePath, context.signal);
  const all = await Promise.all(
    clients.map(async (client) => {
      const known = client.getDiagnostics(filePath);
      const { changed } = await client.syncFile(filePath);
      if (client.capabilities.diagnosticProvider) {
        const report = await client
          .request("textDocument/diagnostic", { textDocument: { uri: fileToUri(filePath) } }, context)
          .catch(() => undefined);
        if (report && typeof report === "object" && "items" in report && Array.isArray(report.items)) {
          const items: Diagnostic[] = report.items;
          return items.map((item) => ({ ...item, source: item.source ?? client.server.name }));
        }
      }
      // 文件未变且已有推送结果时直接复用，避免空等一次永远不会来的 publish。
      const diagnostics =
        !changed && known
          ? known
          : await client.waitForDiagnostics(filePath, Math.min(DIAGNOSTICS_SETTLE_MS, context.timeoutMs), context.signal);
      return (diagnostics ?? []).map((item) => ({ ...item, source: item.source ?? client.server.name }));
    }),
  );
  return all.flat();
}

export async function diagnostics(context: LspActionContext, file: string | undefined): Promise<string> {
  if (!file) throw new ToolFailure("diagnostics requires `file` (path, glob, or \"*\")");
  if (file === WORKSPACE_ALL) {
    const lines: string[] = [];
    for (const client of await context.manager.runningClients()) {
      for (const [uri, items] of client.diagnosticEntries()) {
        lines.push(...formatDiagnostics(displayPath(uriToFile(uri), context.cwd), items, client.server.name));
      }
    }
    return lines.length ? lines.join("\n") : "No diagnostics reported by running language servers.";
  }
  const files = await expandFiles(file, context.cwd);
  if (files.length === 0) return `No files match ${file}.`;
  const lines: string[] = [];
  let clean = 0;
  for (const filePath of files) {
    const found = await fileDiagnostics(context, filePath);
    if (found.length === 0) clean += 1;
    lines.push(...formatDiagnostics(displayPath(filePath, context.cwd), found));
  }
  if (lines.length === 0) return `No diagnostics in ${files.length} file(s).`;
  return clean ? `${lines.join("\n")}\n(${clean} file(s) clean)` : lines.join("\n");
}
