import { readFile } from "node:fs/promises";
import type {
  CodeAction,
  Command,
  Diagnostic,
  DocumentSymbol,
  Location,
  LocationLink,
  SymbolInformation,
} from "./types.js";
import { SEVERITY_NAMES, SYMBOL_KIND_NAMES } from "./types.js";
import { displayPath, uriToFile } from "./uri.js";

const MAX_LOCATIONS = 200;

export function toLocations(result: unknown): Location[] {
  if (!result) return [];
  const items = Array.isArray(result) ? result : [result];
  return items.flatMap((item): Location[] => {
    if (typeof item !== "object" || item === null) return [];
    if ("targetUri" in item) {
      const link = item as LocationLink;
      return [{ uri: link.targetUri, range: link.targetSelectionRange ?? link.targetRange }];
    }
    if ("uri" in item && "range" in item) return [item as Location];
    return [];
  });
}

/** 位置列表：`path:line:col  源码行`，同文件只读一次。 */
export async function formatLocations(locations: readonly Location[], cwd: string): Promise<string> {
  if (locations.length === 0) return "No results.";
  const cache = new Map<string, string[]>();
  const lines: string[] = [];
  for (const location of locations.slice(0, MAX_LOCATIONS)) {
    const path = uriToFile(location.uri);
    let fileLines = cache.get(path);
    if (!fileLines) {
      fileLines = (await readFile(path, "utf8").catch(() => "")).split(/\r?\n/);
      cache.set(path, fileLines);
    }
    const { line, character } = location.range.start;
    const source = (fileLines[line] ?? "").trim();
    lines.push(`${displayPath(path, cwd)}:${line + 1}:${character + 1}${source ? `  ${source}` : ""}`);
  }
  if (locations.length > MAX_LOCATIONS) lines.push(`... ${locations.length - MAX_LOCATIONS} more`);
  return lines.join("\n");
}

export function formatHover(result: unknown): string {
  if (!result || typeof result !== "object" || !("contents" in result)) return "No hover information.";
  const render = (value: unknown): string => {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map(render).filter(Boolean).join("\n\n");
    if (value && typeof value === "object" && "value" in value) {
      const language = "language" in value && typeof value.language === "string" ? value.language : "";
      const text = String(value.value);
      return language ? `\`\`\`${language}\n${text}\n\`\`\`` : text;
    }
    return "";
  };
  return render(result.contents).trim() || "No hover information.";
}

export function formatDiagnostics(path: string, diagnostics: readonly Diagnostic[], source?: string): string[] {
  const sorted = [...diagnostics].sort(
    (a, b) => (a.severity ?? 1) - (b.severity ?? 1) || a.range.start.line - b.range.start.line,
  );
  return sorted.map((diagnostic) => {
    const { line, character } = diagnostic.range.start;
    const severity = SEVERITY_NAMES[diagnostic.severity ?? 1] ?? "error";
    const origin = diagnostic.source ?? source;
    const code = diagnostic.code !== undefined ? ` ${diagnostic.code}` : "";
    const message = diagnostic.message.replace(/\s*\n\s*/g, " ");
    return `${path}:${line + 1}:${character + 1} ${severity}${origin ? ` [${origin}${code}]` : code}: ${message}`;
  });
}

export function formatDocumentSymbols(symbols: readonly (DocumentSymbol | SymbolInformation)[], cwd: string): string {
  if (symbols.length === 0) return "No symbols.";
  const lines: string[] = [];
  const walk = (symbol: DocumentSymbol | SymbolInformation, depth: number) => {
    const kind = SYMBOL_KIND_NAMES[symbol.kind] ?? "symbol";
    if ("location" in symbol) {
      const { line } = symbol.location.range.start;
      const container = symbol.containerName ? ` (in ${symbol.containerName})` : "";
      lines.push(`${displayPath(uriToFile(symbol.location.uri), cwd)}:${line + 1} ${kind} ${symbol.name}${container}`);
      return;
    }
    const detail = symbol.detail ? ` — ${symbol.detail}` : "";
    lines.push(`${"  ".repeat(depth)}${kind} ${symbol.name} @${symbol.selectionRange.start.line + 1}${detail}`);
    for (const child of symbol.children ?? []) walk(child, depth + 1);
  };
  for (const symbol of symbols) walk(symbol, 0);
  return lines.join("\n");
}

export function formatCodeActions(actions: readonly (CodeAction | Command)[]): string {
  if (actions.length === 0) return "No code actions available.";
  return actions
    .map((action, index) => {
      const kind = "kind" in action && action.kind ? ` [${action.kind}]` : "";
      const preferred = "isPreferred" in action && action.isPreferred ? " (preferred)" : "";
      return `${index}: ${action.title}${kind}${preferred}`;
    })
    .join("\n");
}
