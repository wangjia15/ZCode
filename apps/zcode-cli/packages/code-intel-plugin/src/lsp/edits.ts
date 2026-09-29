import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DocumentChange, Position, TextEdit, WorkspaceEdit } from "./types.js";
import { displayPath, uriToFile } from "./uri.js";

export interface EditSummary {
  files: Array<{ path: string; edits: number }>;
  created: string[];
  renamed: Array<{ from: string; to: string }>;
  deleted: string[];
}

function offsetAt(text: string, lineStarts: number[], position: Position): number {
  const lineStart = lineStarts[position.line] ?? text.length;
  const nextLine = lineStarts[position.line + 1] ?? text.length;
  // LSP 使用 UTF-16 code unit 偏移，与 JS 字符串索引一致；越界时夹到行尾。
  return Math.min(lineStart + position.character, nextLine);
}

function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

/** 按 LSP 规则把 TextEdit 应用到文本：先按起点倒序，避免前面的替换移动后面的偏移。 */
export function applyTextEdits(text: string, edits: readonly TextEdit[]): string {
  const lineStarts = computeLineStarts(text);
  const resolved = edits
    .map((edit, order) => ({
      start: offsetAt(text, lineStarts, edit.range.start),
      end: offsetAt(text, lineStarts, edit.range.end),
      newText: edit.newText,
      order,
    }))
    .sort((a, b) => b.start - a.start || b.order - a.order);
  let result = text;
  for (const edit of resolved) {
    result = result.slice(0, edit.start) + edit.newText + result.slice(edit.end);
  }
  return result;
}

function normalizeChanges(edit: WorkspaceEdit): DocumentChange[] {
  if (edit.documentChanges?.length) return edit.documentChanges;
  return Object.entries(edit.changes ?? {}).map(([uri, edits]) => ({ textDocument: { uri }, edits }));
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

/** 把 WorkspaceEdit 写入磁盘并返回摘要；`dryRun` 时只统计不落盘。 */
export async function applyWorkspaceEdit(edit: WorkspaceEdit, cwd: string, dryRun = false): Promise<EditSummary> {
  const summary: EditSummary = { files: [], created: [], renamed: [], deleted: [] };
  for (const change of normalizeChanges(edit)) {
    if ("kind" in change && change.kind === "create") {
      const path = uriToFile(change.uri);
      summary.created.push(displayPath(path, cwd));
      if (dryRun || ((await exists(path)) && !change.options?.overwrite)) continue;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "", "utf8");
    } else if ("kind" in change && change.kind === "rename") {
      const from = uriToFile(change.oldUri);
      const to = uriToFile(change.newUri);
      summary.renamed.push({ from: displayPath(from, cwd), to: displayPath(to, cwd) });
      if (dryRun || ((await exists(to)) && !change.options?.overwrite)) continue;
      await mkdir(dirname(to), { recursive: true });
      await rename(from, to);
    } else if ("kind" in change && change.kind === "delete") {
      const path = uriToFile(change.uri);
      summary.deleted.push(displayPath(path, cwd));
      if (!dryRun) await rm(path, { recursive: change.options?.recursive ?? false, force: true });
    } else if ("textDocument" in change) {
      const path = uriToFile(change.textDocument.uri);
      summary.files.push({ path: displayPath(path, cwd), edits: change.edits.length });
      if (dryRun) continue;
      const original = await readFile(path, "utf8");
      await writeFile(path, applyTextEdits(original, change.edits), "utf8");
    }
  }
  return summary;
}

export function formatEditSummary(summary: EditSummary, applied: boolean): string {
  const verb = applied ? "Applied" : "Would apply";
  const lines: string[] = [];
  const total = summary.files.reduce((sum, file) => sum + file.edits, 0);
  if (summary.files.length) lines.push(`${verb} ${total} edit(s) in ${summary.files.length} file(s):`);
  for (const file of summary.files) lines.push(`  ${file.path} (${file.edits})`);
  for (const path of summary.created) lines.push(`  create ${path}`);
  for (const { from, to } of summary.renamed) lines.push(`  rename ${from} -> ${to}`);
  for (const path of summary.deleted) lines.push(`  delete ${path}`);
  return lines.length ? lines.join("\n") : "No edits.";
}

/** 预览：展示每个文件中将被替换的片段（最多 N 条）。 */
export async function previewTextEdits(edit: WorkspaceEdit, cwd: string, limit: number): Promise<string[]> {
  const lines: string[] = [];
  for (const change of normalizeChanges(edit)) {
    if (!("textDocument" in change)) continue;
    const path = uriToFile(change.textDocument.uri);
    const text = await readFile(path, "utf8").catch(() => "");
    const fileLines = text.split(/\r?\n/);
    for (const textEdit of change.edits) {
      if (lines.length >= limit) return [...lines, "  ..."];
      const { line, character } = textEdit.range.start;
      const source = (fileLines[line] ?? "").trim();
      lines.push(`  ${displayPath(path, cwd)}:${line + 1}:${character + 1}  ${source}  ->  ${JSON.stringify(textEdit.newText)}`);
    }
  }
  return lines;
}
