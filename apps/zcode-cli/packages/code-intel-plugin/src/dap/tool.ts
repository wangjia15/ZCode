import { isAbsolute, resolve } from "node:path";
import {
  asArgs,
  optionalNumber,
  optionalRecord,
  optionalString,
  optionalStringArray,
  requireString,
  timeoutMs,
  ToolFailure,
  type ToolArgs,
} from "../shared/args.js";
import { CodeIntelInvalidParamsError, type CodeIntelTool } from "../tool-contract.js";
import type { DapRequestOptions } from "./client.js";
import {
  adapterUnavailableMessage,
  availableAdapters,
  classifyProgram,
  launchOverrides,
  selectAttachAdapter,
  selectLaunchAdapter,
} from "./config.js";
import {
  formatBreakpoints,
  formatEvaluation,
  formatList,
  formatMemory,
  formatOutcome,
  formatSessions,
  formatSnapshot,
  formatStack,
  renderInstruction,
  renderModule,
  renderScope,
  renderSource,
  renderThread,
  renderVariable,
} from "./format.js";
import { DebugSessionManager } from "./manager.js";
import { DEBUG_ACTIONS, DEBUG_DESCRIPTION, DEBUG_PROPERTIES, type DebugAction } from "./schema.js";

const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 600;
const DEFAULT_STACK_LEVELS = 20;

const EXECUTION_COMMANDS = {
  continue: ["continue", "Continue"],
  step_over: ["next", "Step over"],
  step_in: ["stepIn", "Step in"],
  step_out: ["stepOut", "Step out"],
} as const;

function requireCapability(manager: DebugSessionManager, capability: string, description: string) {
  const session = manager.requireActive();
  if (session.capabilities[capability] !== true) {
    throw new ToolFailure(`${session.adapter.name} does not support ${description}.`);
  }
  return session;
}

async function defaultFrameId(manager: DebugSessionManager, args: ToolArgs, options: DapRequestOptions): Promise<number | undefined> {
  const explicit = optionalNumber(args, "frame_id");
  if (explicit !== undefined) return explicit;
  const session = manager.requireActive();
  if (session.status !== "stopped") return undefined;
  if (session.topFrames[0]) return session.topFrames[0].id;
  const threadId = await manager.threadId(session, options);
  const body = await session.client.request("stackTrace", { threadId, startFrame: 0, levels: 1 }, options);
  const frames = typeof body === "object" && body !== null && "stackFrames" in body && Array.isArray(body.stackFrames) ? body.stackFrames : [];
  const top: unknown = frames[0];
  return typeof top === "object" && top !== null && "id" in top && typeof top.id === "number" ? top.id : undefined;
}

async function runAction(manager: DebugSessionManager, action: DebugAction, args: ToolArgs, cwd: string, options: DapRequestOptions): Promise<string> {
  const timeoutSeconds = Math.round(options.timeoutMs / 1000);
  const request = (command: string, body: unknown) => manager.requireActive().client.request(command, body, options);
  switch (action) {
    case "launch": {
      const commandCwd = resolve(cwd, optionalString(args, "cwd") ?? ".");
      const programArg = requireString(args, "program", action);
      const program = isAbsolute(programArg) ? programArg : resolve(commandCwd, programArg);
      const kind = await classifyProgram(program);
      const selection = await selectLaunchAdapter(program, commandCwd, kind, optionalString(args, "adapter"));
      if (selection.kind === "unavailable") throw new ToolFailure(adapterUnavailableMessage(selection.adapterName, selection.command));
      if (selection.kind === "none") {
        const installed = (await availableAdapters(commandCwd)).map((adapter) => adapter.name).join(", ") || "none";
        throw new ToolFailure(`No debug adapter matches ${programArg}. Installed adapters: ${installed}`);
      }
      if (kind === "directory" && !selection.adapter.acceptsDirectoryProgram) {
        throw new ToolFailure(`launch program is a directory: ${programArg}. Pass an executable/script path or an adapter that accepts packages (dlv).`);
      }
      const session = await manager.launch(
        { adapter: selection.adapter, program, args: optionalStringArray(args, "args"), cwd: commandCwd, extra: launchOverrides(selection.adapter, program, kind) },
        options,
      );
      return formatSnapshot(session).join("\n");
    }
    case "attach": {
      const pid = optionalNumber(args, "pid");
      const port = optionalNumber(args, "port");
      const adapterName = optionalString(args, "adapter");
      if (pid === undefined && port === undefined && !adapterName) throw new CodeIntelInvalidParamsError("attach requires pid or port");
      const commandCwd = resolve(cwd, optionalString(args, "cwd") ?? ".");
      const adapter = await selectAttachAdapter(commandCwd, adapterName, port);
      if (!adapter) throw new ToolFailure(adapterName ? adapterUnavailableMessage(adapterName, adapterName) : "No debug adapter available for attach.");
      const session = await manager.attach({ adapter, cwd: commandCwd, pid, port, host: optionalString(args, "host") }, options);
      return formatSnapshot(session).join("\n");
    }
    case "set_breakpoint":
    case "remove_breakpoint": {
      const remove = action === "remove_breakpoint";
      const fn = optionalString(args, "function");
      if (fn) {
        const result = await manager.updateFunctionBreakpoint(fn, optionalString(args, "condition"), remove, options);
        return formatBreakpoints("functions", result.breakpoints, result.reported);
      }
      const file = optionalString(args, "file");
      const line = optionalNumber(args, "line");
      if (!file || line === undefined) throw new CodeIntelInvalidParamsError(`${action} requires file+line or function`);
      const result = await manager.updateLineBreakpoint(file, line, optionalString(args, "condition"), remove, options);
      return formatBreakpoints(result.path, result.specs, result.reported);
    }
    case "continue":
    case "step_over":
    case "step_in":
    case "step_out": {
      const [command, verb] = EXECUTION_COMMANDS[action];
      const outcome = await manager.execute(command, options);
      return formatOutcome(outcome.session, outcome.timedOut, timeoutSeconds, verb);
    }
    case "pause":
      return [...formatSnapshot(await manager.pause(options)), "Program paused."].join("\n");
    case "evaluate": {
      const expression = requireString(args, "expression", action);
      const frameId = await defaultFrameId(manager, args, options);
      const body = await request("evaluate", { expression, context: optionalString(args, "context") ?? "repl", ...(frameId !== undefined ? { frameId } : {}) });
      return formatEvaluation(body);
    }
    case "stack_trace": {
      const session = manager.requireActive();
      const threadId = await manager.threadId(session, options);
      const body = await request("stackTrace", { threadId, startFrame: 0, levels: optionalNumber(args, "levels") ?? DEFAULT_STACK_LEVELS });
      return formatStack(body, session.cwd);
    }
    case "threads":
      return formatList("Threads", await request("threads", {}), "threads", renderThread);
    case "scopes": {
      const frameId = await defaultFrameId(manager, args, options);
      if (frameId === undefined) throw new ToolFailure("scopes needs a stopped program or frame_id");
      return formatList("Scopes", await request("scopes", { frameId }), "scopes", renderScope);
    }
    case "variables": {
      const reference = optionalNumber(args, "variable_ref") ?? optionalNumber(args, "scope_id");
      if (reference === undefined) throw new CodeIntelInvalidParamsError("variables requires variable_ref or scope_id");
      return formatList("Variables", await request("variables", { variablesReference: reference }), "variables", renderVariable);
    }
    case "disassemble": {
      requireCapability(manager, "supportsDisassembleRequest", "disassembly");
      const body = await request("disassemble", {
        memoryReference: requireString(args, "memory_reference", action),
        instructionCount: optionalNumber(args, "instruction_count") ?? 20,
        offset: optionalNumber(args, "offset"),
        instructionOffset: optionalNumber(args, "instruction_offset"),
        resolveSymbols: true,
      });
      return formatList("Disassembly", body, "instructions", renderInstruction);
    }
    case "read_memory": {
      requireCapability(manager, "supportsReadMemoryRequest", "memory reads");
      const count = optionalNumber(args, "count");
      if (count === undefined) throw new CodeIntelInvalidParamsError("count is required for read_memory");
      return formatMemory(await request("readMemory", { memoryReference: requireString(args, "memory_reference", action), count, offset: optionalNumber(args, "offset") }));
    }
    case "modules":
      requireCapability(manager, "supportsModulesRequest", "module introspection");
      return formatList("Modules", await request("modules", {}), "modules", renderModule);
    case "loaded_sources":
      requireCapability(manager, "supportsLoadedSourcesRequest", "loaded sources");
      return formatList("Loaded sources", await request("loadedSources", {}), "sources", renderSource);
    case "custom_request": {
      const command = requireString(args, "command", action);
      const body = await request(command, optionalRecord(args, "arguments") ?? {});
      return `${command} response:\n${JSON.stringify(body ?? null, null, 2)}`;
    }
    case "output": {
      const session = manager.requireActive();
      let root = session;
      while (root.parent) root = root.parent;
      return root.output.length ? root.output : "(no output captured)";
    }
    case "terminate": {
      const session = await manager.terminate(options);
      return session ? [...formatSnapshot(session), "Debug session terminated."].join("\n") : "No debug session to terminate.";
    }
    case "sessions":
      return formatSessions(manager.list());
  }
}

export function createDebugTool(): CodeIntelTool {
  const manager = new DebugSessionManager();
  return {
    definition: {
      name: "debug",
      description: DEBUG_DESCRIPTION,
      inputSchema: { type: "object", properties: DEBUG_PROPERTIES, required: ["action"] },
    },
    async call(rawArgs, { signal, cwd }) {
      const args = asArgs(rawArgs);
      const action = requireString(args, "action", "debug");
      if (!(DEBUG_ACTIONS as readonly string[]).includes(action)) throw new CodeIntelInvalidParamsError(`Unknown debug action: ${action}`);
      const options: DapRequestOptions = { signal, timeoutMs: timeoutMs(args, DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS) };
      try {
        return { text: await runAction(manager, action as DebugAction, args, cwd, options) };
      } catch (error) {
        if (error instanceof CodeIntelInvalidParamsError) throw error;
        return { text: error instanceof Error ? error.message : String(error), isError: true };
      }
    },
    dispose: () => manager.dispose(),
  };
}
