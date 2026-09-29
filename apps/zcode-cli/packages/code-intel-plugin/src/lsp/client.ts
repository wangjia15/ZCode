import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { createMessageReader, encodeMessage } from "../shared/jsonrpc-framing.js";
import { killProcessTree, spawnProcess } from "../shared/process.js";
import { CLIENT_CAPABILITIES } from "./capabilities.js";
import type { ResolvedLspServer } from "./config.js";
import type { Diagnostic, JsonRpcMessage, WorkspaceEdit } from "./types.js";
import { fileToUri, languageIdFor, normalizeUriKey } from "./uri.js";
import { traceMessage } from "../shared/trace.js";

const DEFAULT_INIT_TIMEOUT_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 2_000;
const STDERR_TAIL_BYTES = 4_096;
const METHOD_NOT_FOUND = -32601;
const VENDOR_CLIENT_METHOD_PREFIX = "_";
const REQUEST_CANCELLED = -32800;

// 服务器发来的消息是外部输入：在边界处按用到的字段校验，未知字段保留。
const MessageSchema = z.looseObject({
  id: z.union([z.number(), z.string(), z.null()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.looseObject({ code: z.number(), message: z.string() }).optional(),
});
type IncomingMessage = z.infer<typeof MessageSchema>;
const InitializeResultSchema = z.looseObject({ capabilities: z.record(z.string(), z.unknown()).optional() });
const PublishDiagnosticsSchema = z.looseObject({ uri: z.string(), diagnostics: z.array(z.unknown()) });
const ConfigurationParamsSchema = z.looseObject({
  items: z.array(z.looseObject({ section: z.string().optional() })).optional(),
});
const ApplyEditParamsSchema = z.looseObject({ edit: z.looseObject({}) });
const ProgressSchema = z.looseObject({
  token: z.union([z.string(), z.number()]),
  value: z.looseObject({ kind: z.string().optional() }),
});
/** 首个 didOpen 后等待服务器开始上报 progress 的窗口。 */
const PROGRESS_START_GRACE_MS = 1_500;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  method: string;
}

interface OpenDocument {
  version: number;
  text: string;
}

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs: number;
}

export type ApplyEditHandler = (edit: WorkspaceEdit) => Promise<void>;

export class LspClient {
  readonly startedAt = Date.now();
  capabilities: Record<string, unknown> = {};
  private process?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly documents = new Map<string, OpenDocument>();
  private readonly diagnostics = new Map<string, Diagnostic[]>();
  private readonly diagnosticWaiters = new Map<string, Array<() => void>>();
  private readonly activeProgress = new Set<string>();
  private progressWaiters: Array<() => void> = [];
  private sawProgress = false;
  private stderrTail = "";
  private exitError?: Error;
  private firstOpenAt?: number;

  constructor(
    readonly server: ResolvedLspServer,
    readonly root: string,
    private readonly onApplyEdit: ApplyEditHandler,
  ) {}

  get alive(): boolean {
    return this.process !== undefined && this.exitError === undefined;
  }

  async start(signal?: AbortSignal): Promise<void> {
    const child = spawnProcess(this.server.resolvedCommand, this.server.args, { cwd: this.root });
    this.process = child;
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
    });
    child.on("error", (error) => this.handleExit(error));
    child.on("exit", (code, sig) =>
      this.handleExit(new Error(`${this.server.name} exited (code ${code ?? "?"}${sig ? `, ${sig}` : ""})`)),
    );
    createMessageReader(
      child.stdout,
      (raw) => {
        const parsed = MessageSchema.safeParse(raw);
        if (parsed.success) this.handleMessage(parsed.data);
      },
      () => undefined,
    );

    const rootUri = fileToUri(this.root);
    const result = await this.request(
      "initialize",
      {
        processId: process.pid,
        clientInfo: { name: "zcode-code-intel", version: "0.1.0" },
        rootPath: this.root,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: this.root.split(/[\\/]/).pop() ?? "root" }],
        capabilities: CLIENT_CAPABILITIES,
        initializationOptions: this.server.initOptions ?? {},
      },
      { signal, timeoutMs: this.server.warmupTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS },
    );
    this.capabilities = InitializeResultSchema.safeParse(result).data?.capabilities ?? {};
    this.notify("initialized", {});
    if (this.server.settings) {
      this.notify("workspace/didChangeConfiguration", { settings: this.server.settings });
    }
  }

  request(method: string, params: unknown, options: RequestOptions): Promise<unknown> {
    if (this.exitError) return Promise.reject(this.decorate(this.exitError));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
      };
      const cancel = (error: Error) => {
        cleanup();
        this.notify("$/cancelRequest", { id });
        reject(error);
      };
      const onAbort = () => cancel(new Error(`${method} cancelled`));
      const timer = setTimeout(
        () => cancel(new Error(`${this.server.name}: ${method} timed out after ${options.timeoutMs}ms`)),
        options.timeoutMs,
      );
      if (options.signal?.aborted) return onAbort();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        method,
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  /** 以磁盘内容同步文档；`changed` 表示本次是否向服务器发送了 didOpen/didChange。 */
  async syncFile(filePath: string): Promise<{ version: number; changed: boolean }> {
    const uri = fileToUri(filePath);
    const text = await readFile(filePath, "utf8");
    const key = normalizeUriKey(uri);
    const open = this.documents.get(key);
    if (!open) {
      this.firstOpenAt ??= Date.now();
      this.documents.set(key, { version: 1, text });
      this.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: languageIdFor(filePath), version: 1, text },
      });
      return { version: 1, changed: true };
    }
    if (open.text === text) return { version: open.version, changed: false };
    open.version += 1;
    open.text = text;
    this.notify("textDocument/didChange", {
      textDocument: { uri, version: open.version },
      contentChanges: [{ text }],
    });
    return { version: open.version, changed: true };
  }

  getDiagnostics(filePath: string): Diagnostic[] | undefined {
    return this.diagnostics.get(normalizeUriKey(fileToUri(filePath)));
  }

  /** 服务器迄今推送过的全部诊断（key 为规范化 URI）。 */
  diagnosticEntries(): Array<[string, Diagnostic[]]> {
    return [...this.diagnostics.entries()].filter(([, items]) => items.length > 0);
  }

  /** 等待该文件下一次 publishDiagnostics；超时后返回当前已知结果。 */
  async waitForDiagnostics(filePath: string, timeoutMs: number, signal?: AbortSignal): Promise<Diagnostic[] | undefined> {
    const key = normalizeUriKey(fileToUri(filePath));
    const { promise, resolve } = Promise.withResolvers<void>();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    signal?.addEventListener("abort", done, { once: true });
    const waiters = this.diagnosticWaiters.get(key) ?? [];
    waiters.push(done);
    this.diagnosticWaiters.set(key, waiters);
    await promise;
    return this.diagnostics.get(key);
  }

  get stderr(): string {
    return this.stderrTail.trim();
  }

  async dispose(): Promise<void> {
    const child = this.process;
    if (!child) return;
    if (this.alive) {
      await this.request("shutdown", null, { timeoutMs: SHUTDOWN_TIMEOUT_MS }).catch(() => undefined);
      this.notify("exit", null);
    }
    await killProcessTree(child);
  }

  private write(message: JsonRpcMessage): void {
    const stdin = this.process?.stdin;
    if (!stdin || stdin.destroyed || this.exitError) return;
    traceMessage(">>", this.server.name, message);
    stdin.write(encodeMessage(message));
  }

  private decorate(error: Error): Error {
    return this.stderr ? new Error(`${error.message}\n${this.stderr}`) : error;
  }

  private handleExit(error: Error): void {
    if (this.exitError) return;
    this.exitError = error;
    for (const request of this.pending.values()) request.reject(this.decorate(error));
    this.pending.clear();
  }

  private handleMessage(message: IncomingMessage): void {
    traceMessage("<<", this.server.name, message);
    if (message.method && message.id !== undefined && message.id !== null) {
      void this.handleServerRequest(message.id, message.method, message.params);
      return;
    }
    if (message.method) {
      this.handleNotification(message.method, message.params);
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    if (message.error) {
      const code = message.error.code === REQUEST_CANCELLED ? "cancelled" : `error ${message.error.code}`;
      pending.reject(new Error(`${this.server.name}: ${pending.method} ${code}: ${message.error.message}`));
    } else {
      pending.resolve(message.result ?? null);
    }
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === "$/progress") {
      this.handleProgress(params);
      return;
    }
    if (method !== "textDocument/publishDiagnostics") return;
    const parsed = PublishDiagnosticsSchema.safeParse(params);
    if (!parsed.success) return;
    const key = normalizeUriKey(parsed.data.uri);
    // Diagnostic 各字段由格式化层做可选访问，这里不再逐项校验。
    const diagnostics: Diagnostic[] = parsed.data.diagnostics as Diagnostic[];
    this.diagnostics.set(key, diagnostics);
    const waiters = this.diagnosticWaiters.get(key);
    this.diagnosticWaiters.delete(key);
    for (const wake of waiters ?? []) wake();
  }

  private handleProgress(params: unknown): void {
    const parsed = ProgressSchema.safeParse(params);
    if (!parsed.success) return;
    const token = String(parsed.data.token);
    if (parsed.data.value.kind === "begin") {
      this.sawProgress = true;
      this.activeProgress.add(token);
    } else if (parsed.data.value.kind === "end") {
      this.activeProgress.delete(token);
    }
    const waiters = this.progressWaiters;
    this.progressWaiters = [];
    for (const wake of waiters) wake();
  }

  /**
   * 等待服务器的 work-done progress（项目加载 / 索引）结束。
   * 修复原因：tsserver 等在首个 didOpen 后异步加载工程，加载完成前的 references/rename
   * 只覆盖已打开文件（实测跨文件 4 处引用只返回 1 处，重命名漏改调用点）。
   * 刚启动时给一个短暂窗口等待 progress 开始；从不上报 progress 的服务器不受影响。
   */
  async waitUntilIdle(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const graceEnd = (this.firstOpenAt ?? Date.now()) + PROGRESS_START_GRACE_MS;
    while (!signal?.aborted) {
      const now = Date.now();
      const waitingForStart = !this.sawProgress && now < graceEnd;
      if ((!waitingForStart && this.activeProgress.size === 0) || now >= deadline) return;
      const { promise, resolve } = Promise.withResolvers<void>();
      const timer = setTimeout(resolve, Math.min(deadline, waitingForStart ? graceEnd : deadline) - now);
      this.progressWaiters.push(resolve);
      await promise;
      clearTimeout(timer);
    }
  }

  private async handleServerRequest(id: number | string, method: string, params: unknown): Promise<void> {
    const respond = (result: unknown) => this.write({ jsonrpc: "2.0", id, result });
    switch (method) {
      case "workspace/configuration": {
        const items = ConfigurationParamsSchema.safeParse(params).data?.items ?? [];
        respond(items.map((item) => lookupSetting(this.server.settings, item.section)));
        return;
      }
      case "workspace/workspaceFolders":
        respond([{ uri: fileToUri(this.root), name: this.root.split(/[\\/]/).pop() ?? "root" }]);
        return;
      case "client/registerCapability":
      case "client/unregisterCapability":
      case "window/workDoneProgress/create":
      case "window/showMessageRequest":
      case "workspace/diagnostic/refresh":
      case "workspace/semanticTokens/refresh":
      case "workspace/inlayHint/refresh":
      case "workspace/codeLens/refresh":
        respond(null);
        return;
      case "workspace/applyEdit":
        try {
          // WorkspaceEdit 的各分支由 applyWorkspaceEdit 逐项识别。
          const edit: WorkspaceEdit = ApplyEditParamsSchema.parse(params).edit as WorkspaceEdit;
          await this.onApplyEdit(edit);
          respond({ applied: true });
        } catch (error) {
          respond({ applied: false, failureReason: error instanceof Error ? error.message : String(error) });
        }
        return;
      default:
        // 修复原因：tsserver 重构（如 Extract to constant）执行完 workspace/applyEdit 后，还会反向请求
        // `_typescript.rename` 让编辑器进入内联重命名；回 MethodNotFound 会让整个 executeCommand 失败，
        // 尽管编辑已落盘。以 `_` 开头的厂商私有 UI 钩子没有无界面对应物，回 null 表示已忽略。
        if (method.startsWith(VENDOR_CLIENT_METHOD_PREFIX)) {
          respond(null);
          return;
        }
        this.write({ jsonrpc: "2.0", id, error: { code: METHOD_NOT_FOUND, message: `Unhandled method ${method}` } });
    }
  }
}

function lookupSetting(settings: Record<string, unknown> | undefined, section: string | undefined): unknown {
  if (!settings) return null;
  if (!section) return settings;
  if (section in settings) return settings[section];
  let current: unknown = settings;
  for (const part of section.split(".")) {
    if (typeof current !== "object" || current === null || !(part in current)) return null;
    current = Reflect.get(current, part);
  }
  return current ?? null;
}
