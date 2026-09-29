import { relative } from "node:path";
import type { DebugSession } from "./session.js";
import type { DapBreakpoint, DapStackFrame } from "./types.js";

function shortPath(path: string | undefined, cwd: string): string {
  if (!path) return "<unknown>";
  const rel = relative(cwd, path);
  return (rel && !rel.startsWith("..") ? rel : path).replace(/\\/g, "/");
}

export function frameLabel(frame: DapStackFrame, cwd: string): string {
  return `#${frame.id} ${frame.name} @ ${shortPath(frame.source?.path ?? frame.source?.name, cwd)}:${frame.line}:${frame.column}`;
}

export function formatSnapshot(session: DebugSession): string[] {
  const lines = [`Session ${session.id} (${session.adapter.name}): ${session.status}`];
  if (session.program) lines.push(`Program: ${shortPath(session.program, session.cwd)}`);
  if (session.status === "stopped") {
    const reason = session.stop.description ?? session.stop.reason ?? "unknown";
    lines.push(`Stopped: ${reason}${session.stop.text ? ` — ${session.stop.text}` : ""}${session.stop.threadId !== undefined ? ` (thread ${session.stop.threadId})` : ""}`);
    if (session.topFrames.length) {
      lines.push("Top frames:");
      for (const frame of session.topFrames) lines.push(`  ${frameLabel(frame, session.cwd)}`);
    }
  }
  if (session.status === "terminated" && session.exitCode !== undefined) lines.push(`Exit code: ${session.exitCode}`);
  return lines;
}

export function formatOutcome(session: DebugSession, timedOut: boolean, timeoutSeconds: number, verb: string): string {
  const lines = formatSnapshot(session);
  if (timedOut) lines.push(`Program is still running after ${timeoutSeconds}s. Use pause to interrupt and inspect state.`);
  else if (session.status === "stopped") {
    const top = session.topFrames[0];
    lines.push(`${verb} stopped at ${top ? frameLabel(top, session.cwd) : "unknown location"}.`);
  } else if (session.status === "terminated") {
    lines.push(`Program terminated${session.exitCode !== undefined ? ` with exit code ${session.exitCode}` : ""}.`);
  } else lines.push("Program is running.");
  return lines.join("\n");
}

export function formatBreakpoints(
  label: string,
  specs: ReadonlyArray<{ line?: number; name?: string; condition?: string }>,
  reported: readonly DapBreakpoint[],
): string {
  const lines = [`Breakpoints for ${label}:`];
  if (specs.length === 0) return `${lines[0]}\n(none)`;
  specs.forEach((spec, index) => {
    const result = reported[index];
    const where = spec.name ?? `line ${result?.line ?? spec.line}`;
    const state = result ? (result.verified ? "verified" : "pending") : "pending";
    lines.push(`- ${where}: ${state}${spec.condition ? ` if ${spec.condition}` : ""}${result?.message ? ` (${result.message})` : ""}`);
  });
  return lines.join("\n");
}

type Row = Record<string, unknown>;

function rows(body: unknown, key: string): Row[] {
  if (typeof body !== "object" || body === null || !(key in body)) return [];
  const value: unknown = Reflect.get(body, key);
  return Array.isArray(value) ? value.filter((item): item is Row => typeof item === "object" && item !== null) : [];
}

const text = (value: unknown) => (value === undefined || value === null ? "" : String(value));

export function formatList(title: string, body: unknown, key: string, render: (row: Row) => string): string {
  const items = rows(body, key);
  return [`${title}:`, ...(items.length ? items.map((item) => `- ${render(item)}`) : ["(none)"])].join("\n");
}

export const renderThread = (row: Row) => `${text(row.id)}: ${text(row.name)}`;
export const renderScope = (row: Row) =>
  `${text(row.name)}: ref=${text(row.variablesReference)}${row.expensive ? ", expensive" : ""}`;
export const renderVariable = (row: Row) =>
  `${text(row.name)} = ${text(row.value)}${row.type ? ` (${text(row.type)})` : ""}${Number(row.variablesReference) > 0 ? ` [ref=${text(row.variablesReference)}]` : ""}`;
export const renderModule = (row: Row) => `${text(row.id)} ${text(row.name)}${row.path ? ` ${text(row.path)}` : ""}${row.symbolStatus ? ` [${text(row.symbolStatus)}]` : ""}`;
export const renderSource = (row: Row) => `${text(row.path ?? row.name)}${row.sourceReference ? ` [ref=${text(row.sourceReference)}]` : ""}`;
export const renderInstruction = (row: Row) =>
  [text(row.address), text(row.instructionBytes), text(row.instruction), row.symbol ? `<${text(row.symbol)}>` : ""].filter(Boolean).join("  ");

export function formatStack(body: unknown, cwd: string): string {
  const frames = rows(body, "stackFrames") as unknown as DapStackFrame[];
  return ["Stack trace:", ...(frames.length ? frames.map((frame) => `- ${frameLabel(frame, cwd)}`) : ["(empty)"])].join("\n");
}

export function formatEvaluation(body: unknown): string {
  if (typeof body !== "object" || body === null) return "Result: (none)";
  const result = "result" in body ? text(body.result) : "";
  const type = "type" in body && body.type ? `\nType: ${text(body.type)}` : "";
  const ref = "variablesReference" in body && Number(body.variablesReference) > 0 ? `\nVariables ref: ${text(body.variablesReference)}` : "";
  return `Result: ${result}${type}${ref}`;
}

export function formatMemory(body: unknown): string {
  if (typeof body !== "object" || body === null || !("address" in body)) return "No memory returned.";
  const data = "data" in body && typeof body.data === "string" ? Buffer.from(body.data, "base64") : Buffer.alloc(0);
  const lines = [`Memory at ${text(body.address)}:`];
  for (let offset = 0; offset < data.length; offset += 16) {
    const chunk = data.subarray(offset, offset + 16);
    const hex = Array.from(chunk, (byte) => byte.toString(16).padStart(2, "0")).join(" ");
    const ascii = Array.from(chunk, (byte) => (byte >= 32 && byte < 127 ? String.fromCharCode(byte) : ".")).join("");
    lines.push(`+0x${offset.toString(16).padEnd(6)} ${hex.padEnd(47)} |${ascii}|`);
  }
  if (data.length === 0) lines.push("(no readable bytes)");
  return lines.join("\n");
}

export function formatSessions(sessions: readonly DebugSession[]): string {
  if (sessions.length === 0) return "No debug sessions.";
  return sessions
    .map((session) =>
      [
        `${session.id}: ${session.status}${session.parent ? ` (child of ${session.parent.id})` : ""}`,
        `  adapter=${session.adapter.name}`,
        `  cwd=${session.cwd}`,
        ...(session.program ? [`  program=${session.program}`] : []),
        ...(session.topFrames[0] ? [`  location=${frameLabel(session.topFrames[0], session.cwd)}`] : []),
        ...(session.stop.reason && session.status === "stopped" ? [`  reason=${session.stop.reason}`] : []),
      ].join("\n"),
    )
    .join("\n\n");
}
