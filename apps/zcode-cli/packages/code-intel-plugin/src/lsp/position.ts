import { readFile } from "node:fs/promises";
import { CodeIntelInvalidParamsError } from "../tool-contract.js";
import type { Position } from "./types.js";

const OCCURRENCE_SUFFIX = /#(\d+)$/;

/**
 * 解析 1-based `line` 与 `symbol`（子串，`#N` 取第 N 个匹配）或 1-based `column` 为 LSP 位置。
 * 与 omp 一致：找不到或歧义时报错，不静默退回行首。
 */
export async function resolvePosition(
  filePath: string,
  line: number | undefined,
  symbol: string | undefined,
  column: number | undefined,
): Promise<Position> {
  if (line === undefined || line < 1) throw new CodeIntelInvalidParamsError("line (1-based) is required");
  const lines = (await readFile(filePath, "utf8")).split(/\r?\n/);
  const text = lines[line - 1];
  if (text === undefined) {
    throw new CodeIntelInvalidParamsError(`line ${line} is out of range (file has ${lines.length} lines)`);
  }
  if (column !== undefined) return { line: line - 1, character: Math.max(0, column - 1) };
  if (!symbol) throw new CodeIntelInvalidParamsError("symbol (or column) is required to locate the position");

  const match = OCCURRENCE_SUFFIX.exec(symbol);
  const needle = match ? symbol.slice(0, match.index) : symbol;
  const occurrence = match ? Number(match[1]) : 1;
  const indexes: number[] = [];
  for (let index = text.indexOf(needle); index >= 0; index = text.indexOf(needle, index + 1)) indexes.push(index);
  if (indexes.length === 0) {
    throw new CodeIntelInvalidParamsError(`symbol "${needle}" not found on line ${line}: ${text.trim()}`);
  }
  if (!match && indexes.length > 1) {
    throw new CodeIntelInvalidParamsError(
      `symbol "${needle}" occurs ${indexes.length} times on line ${line}; use "${needle}#N" to pick one`,
    );
  }
  const character = indexes[occurrence - 1];
  if (character === undefined) {
    throw new CodeIntelInvalidParamsError(`symbol "${needle}" has only ${indexes.length} match(es) on line ${line}`);
  }
  return { line: line - 1, character };
}
