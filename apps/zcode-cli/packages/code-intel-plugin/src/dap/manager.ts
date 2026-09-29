import { resolve } from "node:path";
import { ToolFailure } from "../shared/args.js";
import { DapClient, type DapRequestOptions } from "./client.js";
import {
  completeConfiguration,
  createSession,
  fetchTopFrames,
  INITIALIZE_ARGUMENTS,
  prepareStateWait,
  rootOf,
  treeOf,
  type BreakpointSpec,
  type DebugSession,
} from "./session.js";
import type { DapBreakpoint, ResolvedDapAdapter } from "./types.js";

const INITIAL_STOP_WAIT_MS = 5_000;
const ENTRY_STOP_KEYS = ["stopOnEntry", "stopAtEntry", "stopAtBeginningOfMainSubprogram"];

export interface LaunchOptions {
  adapter: ResolvedDapAdapter;
  program: string;
  args?: string[];
  cwd: string;
  extra: Record<string, unknown>;
}

export interface AttachOptions {
  adapter: ResolvedDapAdapter;
  cwd: string;
  pid?: number;
  port?: number;
  host?: string;
}

export type ExecutionOutcome = { session: DebugSession; timedOut: boolean };

/** 进程内唯一的调试会话所有者：同一时间最多一个活动根会话（与 omp 一致）。 */
export class DebugSessionManager {
  private readonly sessions: DebugSession[] = [];
  private active?: DebugSession;
  private readonly lineBreakpoints = new Map<string, BreakpointSpec[]>();
  private functionBreakpoints: Array<{ name: string; condition?: string }> = [];

  list(): DebugSession[] {
    return this.sessions;
  }

  requireActive(): DebugSession {
    const session = this.active;
    if (!session) throw new ToolFailure("No debug session. Start one with action=launch or action=attach.");
    return session;
  }

  private async ensureSlot(): Promise<void> {
    const live = this.sessions.find((session) => !session.parent && session.status !== "terminated");
    if (live) {
      throw new ToolFailure(`A debug session is already active (${live.id}, ${live.status}). Terminate it first.`);
    }
    for (const session of this.sessions.splice(0)) await session.client.dispose().catch(() => undefined);
    this.lineBreakpoints.clear();
    this.functionBreakpoints = [];
  }

  private register(client: DapClient, adapter: ResolvedDapAdapter, cwd: string, program?: string, parent?: DebugSession): DebugSession {
    const session = createSession(client, adapter, cwd, {
      onFocus: (focused) => {
        this.active = focused;
      },
      startChild: (owner, request, configuration) => this.startChild(owner, request, configuration),
    }, { program, parent });
    this.sessions.push(session);
    if (!this.active || this.active.status !== "stopped") this.active = session;
    return session;
  }

  private async start(
    session: DebugSession,
    request: "launch" | "attach",
    args: Record<string, unknown>,
    options: DapRequestOptions,
  ): Promise<DebugSession> {
    const initialized = await session.client.request(
      "initialize",
      { ...INITIALIZE_ARGUMENTS, adapterID: session.adapter.name },
      options,
    );
    session.capabilities = typeof initialized === "object" && initialized !== null ? { ...initialized } : {};
    // 请求了入口暂停时，入口 stopped 事件要等被调试进程启动后才到（Windows 上 debugpy 实测 >5s），
    // 只等 5s 会把会话误报为 running；此时按整个请求超时等待。
    const expectsEntryStop = ENTRY_STOP_KEYS.some((key) => args[key] === true);
    const initialStop = prepareStateWait(
      session,
      options.signal,
      expectsEntryStop ? options.timeoutMs : Math.min(options.timeoutMs, INITIAL_STOP_WAIT_MS),
    );
    const started = session.client.request(request, args, options);
    started.catch(() => undefined);
    await completeConfiguration(session, options, () => this.applyBreakpoints(session, options));
    await started;
    await initialStop;
    const focused = this.active && rootOf(this.active) === rootOf(session) ? this.active : session;
    await fetchTopFrames(focused, options);
    return focused;
  }

  async launch(options: LaunchOptions, request: DapRequestOptions): Promise<DebugSession> {
    await this.ensureSlot();
    const client = await DapClient.spawn(options.adapter, options.cwd);
    const session = this.register(client, options.adapter, options.cwd, options.program);
    try {
      return await this.start(
        session,
        "launch",
        {
          ...options.adapter.launchDefaults,
          ...options.extra,
          program: options.program,
          cwd: options.cwd,
          ...(options.args ? { args: options.args } : {}),
        },
        request,
      );
    } catch (error) {
      await this.dispose();
      throw mapStartError(options.adapter, error);
    }
  }

  async attach(options: AttachOptions, request: DapRequestOptions): Promise<DebugSession> {
    await this.ensureSlot();
    const client = await DapClient.spawn(options.adapter, options.cwd);
    const session = this.register(client, options.adapter, options.cwd);
    try {
      return await this.start(
        session,
        "attach",
        {
          ...options.adapter.attachDefaults,
          cwd: options.cwd,
          ...(options.pid !== undefined ? { pid: options.pid, processId: options.pid } : {}),
          ...(options.port !== undefined ? { port: options.port, connect: { host: options.host ?? "127.0.0.1", port: options.port } } : {}),
          ...(options.host ? { host: options.host } : {}),
        },
        request,
      );
    } catch (error) {
      await this.dispose();
      throw mapStartError(options.adapter, error);
    }
  }

  private async startChild(parent: DebugSession, request: "launch" | "attach", configuration: Record<string, unknown>): Promise<void> {
    const client = await parent.client.connectChild();
    const child = this.register(client, parent.adapter, parent.cwd, parent.program, parent);
    const options = { timeoutMs: 30_000 };
    await this.start(child, request, configuration, options);
  }

  private async applyBreakpoints(session: DebugSession, options: DapRequestOptions): Promise<void> {
    for (const [path, specs] of this.lineBreakpoints) await this.sendLineBreakpoints(session, path, specs, options);
    if (this.functionBreakpoints.length && session.capabilities.supportsFunctionBreakpoints === true) {
      await session.client.request("setFunctionBreakpoints", { breakpoints: this.functionBreakpoints }, options).catch(() => undefined);
    }
  }

  private async sendLineBreakpoints(session: DebugSession, path: string, specs: BreakpointSpec[], options: DapRequestOptions) {
    const body = await session.client.request(
      "setBreakpoints",
      { source: { path }, breakpoints: specs.map((spec) => ({ line: spec.line, ...(spec.condition ? { condition: spec.condition } : {}) })), lines: specs.map((spec) => spec.line) },
      options,
    );
    return typeof body === "object" && body !== null && "breakpoints" in body && Array.isArray(body.breakpoints)
      ? (body.breakpoints as DapBreakpoint[])
      : [];
  }

  /** set / remove 行断点：整份列表替换语义，发给会话树中的每个会话。 */
  async updateLineBreakpoint(file: string, line: number, condition: string | undefined, remove: boolean, options: DapRequestOptions) {
    const session = this.requireActive();
    const path = resolve(session.cwd, file);
    const specs = (this.lineBreakpoints.get(path) ?? []).filter((spec) => spec.line !== line);
    if (!remove) specs.push({ line, condition });
    specs.sort((a, b) => a.line - b.line);
    if (specs.length) this.lineBreakpoints.set(path, specs);
    else this.lineBreakpoints.delete(path);
    let reported: DapBreakpoint[] = [];
    for (const node of treeOf(session).filter((candidate) => candidate.status !== "terminated")) {
      const result = await this.sendLineBreakpoints(node, path, specs, options);
      if (node === rootOf(session) || reported.length === 0) reported = result;
    }
    return { path, specs, reported };
  }

  async updateFunctionBreakpoint(name: string, condition: string | undefined, remove: boolean, options: DapRequestOptions) {
    const session = this.requireActive();
    if (session.capabilities.supportsFunctionBreakpoints !== true) {
      throw new ToolFailure(`${session.adapter.name} does not support function breakpoints.`);
    }
    this.functionBreakpoints = this.functionBreakpoints.filter((entry) => entry.name !== name);
    if (!remove) this.functionBreakpoints.push({ name, ...(condition ? { condition } : {}) });
    let reported: DapBreakpoint[] = [];
    for (const node of treeOf(session).filter((candidate) => candidate.status !== "terminated")) {
      const body = await node.client.request("setFunctionBreakpoints", { breakpoints: this.functionBreakpoints }, options);
      if (typeof body === "object" && body !== null && "breakpoints" in body && Array.isArray(body.breakpoints)) {
        reported = body.breakpoints as DapBreakpoint[];
      }
    }
    return { breakpoints: this.functionBreakpoints, reported };
  }

  async threadId(session: DebugSession, options: DapRequestOptions): Promise<number> {
    if (session.stop.threadId !== undefined) return session.stop.threadId;
    const body = await session.client.request("threads", {}, options);
    const threads = typeof body === "object" && body !== null && "threads" in body && Array.isArray(body.threads) ? body.threads : [];
    const first: unknown = threads[0];
    if (typeof first === "object" && first !== null && "id" in first && typeof first.id === "number") return first.id;
    throw new ToolFailure("No threads available.");
  }

  /** continue / step*：先订阅再发请求，等待下一次 stopped/terminated。 */
  async execute(command: "continue" | "next" | "stepIn" | "stepOut", options: DapRequestOptions): Promise<ExecutionOutcome> {
    const session = this.requireActive();
    if (session.status === "terminated") throw new ToolFailure("The debug session has terminated.");
    const threadId = await this.threadId(session, options);
    const waiting = prepareStateWait(session, options.signal, options.timeoutMs);
    session.status = "running";
    session.topFrames = [];
    await session.client.request(command, { threadId }, options);
    const settled = await waiting;
    const focused = this.active ?? session;
    await fetchTopFrames(focused, options);
    return { session: focused, timedOut: !settled };
  }

  async pause(options: DapRequestOptions): Promise<DebugSession> {
    const session = this.requireActive();
    const threadId = await this.threadId(session, options).catch(() => 0);
    const waiting = prepareStateWait(session, options.signal, options.timeoutMs);
    await session.client.request("pause", { threadId }, options);
    await waiting;
    const focused = this.active ?? session;
    await fetchTopFrames(focused, options);
    return focused;
  }

  async terminate(options: DapRequestOptions): Promise<DebugSession | undefined> {
    const session = this.active;
    if (!session) return undefined;
    const root = rootOf(session);
    if (root.status !== "terminated" && root.capabilities.supportsTerminateRequest === true) {
      await root.client.request("terminate", {}, options).catch(() => undefined);
    }
    await this.dispose();
    root.status = "terminated";
    return root;
  }

  async dispose(): Promise<void> {
    const sessions = this.sessions.splice(0);
    this.active = undefined;
    await Promise.allSettled([...sessions].reverse().map((session) => session.client.dispose()));
    for (const session of sessions) session.status = "terminated";
  }
}

function mapStartError(adapter: ResolvedDapAdapter, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  // debugpy 未安装时 python 立即退出并报 No module named debugpy；给出可执行的安装提示。
  if (adapter.name === "debugpy" && /No module named ['"]?debugpy/i.test(message)) {
    return new ToolFailure("debugpy is not installed for this Python. Run `python -m pip install debugpy` and retry.");
  }
  return error instanceof Error ? error : new Error(message);
}
