import { mkdir, rename as renameOnDisk } from "node:fs/promises";
import { dirname } from "node:path";
import { ToolFailure } from "../shared/args.js";
import { CodeIntelInvalidParamsError } from "../tool-contract.js";
import { readyClient, resolveFile, type LspActionContext, type PositionArgs } from "./actions.js";
import { applyWorkspaceEdit, formatEditSummary, previewTextEdits } from "./edits.js";
import { formatCodeActions } from "./format.js";
import { resolvePosition } from "./position.js";
import type { CodeAction, Command, Diagnostic, WorkspaceEdit } from "./types.js";
import { fileToUri } from "./uri.js";

const PREVIEW_LIMIT = 40;

function isWorkspaceEdit(value: unknown): value is WorkspaceEdit {
  return typeof value === "object" && value !== null && ("changes" in value || "documentChanges" in value);
}

async function finishEdit(edit: WorkspaceEdit, context: LspActionContext, apply: boolean): Promise<string> {
  const summary = await applyWorkspaceEdit(edit, context.cwd, !apply);
  const text = formatEditSummary(summary, apply);
  if (apply) return text;
  const preview = await previewTextEdits(edit, context.cwd, PREVIEW_LIMIT);
  return [text, ...preview].join("\n");
}

export async function renameSymbol(
  context: LspActionContext,
  args: PositionArgs & { newName: string; apply: boolean },
): Promise<string> {
  const filePath = resolveFile(args.file, context.cwd);
  const client = await readyClient(context, filePath);
  const position = await resolvePosition(filePath, args.line, args.symbol, args.column);
  const edit = await client.request(
    "textDocument/rename",
    { textDocument: { uri: fileToUri(filePath) }, position, newName: args.newName },
    context,
  );
  if (!isWorkspaceEdit(edit)) throw new ToolFailure("Language server returned no rename edits (symbol not renameable?).");
  return finishEdit(edit, context, args.apply);
}

/** 移动文件并让服务器改写 import：willRenameFiles → 应用编辑 → 磁盘改名 → didRenameFiles。 */
export async function renameFile(
  context: LspActionContext,
  args: { file: string; newName: string; apply: boolean },
): Promise<string> {
  const from = resolveFile(args.file, context.cwd);
  const to = resolveFile(args.newName, context.cwd);
  const client = await readyClient(context, from);
  const files = [{ oldUri: fileToUri(from), newUri: fileToUri(to) }];
  const edit = await client.request("workspace/willRenameFiles", { files }, context).catch(() => null);
  const lines: string[] = [];
  if (isWorkspaceEdit(edit)) lines.push(await finishEdit(edit, context, args.apply));
  else lines.push("Server returned no import updates.");
  if (!args.apply) return [`Would move ${args.file} -> ${args.newName}`, ...lines].join("\n");
  await mkdir(dirname(to), { recursive: true });
  await renameOnDisk(from, to);
  client.notify("workspace/didRenameFiles", { files });
  return [`Moved ${args.file} -> ${args.newName}`, ...lines].join("\n");
}

function overlapsLine(diagnostic: Diagnostic, line: number): boolean {
  return diagnostic.range.start.line <= line && diagnostic.range.end.line >= line;
}

export async function codeActions(
  context: LspActionContext,
  args: PositionArgs & { query?: string; apply: boolean },
): Promise<string> {
  const filePath = resolveFile(args.file, context.cwd);
  if (args.line === undefined) throw new CodeIntelInvalidParamsError("line is required for code_actions");
  const client = await readyClient(context, filePath);
  const line = args.line - 1;
  const start =
    args.symbol || args.column ? await resolvePosition(filePath, args.line, args.symbol, args.column) : { line, character: 0 };
  const end = args.symbol || args.column ? start : { line: line + 1, character: 0 };
  const diagnostics = (client.getDiagnostics(filePath) ?? []).filter((item) => overlapsLine(item, line));
  const result = await client.request(
    "textDocument/codeAction",
    { textDocument: { uri: fileToUri(filePath) }, range: { start, end }, context: { diagnostics } },
    context,
  );
  const actions: Array<CodeAction | Command> = Array.isArray(result) ? result : [];
  if (!args.apply) return formatCodeActions(actions);
  if (!args.query) throw new CodeIntelInvalidParamsError("query (index or title substring) is required to apply a code action");

  const index = /^\d+$/.test(args.query) ? Number(args.query) : -1;
  const matches = index >= 0 ? [actions[index]] : actions.filter((action) => action.title.toLowerCase().includes(args.query!.toLowerCase()));
  const chosen = matches.filter((action): action is CodeAction | Command => action !== undefined);
  if (chosen.length !== 1) {
    throw new ToolFailure(`query "${args.query}" matched ${chosen.length} actions:\n${formatCodeActions(actions)}`);
  }
  let action = chosen[0]!;
  const provider = client.capabilities.codeActionProvider;
  const canResolve = typeof provider === "object" && provider !== null && "resolveProvider" in provider && provider.resolveProvider === true;
  if (!("edit" in action && action.edit) && !("command" in action && typeof action.command === "string") && canResolve) {
    const resolved = await client.request("codeAction/resolve", action, context);
    if (resolved && typeof resolved === "object" && "title" in resolved) action = resolved as CodeAction;
  }
  const lines = [`Applied: ${action.title}`];
  if ("edit" in action && action.edit) lines.push(await finishEdit(action.edit, context, true));
  const command =
    typeof action.command === "string"
      ? { command: action.command, arguments: "arguments" in action ? action.arguments : undefined }
      : action.command;
  if (command) {
    await client.request("workspace/executeCommand", { command: command.command, arguments: command.arguments }, context);
    lines.push(`Executed command ${command.command}`);
  }
  return lines.join("\n");
}

export async function rawRequest(
  context: LspActionContext,
  args: PositionArgs & { method: string; payload?: string },
): Promise<string> {
  const filePath = resolveFile(args.file, context.cwd);
  const client = await readyClient(context, filePath);
  let params: unknown;
  if (args.payload) {
    try {
      params = JSON.parse(args.payload);
    } catch {
      throw new CodeIntelInvalidParamsError("payload must be valid JSON");
    }
  } else {
    const textDocument = { uri: fileToUri(filePath) };
    params =
      args.line === undefined
        ? { textDocument }
        : { textDocument, position: await resolvePosition(filePath, args.line, args.symbol, args.column) };
  }
  const result = await client.request(args.method, params, context);
  return JSON.stringify(result, null, 2) ?? "null";
}

export async function capabilities(context: LspActionContext, file: string): Promise<string> {
  const client = await context.manager.primaryClient(resolveFile(file, context.cwd), context.signal);
  return `${client.server.name} (${client.root})\n${JSON.stringify(client.capabilities, null, 2)}`;
}
