export const DEBUG_ACTIONS = [
  "launch", "attach", "set_breakpoint", "remove_breakpoint", "continue", "step_over", "step_in", "step_out",
  "pause", "evaluate", "stack_trace", "threads", "scopes", "variables", "disassemble", "read_memory",
  "modules", "loaded_sources", "custom_request", "output", "terminate", "sessions",
] as const;
export type DebugAction = (typeof DEBUG_ACTIONS)[number];

export const DEBUG_DESCRIPTION = `Debugger access over the Debug Adapter Protocol. Prefer it over print-debugging for program state, breakpoints, stepping, or thread inspection.

- Only one active session at a time. \`program\` is a target path (script/binary/package dir), not a shell command.
- Typical flow: launch (stops on entry for most adapters) → set_breakpoint (file+line or function) → continue → stack_trace / scopes / variables / evaluate → step_over / step_in / step_out → terminate.
- continue/step_* wait up to \`timeout\` seconds for the next stop; if the program keeps running, use pause.
- Adapters (must be installed): gdb, lldb-dap, codelldb, debugpy (Python: \`python -m pip install debugpy\`), dlv (Go, accepts package directories), js-debug-adapter (set JS_DEBUG_DAP_SERVER to dapDebugServer.js), netcoredbg, rdbg, and more; pick one with \`adapter\` or let the program extension decide. Override/add adapters in .zcode/dap.json.
- \`output\` returns captured program stdout/stderr. \`custom_request\` sends any DAP request (\`command\` + \`arguments\`).`;

export const DEBUG_PROPERTIES = {
  action: { type: "string", enum: [...DEBUG_ACTIONS] },
  program: { type: "string", description: "Debug target path; Delve accepts Go package directories" },
  args: { type: "array", items: { type: "string" }, description: "Program arguments" },
  adapter: { type: "string", description: "Adapter id (gdb, lldb-dap, debugpy, dlv, js-debug-adapter, ... or a dap.json entry)" },
  cwd: { type: "string", description: "Working directory for the debuggee (relative to project)" },
  file: { type: "string", description: "Source file for breakpoints" },
  line: { type: "number", description: "Source line (1-based)" },
  function: { type: "string", description: "Function name for function breakpoints" },
  condition: { type: "string", description: "Breakpoint condition" },
  expression: { type: "string", description: "Expression to evaluate" },
  context: { type: "string", description: "Evaluate context: repl | watch | hover | variables | clipboard" },
  frame_id: { type: "number", description: "Stack frame id (default: top frame)" },
  scope_id: { type: "number", description: "Scope variables reference" },
  variable_ref: { type: "number", description: "Variable reference to expand" },
  pid: { type: "number", description: "Process id for attach" },
  port: { type: "number", description: "Remote attach port" },
  host: { type: "string", description: "Remote attach host" },
  levels: { type: "number", description: "Max stack frames" },
  memory_reference: { type: "string", description: "Memory reference or address" },
  instruction_count: { type: "number", description: "Instructions to disassemble" },
  instruction_offset: { type: "number", description: "Instruction offset for disassemble" },
  offset: { type: "number", description: "Byte offset" },
  count: { type: "number", description: "Bytes to read" },
  command: { type: "string", description: "Custom DAP request command" },
  arguments: { type: "object", description: "Custom DAP request arguments" },
  timeout: { type: "number", description: "Per-request timeout in seconds (default 30)" },
};
