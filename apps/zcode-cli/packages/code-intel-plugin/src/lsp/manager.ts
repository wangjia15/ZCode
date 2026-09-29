import { clearLspConfigCache, findWorkspaceRoot, getLspConfig, serversForFile, type ResolvedLspServer } from "./config.js";
import { LspClient } from "./client.js";
import { applyWorkspaceEdit } from "./edits.js";
import { installHint } from "../shared/process.js";
import { ToolFailure } from "../shared/args.js";

/** 按 (服务器, 工作区根) 懒启动并复用语言服务器；进程级唯一所有者。 */
export class LspManager {
  private readonly clients = new Map<string, Promise<LspClient>>();

  constructor(private readonly cwd: string) {}

  async serversFor(filePath: string): Promise<ResolvedLspServer[]> {
    const config = await getLspConfig(this.cwd);
    const servers = serversForFile(config.servers, filePath);
    if (servers.length > 0) return servers;
    const missing = serversForFile(
      config.missing.map((entry) => ({ ...entry, args: [], rootMarkers: [] })),
      filePath,
    );
    if (missing.length > 0) {
      throw new ToolFailure(
        `No language server available for ${filePath}. Expected one of: ${missing
          .map((entry) => `${entry.name} (\`${entry.command}\`)`)
          .join(", ")}. ${installHint(missing[0]!.command)}`,
      );
    }
    throw new ToolFailure(
      `No language server configured for ${filePath}. Add one in .zcode/lsp.json (same format as omp lsp.json).`,
    );
  }

  /** 该文件的主服务器（类型检查器优先）。 */
  async primaryClient(filePath: string, signal?: AbortSignal): Promise<LspClient> {
    const [server] = await this.serversFor(filePath);
    return this.clientFor(server!, filePath, signal);
  }

  async allClients(filePath: string, signal?: AbortSignal): Promise<LspClient[]> {
    const servers = await this.serversFor(filePath);
    return Promise.all(servers.map((server) => this.clientFor(server, filePath, signal)));
  }

  async clientFor(server: ResolvedLspServer, filePath: string, signal?: AbortSignal): Promise<LspClient> {
    const root = await findWorkspaceRoot(filePath, server.rootMarkers, this.cwd);
    const key = `${server.name}\u0000${root}`;
    const existing = this.clients.get(key);
    if (existing) {
      const client = await existing.catch(() => undefined);
      if (client?.alive) return client;
      this.clients.delete(key);
    }
    const starting = (async () => {
      const client = new LspClient(server, root, async (edit) => {
        await applyWorkspaceEdit(edit, this.cwd);
      });
      try {
        await client.start(signal);
      } catch (error) {
        await client.dispose();
        throw error;
      }
      return client;
    })();
    this.clients.set(key, starting);
    starting.catch(() => this.clients.delete(key));
    return starting;
  }

  async runningClients(): Promise<LspClient[]> {
    const settled = await Promise.allSettled(this.clients.values());
    return settled.flatMap((result) => (result.status === "fulfilled" && result.value.alive ? [result.value] : []));
  }

  async status(): Promise<string> {
    const config = await getLspConfig(this.cwd);
    const running = await this.runningClients();
    const lines = ["Configured (available):"];
    for (const server of config.servers) {
      const active = running.filter((client) => client.server.name === server.name);
      const state = active.length ? `running (${active.map((client) => client.root).join(", ")})` : "idle";
      lines.push(`  ${server.name}${server.isLinter ? " [linter]" : ""}: ${server.fileTypes.join(" ")} — ${state}`);
    }
    if (config.servers.length === 0) lines.push("  (none — no root markers matched or no server installed)");
    if (config.missing.length) {
      lines.push("Matched project but not installed:");
      for (const entry of config.missing) lines.push(`  ${entry.name}: \`${entry.command}\``);
    }
    return lines.join("\n");
  }

  /** 重启单个文件对应的服务器；`filePath` 为空时关闭全部并重读配置。 */
  async reload(filePath?: string): Promise<string> {
    if (!filePath) {
      await this.dispose();
      clearLspConfigCache();
      return "All language servers stopped; configuration will be re-read on next use.";
    }
    const servers = new Set((await this.serversFor(filePath)).map((server) => server.name));
    const restarted: string[] = [];
    for (const [key, pending] of this.clients) {
      const client = await pending.catch(() => undefined);
      if (!client || !servers.has(client.server.name)) continue;
      this.clients.delete(key);
      await client.dispose();
      restarted.push(client.server.name);
    }
    return restarted.length ? `Stopped ${restarted.join(", ")}; restarts on next request.` : "No running server for that file.";
  }

  async dispose(): Promise<void> {
    const pending = [...this.clients.values()];
    this.clients.clear();
    await Promise.allSettled(
      pending.map(async (entry) => {
        const client = await entry.catch(() => undefined);
        await client?.dispose();
      }),
    );
  }
}
