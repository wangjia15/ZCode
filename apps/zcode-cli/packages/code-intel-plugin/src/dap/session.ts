import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { CLIENT_CLOSED_EVENT, DapClient, type DapRequestOptions } from "./client.js";
import type { DapCapabilities, DapStackFrame, ResolvedDapAdapter } from "./types.js";

export type SessionStatus = "launching" | "configuring" | "running" | "stopped" | "terminated";

export interface BreakpointSpec {
  line: number;
  condition?: string;
}

export interface DebugSession {
  id: string;
  client: DapClient;
  adapter: ResolvedDapAdapter;
  cwd: string;
  program?: string;
  status: SessionStatus;
  capabilities: DapCapabilities;
  stop: { reason?: string; threadId?: number; description?: string; text?: string };
  exitCode?: number;
  output: string;
  topFrames: DapStackFrame[];
  initializedSeen: boolean;
  configurationDoneSent: boolean;
  parent?: DebugSession;
  children: DebugSession[];
  waiters: Set<() => void>;
}

const OUTPUT_LIMIT_CHARS = 64 * 1024;
const TOP_FRAME_COUNT = 5;
const IGNORED_OUTPUT_CATEGORIES = new Set(["telemetry"]);

export const INITIALIZE_ARGUMENTS = {
  clientID: "zcode",
  clientName: "ZCode",
  locale: "en-US",
  linesStartAt1: true,
  columnsStartAt1: true,
  pathFormat: "path",
  supportsRunInTerminalRequest: true,
  supportsStartDebuggingRequest: true,
  supportsMemoryReferences: true,
  supportsVariableType: true,
  supportsInvalidatedEvent: true,
};

let nextSessionNumber = 1;

function appendOutput(session: DebugSession, text: string): void {
  const root = rootOf(session);
  root.output = (root.output + text).slice(-OUTPUT_LIMIT_CHARS);
}

export function rootOf(session: DebugSession): DebugSession {
  let current = session;
  while (current.parent) current = current.parent;
  return current;
}

export function treeOf(session: DebugSession): DebugSession[] {
  const root = rootOf(session);
  const all: DebugSession[] = [];
  const walk = (node: DebugSession) => {
    all.push(node);
    node.children.forEach(walk);
  };
  walk(root);
  return all;
}

function wake(session: DebugSession): void {
  for (const node of treeOf(session)) {
    for (const waiter of node.waiters) waiter();
    node.waiters.clear();
  }
}

export interface SessionCallbacks {
  /** stopped 事件发生在该会话上，使其成为焦点会话。 */
  onFocus(session: DebugSession): void;
  /** 适配器请求子会话（js-debug 的 startDebugging）。 */
  startChild(parent: DebugSession, request: "launch" | "attach", configuration: Record<string, unknown>): Promise<void>;
}

export function createSession(
  client: DapClient,
  adapter: ResolvedDapAdapter,
  cwd: string,
  callbacks: SessionCallbacks,
  options: { program?: string; parent?: DebugSession },
): DebugSession {
  const session: DebugSession = {
    id: `dap-${nextSessionNumber++}`,
    client,
    adapter,
    cwd,
    program: options.program,
    status: "launching",
    capabilities: {},
    stop: {},
    output: "",
    topFrames: [],
    initializedSeen: false,
    configurationDoneSent: false,
    parent: options.parent,
    children: [],
    waiters: new Set(),
  };
  options.parent?.children.push(session);

  client.onEvent("output", (body) => {
    if (typeof body !== "object" || body === null || !("output" in body) || typeof body.output !== "string") return;
    const category = "category" in body && typeof body.category === "string" ? body.category : "console";
    if (!IGNORED_OUTPUT_CATEGORIES.has(category)) appendOutput(session, body.output);
  });
  client.onEvent("initialized", () => {
    session.initializedSeen = true;
    if (!session.configurationDoneSent && session.status === "launching") session.status = "configuring";
  });
  client.onEvent("stopped", (body) => {
    const stopped = typeof body === "object" && body !== null ? body : {};
    session.status = "stopped";
    session.stop = {
      reason: "reason" in stopped && typeof stopped.reason === "string" ? stopped.reason : undefined,
      threadId: "threadId" in stopped && typeof stopped.threadId === "number" ? stopped.threadId : undefined,
      description: "description" in stopped && typeof stopped.description === "string" ? stopped.description : undefined,
      text: "text" in stopped && typeof stopped.text === "string" ? stopped.text : undefined,
    };
    session.topFrames = [];
    callbacks.onFocus(session);
    wake(session);
  });
  client.onEvent("continued", () => {
    session.status = "running";
    session.topFrames = [];
  });
  client.onEvent("exited", (body) => {
    if (typeof body === "object" && body !== null && "exitCode" in body && typeof body.exitCode === "number") {
      session.exitCode = body.exitCode;
    }
    session.status = "terminated";
    wake(session);
  });
  for (const event of ["terminated", CLIENT_CLOSED_EVENT]) {
    client.onEvent(event, () => {
      session.status = "terminated";
      wake(session);
    });
  }

  client.onReverseRequest("runInTerminal", async (args) => {
    if (typeof args !== "object" || args === null || !("args" in args) || !Array.isArray(args.args) || args.args.length === 0) {
      throw new Error("runInTerminal request did not include a command");
    }
    const [command, ...rest] = args.args.map(String);
    const cwdArg = "cwd" in args && typeof args.cwd === "string" ? args.cwd : ".";
    const envArg = "env" in args && typeof args.env === "object" && args.env !== null ? args.env : {};
    const env = Object.fromEntries(Object.entries(envArg).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    const child = spawn(command!, rest, { cwd: resolve(cwd, cwdArg), env: { ...process.env, ...env }, stdio: "pipe", windowsHide: true });
    child.stdout.on("data", (chunk: Buffer) => appendOutput(session, chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => appendOutput(session, chunk.toString("utf8")));
    return { processId: child.pid };
  });
  client.onReverseRequest("startDebugging", async (args) => {
    const request = typeof args === "object" && args !== null && "request" in args && args.request === "attach" ? "attach" : "launch";
    const configuration =
      typeof args === "object" && args !== null && "configuration" in args && typeof args.configuration === "object" && args.configuration !== null
        ? { ...args.configuration }
        : {};
    await callbacks.startChild(session, request, configuration);
    return {};
  });
  return session;
}

/** 等待会话树内下一次 stopped / terminated；超时返回 false。必须在发送执行请求前调用。 */
export function prepareStateWait(session: DebugSession, signal: AbortSignal | undefined, timeoutMs: number): Promise<boolean> {
  const { promise, resolve: settle } = Promise.withResolvers<boolean>();
  const nodes = treeOf(session);
  const done = (value: boolean) => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    for (const node of nodes) node.waiters.delete(onWake);
    settle(value);
  };
  const onWake = () => done(true);
  const onAbort = () => done(false);
  const timer = setTimeout(() => done(false), timeoutMs);
  signal?.addEventListener("abort", onAbort, { once: true });
  for (const node of nodes) node.waiters.add(onWake);
  return promise;
}

/** 等 initialized 后发送 configurationDone（许多适配器要到握手完成才回复 launch/attach）。 */
export async function completeConfiguration(
  session: DebugSession,
  options: DapRequestOptions,
  beforeDone?: () => Promise<void>,
): Promise<void> {
  if (session.configurationDoneSent) return;
  if (!session.initializedSeen) {
    const { promise, resolve: seen } = Promise.withResolvers<void>();
    const off = session.client.onEvent("initialized", () => seen());
    const offClosed = session.client.onEvent(CLIENT_CLOSED_EVENT, () => seen());
    const timer = setTimeout(seen, options.timeoutMs);
    await promise;
    clearTimeout(timer);
    off();
    offClosed();
    if (!session.initializedSeen) return;
  }
  await beforeDone?.();
  if (session.capabilities.supportsConfigurationDoneRequest === true) {
    await session.client.request("configurationDone", {}, options);
  }
  session.configurationDoneSent = true;
  if (session.status === "configuring" || session.status === "launching") session.status = "running";
}

export async function fetchTopFrames(session: DebugSession, options: DapRequestOptions): Promise<void> {
  if (session.status !== "stopped" || session.stop.threadId === undefined) return;
  const body = await session.client
    .request("stackTrace", { threadId: session.stop.threadId, startFrame: 0, levels: TOP_FRAME_COUNT }, options)
    .catch(() => undefined);
  if (typeof body === "object" && body !== null && "stackFrames" in body && Array.isArray(body.stackFrames)) {
    session.topFrames = body.stackFrames;
  }
}
