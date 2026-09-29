import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createConnection, createServer, type Socket } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { createMessageReader, encodeMessage } from "../shared/jsonrpc-framing.js";
import { killProcessTree, spawnProcess } from "../shared/process.js";
import { DAP_PORT_ARGUMENT } from "./config.js";
import { traceMessage } from "../shared/trace.js";
import type { ResolvedDapAdapter } from "./types.js";

const LOOPBACK = "127.0.0.1";
const CONNECT_RETRY_MS = 100;
const CONNECT_TIMEOUT_MS = 15_000;
const DISCONNECT_TIMEOUT_MS = 2_000;
const STDERR_TAIL_BYTES = 4_096;
/** 传输关闭（适配器退出 / 连接断开）时派发的内部事件名。 */
export const CLIENT_CLOSED_EVENT = "zcode/closed";

const MessageSchema = z.looseObject({
  seq: z.number(),
  type: z.enum(["request", "response", "event"]),
  command: z.string().optional(),
  event: z.string().optional(),
  request_seq: z.number().optional(),
  success: z.boolean().optional(),
  message: z.string().optional(),
  arguments: z.unknown().optional(),
  body: z.unknown().optional(),
});
type Message = z.infer<typeof MessageSchema>;

interface Pending {
  command: string;
  resolve(body: unknown): void;
  reject(error: Error): void;
}

export interface DapRequestOptions {
  signal?: AbortSignal;
  timeoutMs: number;
}

type EventHandler = (body: unknown) => void;
type ReverseHandler = (args: unknown) => Promise<unknown>;

async function reservePort(): Promise<number> {
  const server = createServer();
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  server.once("error", reject);
  server.listen(0, LOOPBACK, () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    server.close(() => resolve(port));
  });
  return promise;
}

async function connectWithRetry(port: number, child: ChildProcessWithoutNullStreams | undefined): Promise<Socket> {
  const deadline = Date.now() + CONNECT_TIMEOUT_MS;
  for (;;) {
    try {
      const socket = createConnection({ host: LOOPBACK, port });
      const { promise, resolve, reject } = Promise.withResolvers<Socket>();
      socket.once("connect", () => resolve(socket));
      socket.once("error", reject);
      return await promise;
    } catch (error) {
      if (child && child.exitCode !== null) throw new Error(`debug adapter exited before accepting connections (code ${child.exitCode})`);
      if (Date.now() > deadline) throw error;
      await sleep(CONNECT_RETRY_MS);
    }
  }
}

export class DapClient {
  private seq = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly eventHandlers = new Map<string, Set<EventHandler>>();
  private readonly reverseHandlers = new Map<string, ReverseHandler>();
  private closedError?: Error;
  private stderrTail = "";

  private constructor(
    readonly adapter: ResolvedDapAdapter,
    private readonly input: NodeJS.ReadableStream,
    private readonly output: NodeJS.WritableStream,
    private readonly child: ChildProcessWithoutNullStreams | undefined,
    readonly port: number | undefined,
    private readonly socket?: Socket,
  ) {
    createMessageReader(
      input,
      (raw) => {
        const parsed = MessageSchema.safeParse(raw);
        if (parsed.success) this.handle(parsed.data);
      },
      () => undefined,
    );
    child?.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
    });
    const onClose = (reason: string) => this.close(new Error(reason));
    child?.once("exit", (code) => onClose(`debug adapter ${adapter.name} exited (code ${code ?? "?"})`));
    child?.once("error", (error) => onClose(error.message));
    socket?.once("close", () => onClose(`debug adapter ${adapter.name} connection closed`));
  }

  /** 按适配器的连接方式启动：stdio / tcp（${port} 占位）/ socket（dlv --client-addr 回连）。 */
  static async spawn(adapter: ResolvedDapAdapter, cwd: string): Promise<DapClient> {
    if (adapter.connectMode === "stdio") {
      const child = spawnProcess(adapter.resolvedCommand, adapter.args, { cwd });
      return new DapClient(adapter, child.stdout, child.stdin, child, undefined);
    }
    if (adapter.connectMode === "tcp") {
      const port = await reservePort();
      const args = adapter.args.map((arg) => arg.replaceAll(DAP_PORT_ARGUMENT, String(port)));
      const child = spawnProcess(adapter.resolvedCommand, args, { cwd });
      const socket = await connectWithRetry(port, child).catch(async (error) => {
        await killProcessTree(child);
        throw error;
      });
      return new DapClient(adapter, socket, socket, child, port, socket);
    }
    const server = createServer();
    const listening = Promise.withResolvers<void>();
    server.once("error", listening.reject);
    server.listen(0, LOOPBACK, () => listening.resolve());
    await listening.promise;
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const accepted = Promise.withResolvers<Socket>();
    server.once("connection", accepted.resolve);
    const child = spawnProcess(adapter.resolvedCommand, [...adapter.args, `--client-addr=${LOOPBACK}:${port}`], { cwd });
    child.once("exit", (code) => accepted.reject(new Error(`debug adapter exited before connecting (code ${code ?? "?"})`)));
    const timer = setTimeout(() => accepted.reject(new Error("debug adapter did not connect in time")), CONNECT_TIMEOUT_MS);
    try {
      const socket = await accepted.promise;
      return new DapClient(adapter, socket, socket, child, undefined, socket);
    } catch (error) {
      await killProcessTree(child);
      throw error;
    } finally {
      clearTimeout(timer);
      server.close();
    }
  }

  /** js-debug 等多会话适配器：子会话在同一端口上新开一条连接。 */
  async connectChild(): Promise<DapClient> {
    if (this.port === undefined) throw new Error(`${this.adapter.name} does not support child sessions`);
    const socket = await connectWithRetry(this.port, undefined);
    return new DapClient(this.adapter, socket, socket, undefined, this.port, socket);
  }

  get alive(): boolean {
    return this.closedError === undefined;
  }

  get stderr(): string {
    return this.stderrTail.trim();
  }

  onEvent(event: string, handler: EventHandler): () => void {
    const handlers = this.eventHandlers.get(event) ?? new Set();
    handlers.add(handler);
    this.eventHandlers.set(event, handlers);
    return () => handlers.delete(handler);
  }

  onReverseRequest(command: string, handler: ReverseHandler): void {
    this.reverseHandlers.set(command, handler);
  }

  request(command: string, args: unknown, options: DapRequestOptions): Promise<unknown> {
    if (this.closedError) return Promise.reject(this.closedError);
    const seq = this.seq++;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      this.pending.delete(seq);
    };
    const onAbort = () => {
      cleanup();
      reject(new Error(`${command} cancelled`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`DAP ${command} timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    if (options.signal?.aborted) {
      onAbort();
      return promise;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    this.pending.set(seq, {
      command,
      resolve: (body) => {
        cleanup();
        resolve(body);
      },
      reject: (error) => {
        cleanup();
        reject(error);
      },
    });
    this.write({ seq, type: "request", command, arguments: args });
    return promise;
  }

  async dispose(): Promise<void> {
    if (this.alive) {
      await this.request("disconnect", { terminateDebuggee: true }, { timeoutMs: DISCONNECT_TIMEOUT_MS }).catch(() => undefined);
    }
    this.socket?.destroy();
    if (this.child) await killProcessTree(this.child);
    this.close(new Error("debug session disposed"));
  }

  private write(message: Omit<Message, "seq"> & { seq?: number }): void {
    if (this.closedError) return;
    const framed = { seq: message.seq ?? this.seq++, ...message };
    traceMessage(">>", this.adapter.name, framed);
    this.output.write(encodeMessage(framed));
  }

  private close(error: Error): void {
    if (this.closedError) return;
    this.closedError = this.stderr ? new Error(`${error.message}\n${this.stderr}`) : error;
    for (const pending of this.pending.values()) pending.reject(this.closedError);
    this.pending.clear();
    for (const handler of this.eventHandlers.get(CLIENT_CLOSED_EVENT) ?? []) handler(undefined);
  }

  private handle(message: Message): void {
    traceMessage("<<", this.adapter.name, message);
    if (message.type === "response" && message.request_seq !== undefined) {
      const pending = this.pending.get(message.request_seq);
      if (!pending) return;
      if (message.success) pending.resolve(message.body);
      else pending.reject(new Error(`DAP ${pending.command} failed: ${message.message ?? "unknown error"}${formatErrorBody(message.body)}`));
      return;
    }
    if (message.type === "event" && message.event) {
      for (const handler of this.eventHandlers.get(message.event) ?? []) handler(message.body);
      return;
    }
    if (message.type === "request" && message.command) void this.handleReverse(message.seq, message.command, message.arguments);
  }

  private async handleReverse(requestSeq: number, command: string, args: unknown): Promise<void> {
    const handler = this.reverseHandlers.get(command);
    const base = { type: "response" as const, request_seq: requestSeq, command };
    if (!handler) {
      this.write({ ...base, success: false, message: `Unsupported reverse request ${command}` });
      return;
    }
    try {
      this.write({ ...base, success: true, body: await handler(args) });
    } catch (error) {
      this.write({ ...base, success: false, message: error instanceof Error ? error.message : String(error) });
    }
  }
}

function formatErrorBody(body: unknown): string {
  if (typeof body !== "object" || body === null || !("error" in body)) return "";
  const error = body.error;
  if (typeof error !== "object" || error === null || !("format" in error) || typeof error.format !== "string") return "";
  return ` (${error.format})`;
}
