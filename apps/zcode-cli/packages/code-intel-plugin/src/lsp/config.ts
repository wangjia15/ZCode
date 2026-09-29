import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { resolveCommand } from "../shared/process.js";
import DEFAULT_SERVERS from "./defaults.json" with { type: "json" };

export interface LspServerConfig {
  command: string;
  args: string[];
  fileTypes: string[];
  rootMarkers: string[];
  initOptions?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  isLinter?: boolean;
  disabled?: boolean;
  warmupTimeoutMs?: number;
}

export interface ResolvedLspServer extends LspServerConfig {
  name: string;
  resolvedCommand: string;
}

export interface LspConfigSnapshot {
  /** 可用（根标记命中且命令可解析）的服务器。 */
  servers: ResolvedLspServer[];
  /** 根标记命中但命令找不到的服务器，用于提示安装。 */
  missing: Array<{ name: string; command: string; fileTypes: string[] }>;
}

const CONFIG_FILE_NAMES = ["lsp.json", ".lsp.json"];
const PID_TOKEN = "$PID";
const TS_LANGUAGE_SERVER = "typescript-language-server";
const TS_NATIVE = "typescript-native";

type RawServers = Record<string, Partial<LspServerConfig>>;

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

function normalizeOverrides(value: unknown): RawServers {
  if (typeof value !== "object" || value === null) return {};
  const record = value as Record<string, unknown>;
  const servers = typeof record.servers === "object" && record.servers !== null ? record.servers : record;
  return Object.fromEntries(
    Object.entries(servers as Record<string, unknown>).filter(
      ([key, entry]) => key !== "idleTimeoutMs" && typeof entry === "object" && entry !== null,
    ),
  ) as RawServers;
}

function isComplete(config: Partial<LspServerConfig>): config is LspServerConfig {
  return (
    typeof config.command === "string" &&
    Array.isArray(config.fileTypes) &&
    Array.isArray(config.rootMarkers)
  );
}

/** 覆盖顺序：内置目录 < ~/.zcode/lsp.json < <cwd>/.zcode/lsp.json < <cwd>/lsp.json。 */
async function loadMergedServers(cwd: string): Promise<Record<string, LspServerConfig>> {
  const merged: Record<string, Partial<LspServerConfig>> = { ...(DEFAULT_SERVERS as RawServers) };
  const sources = [
    ...CONFIG_FILE_NAMES.map((name) => join(homedir(), ".zcode", name)),
    ...CONFIG_FILE_NAMES.map((name) => join(cwd, ".zcode", name)),
    ...CONFIG_FILE_NAMES.map((name) => join(cwd, name)),
  ];
  for (const file of sources) {
    for (const [name, override] of Object.entries(normalizeOverrides(await readJson(file)))) {
      merged[name] = { ...merged[name], ...override };
    }
  }
  const result: Record<string, LspServerConfig> = {};
  for (const [name, config] of Object.entries(merged)) {
    if (!isComplete(config)) continue;
    const args = (config.args ?? []).map((arg) => (arg === PID_TOKEN ? String(process.pid) : arg));
    result[name] = { ...config, args };
  }
  return result;
}

async function hasRootMarkers(dir: string, markers: readonly string[]): Promise<boolean> {
  let entries: string[] | undefined;
  for (const marker of markers) {
    if (marker.includes("*")) {
      entries ??= await readdir(dir).catch(() => []);
      const pattern = new RegExp(`^${marker.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
      if (entries.some((entry) => pattern.test(entry))) return true;
      continue;
    }
    if (await stat(join(dir, marker)).then(() => true, () => false)) return true;
  }
  return false;
}

/** 从 file 所在目录向上查找第一个带根标记的目录，找不到退回 cwd。 */
export async function findWorkspaceRoot(
  filePath: string,
  markers: readonly string[],
  cwd: string,
): Promise<string> {
  for (let dir = dirname(resolve(filePath)); ; dir = dirname(dir)) {
    if (await hasRootMarkers(dir, markers)) return dir;
    if (dirname(dir) === dir) return cwd;
  }
}

const snapshots = new Map<string, Promise<LspConfigSnapshot>>();

async function buildSnapshot(cwd: string): Promise<LspConfigSnapshot> {
  const all = await loadMergedServers(cwd);
  const servers: ResolvedLspServer[] = [];
  const missing: LspConfigSnapshot["missing"] = [];
  for (const [name, config] of Object.entries(all)) {
    if (config.disabled) continue;
    if (!(await hasRootMarkers(cwd, config.rootMarkers))) continue;
    const resolvedCommand = await resolveCommand(config.command, cwd);
    if (resolvedCommand) servers.push({ ...config, name, resolvedCommand });
    else missing.push({ name, command: config.command, fileTypes: config.fileTypes });
  }
  // TypeScript 7 的 `tsc --lsp` 与 typescript-language-server 同时命中时优先后者：
  // 旧版 tsc 也会被 node_modules/.bin 解析到，但并不支持 --lsp。
  if (servers.some((server) => server.name === TS_LANGUAGE_SERVER)) {
    const index = servers.findIndex((server) => server.name === TS_NATIVE);
    if (index >= 0) servers.splice(index, 1);
  }
  return { servers, missing };
}

export function getLspConfig(cwd: string): Promise<LspConfigSnapshot> {
  let snapshot = snapshots.get(cwd);
  if (!snapshot) {
    snapshot = buildSnapshot(cwd);
    snapshots.set(cwd, snapshot);
  }
  return snapshot;
}

export function clearLspConfigCache(): void {
  snapshots.clear();
}

function matchesFile(config: LspServerConfig, filePath: string): boolean {
  const ext = extname(filePath).toLowerCase().replace(/^\./, "");
  const fileName = basename(filePath).toLowerCase();
  return config.fileTypes.some((fileType) => {
    const normalized = fileType.toLowerCase().replace(/^\./, "");
    return normalized === ext || normalized === fileName;
  });
}

/** 匹配文件的服务器，类型检查器在前、linter 在后。 */
export function serversForFile<T extends LspServerConfig>(servers: readonly T[], filePath: string): T[] {
  return servers
    .filter((server) => matchesFile(server, filePath))
    .sort((a, b) => Number(a.isLinter ?? false) - Number(b.isLinter ?? false));
}
