import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { resolveCommand } from "../shared/process.js";
import DEFAULT_ADAPTERS from "./defaults.json" with { type: "json" };
import type { DapAdapterConfig, ResolvedDapAdapter } from "./types.js";

const CONFIG_FILE_NAMES = ["dap.json", ".dap.json"];
/** 与 omp 一致：无扩展名程序时按此顺序挑本地调试器。 */
const EXTENSIONLESS_DEBUGGER_ORDER = ["gdb", "lldb-dap", "codelldb"];
const JS_DEBUG = "js-debug-adapter";
const JS_DEBUG_SERVER_ENV = "JS_DEBUG_DAP_SERVER";
export const DAP_PORT_ARGUMENT = "${port}";

export type LaunchProgramKind = "file" | "directory" | "missing";

export type LaunchSelection =
  | { kind: "adapter"; adapter: ResolvedDapAdapter }
  | { kind: "unavailable"; adapterName: string; command: string }
  | { kind: "none" };

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

function adaptersFrom(value: unknown): Record<string, Partial<DapAdapterConfig>> {
  if (typeof value !== "object" || value === null) return {};
  const adapters = "adapters" in value && typeof value.adapters === "object" && value.adapters !== null ? value.adapters : value;
  return Object.fromEntries(
    Object.entries(adapters).filter(([, entry]) => typeof entry === "object" && entry !== null),
  );
}

/** 覆盖顺序：内置目录 < ~/.zcode/dap.json < <cwd>/.zcode/dap.json。 */
export async function loadAdapterConfigs(cwd: string): Promise<Record<string, DapAdapterConfig>> {
  const merged: Record<string, Partial<DapAdapterConfig>> = { ...adaptersFrom(DEFAULT_ADAPTERS) };
  const files = [
    ...CONFIG_FILE_NAMES.map((name) => join(homedir(), ".zcode", name)),
    ...CONFIG_FILE_NAMES.map((name) => join(cwd, ".zcode", name)),
  ];
  for (const file of files) {
    for (const [name, override] of Object.entries(adaptersFrom(await readJson(file)))) {
      merged[name] = { ...merged[name], ...override };
    }
  }
  return Object.fromEntries(
    Object.entries(merged).filter((entry): entry is [string, DapAdapterConfig] => typeof entry[1].command === "string"),
  );
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

async function hasRootMarkers(dir: string, markers: readonly string[]): Promise<boolean> {
  for (const marker of markers) {
    if (marker.includes("*")) {
      const pattern = new RegExp(`^${marker.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
      if ((await readdir(dir).catch(() => [])).some((entry) => pattern.test(entry))) return true;
    } else if (await exists(join(dir, marker))) {
      return true;
    }
  }
  return false;
}

async function rootMarkerAncestor(program: string, kind: LaunchProgramKind, markers: readonly string[]): Promise<boolean> {
  if (markers.length === 0) return false;
  for (let dir = kind === "directory" ? program : dirname(program); ; dir = dirname(dir)) {
    if (await hasRootMarkers(dir, markers)) return true;
    if (dirname(dir) === dir) return false;
  }
}

/** js-debug 以 dapDebugServer.js 的 TCP 形式运行（同 omp）；位置取 JS_DEBUG_DAP_SERVER 或常见安装路径。 */
async function resolveJsDebugServer(cwd: string): Promise<string | undefined> {
  const configured = process.env[JS_DEBUG_SERVER_ENV];
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  const candidates = [
    ...(configured ? [resolve(cwd, configured)] : []),
    join(dataHome, "nvim", "mason", "packages", "js-debug-adapter", "js-debug", "src", "dapDebugServer.js"),
    join(homedir(), ".local", "opt", "js-debug", "src", "dapDebugServer.js"),
  ];
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  return undefined;
}

export async function resolveAdapter(
  name: string,
  config: DapAdapterConfig,
  cwd: string,
): Promise<ResolvedDapAdapter | undefined> {
  const base = {
    name,
    command: config.command,
    args: config.args ?? [],
    fileTypes: config.fileTypes ?? [],
    rootMarkers: config.rootMarkers ?? [],
    launchDefaults: config.launchDefaults ?? {},
    attachDefaults: config.attachDefaults ?? {},
    connectMode: config.connectMode ?? "stdio",
    acceptsDirectoryProgram: config.acceptsDirectoryProgram === true,
  };
  if (name === JS_DEBUG && config.command === JS_DEBUG) {
    const server = await resolveJsDebugServer(cwd);
    if (!server) return undefined;
    return { ...base, command: "node", resolvedCommand: process.execPath, args: [server, DAP_PORT_ARGUMENT, "127.0.0.1"], connectMode: "tcp" };
  }
  const resolvedCommand = await resolveCommand(config.command, cwd);
  return resolvedCommand ? { ...base, resolvedCommand } : undefined;
}

export async function classifyProgram(program: string): Promise<LaunchProgramKind> {
  try {
    return (await stat(program)).isDirectory() ? "directory" : "file";
  } catch {
    return "missing";
  }
}

async function rank(adapter: ResolvedDapAdapter, program: string, kind: LaunchProgramKind) {
  const ext = extname(program).toLowerCase();
  const order = EXTENSIONLESS_DEBUGGER_ORDER.indexOf(adapter.name);
  return {
    adapter,
    extension: ext.length > 0 && adapter.fileTypes.includes(ext) ? 0 : 1,
    root: (await rootMarkerAncestor(program, kind, adapter.rootMarkers)) ? 0 : 1,
    order: order < 0 ? Number.MAX_SAFE_INTEGER : order,
  };
}

/** 按 omp 规则选择启动适配器：显式 > 扩展名匹配 > 根标记 > 本地调试器顺序。 */
export async function selectLaunchAdapter(
  program: string,
  cwd: string,
  kind: LaunchProgramKind,
  adapterName?: string,
): Promise<LaunchSelection> {
  const configs = await loadAdapterConfigs(cwd);
  if (adapterName) {
    const config = configs[adapterName];
    if (!config) return { kind: "none" };
    const adapter = await resolveAdapter(adapterName, config, cwd);
    return adapter ? { kind: "adapter", adapter } : { kind: "unavailable", adapterName, command: config.command };
  }
  const ext = extname(program).toLowerCase();
  const candidates: string[] = [];
  for (const [name, config] of Object.entries(configs)) {
    const byExtension = ext.length > 0 && (config.fileTypes ?? []).includes(ext);
    const byRoot = await rootMarkerAncestor(program, kind, config.rootMarkers ?? []);
    const extensionless = ext.length === 0 && (EXTENSIONLESS_DEBUGGER_ORDER.includes(name) || byRoot);
    if (kind === "directory" && !config.acceptsDirectoryProgram) continue;
    if (byExtension || extensionless || (kind === "directory" && byRoot)) candidates.push(name);
  }
  const available: ResolvedDapAdapter[] = [];
  for (const name of candidates) {
    const adapter = await resolveAdapter(name, configs[name]!, cwd);
    if (adapter) available.push(adapter);
  }
  const ranked = await Promise.all(available.map((adapter) => rank(adapter, program, kind)));
  ranked.sort((a, b) => a.extension - b.extension || a.root - b.root || a.order - b.order || a.adapter.name.localeCompare(b.adapter.name));
  if (ranked[0]) return { kind: "adapter", adapter: ranked[0].adapter };
  const first = candidates[0];
  return first ? { kind: "unavailable", adapterName: first, command: configs[first]!.command } : { kind: "none" };
}

export async function availableAdapters(cwd: string): Promise<ResolvedDapAdapter[]> {
  const configs = await loadAdapterConfigs(cwd);
  const resolved = await Promise.all(Object.entries(configs).map(([name, config]) => resolveAdapter(name, config, cwd)));
  return resolved.filter((adapter): adapter is ResolvedDapAdapter => adapter !== undefined);
}

export async function selectAttachAdapter(cwd: string, adapterName?: string, port?: number): Promise<ResolvedDapAdapter | undefined> {
  const configs = await loadAdapterConfigs(cwd);
  if (adapterName) {
    const config = configs[adapterName];
    return config ? resolveAdapter(adapterName, config, cwd) : undefined;
  }
  const available = await availableAdapters(cwd);
  if (port !== undefined) {
    const debugpy = available.find((adapter) => adapter.name === "debugpy");
    if (debugpy) return debugpy;
  }
  for (const preferred of EXTENSIONLESS_DEBUGGER_ORDER) {
    const match = available.find((adapter) => adapter.name === preferred);
    if (match) return match;
  }
  return available[0];
}

/** dlv：目录与 .go 源文件按包调试（mode=debug），其余视为已编译二进制（mode=exec）。 */
export function launchOverrides(adapter: ResolvedDapAdapter, program: string, kind: LaunchProgramKind): Record<string, unknown> {
  if (adapter.name !== "dlv") return {};
  if (kind === "directory" || extname(program).toLowerCase() === ".go") return { mode: "debug" };
  return kind === "file" ? { mode: "exec" } : {};
}

const UNAVAILABLE_HINTS: Record<string, string> = {
  debugpy: "adapter 'debugpy' is not available: install Python and run `python -m pip install debugpy`",
  dlv: "adapter 'dlv' is not available: install with `go install github.com/go-delve/delve/cmd/dlv@latest`",
  rdbg: "adapter 'rdbg' is not available: install with `gem install debug`",
  [JS_DEBUG]: `adapter '${JS_DEBUG}' is not available: download vscode-js-debug (dapDebugServer.js) from https://github.com/microsoft/vscode-js-debug and set ${JS_DEBUG_SERVER_ENV} to its path`,
};

export function adapterUnavailableMessage(adapterName: string, command: string): string {
  return UNAVAILABLE_HINTS[adapterName] ?? `adapter '${adapterName}' is not available: \`${command}\` not found on PATH`;
}
