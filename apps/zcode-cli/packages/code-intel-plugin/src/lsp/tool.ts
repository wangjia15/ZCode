import {
  asArgs,
  optionalBoolean,
  optionalNumber,
  optionalString,
  requireString,
  timeoutMs,
  ToolFailure,
} from "../shared/args.js";
import { CodeIntelInvalidParamsError, type CodeIntelTool } from "../tool-contract.js";
import { diagnostics, hover, navigate, symbols, type LspActionContext } from "./actions.js";
import { LspManager } from "./manager.js";
import { capabilities, codeActions, rawRequest, renameFile, renameSymbol } from "./refactor.js";

const ACTIONS = [
  "diagnostics", "definition", "type_definition", "implementation", "references", "hover", "symbols",
  "rename", "rename_file", "code_actions", "status", "reload", "capabilities", "request",
] as const;
type LspAction = (typeof ACTIONS)[number];

const DEFAULT_TIMEOUT_SECONDS = 20;
const MAX_TIMEOUT_SECONDS = 300;
const WORKSPACE_ALL = "*";

const DESCRIPTION = `Symbol-aware code intelligence from language servers — navigation, refactors, and diagnostics where text search misses callsites.

Operations:
- Position-based (definition, type_definition, implementation, references, hover, rename, code_actions): \`file\` + \`line\` (1-indexed) + \`symbol\` (substring on that line; \`name#N\` for the Nth match) or \`column\` (1-indexed).
- \`rename\` — applies to disk by default; \`apply: false\` previews. Errors without an unambiguous \`symbol\`.
- \`rename_file\` — moves \`file\` to \`new_name\` AND rewrites imports/references (willRenameFiles); applies by default.
- \`code_actions\` — lists actions for the line; apply ONE with \`apply: true\` + \`query\` (index or title substring).
- \`diagnostics\` — \`file\` is a path, glob (\`src/**/*.ts\`), or \`"*"\` for everything running servers have reported.
- \`symbols\` — \`file\` lists document symbols; \`file: "*"\` + \`query\` searches the workspace.
- \`status\` — configured/installed/running servers. \`capabilities\` — server capabilities for \`file\`.
- \`reload\` — restart the server for \`file\`, or all servers (and re-read config) with \`file: "*"\`.
- \`request\` — raw LSP request: \`query\` = method, \`payload\` = JSON params (default: textDocument + position).

Use this instead of text search for renames, references and definitions whenever a server is available: it follows shadowing, re-exports and cross-file usages.
Servers come from the built-in catalog (typescript-language-server, pyright, gopls, rust-analyzer, clangd, …) and must be installed; override in .zcode/lsp.json.`;

export function createLspTool(): CodeIntelTool {
  const managers = new Map<string, LspManager>();
  const managerFor = (cwd: string) => {
    let manager = managers.get(cwd);
    if (!manager) {
      manager = new LspManager(cwd);
      managers.set(cwd, manager);
    }
    return manager;
  };

  return {
    definition: {
      name: "lsp",
      description: DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: [...ACTIONS] },
          file: { type: "string", description: "File path (relative to project), glob, or \"*\"" },
          line: { type: "number", description: "1-indexed line" },
          symbol: { type: "string", description: "Substring on the line locating the symbol; `name#N` for the Nth match" },
          column: { type: "number", description: "1-indexed column (alternative to symbol)" },
          query: { type: "string", description: "Workspace symbol query, code action selector, or raw request method" },
          new_name: { type: "string", description: "New symbol name (rename) or destination path (rename_file)" },
          apply: { type: "boolean", description: "Apply edits (rename/rename_file default true; code_actions default false)" },
          payload: { type: "string", description: "JSON params for action=request" },
          timeout: { type: "number", description: `Timeout in seconds (default ${DEFAULT_TIMEOUT_SECONDS}, max ${MAX_TIMEOUT_SECONDS})` },
        },
        required: ["action"],
      },
    },

    async call(rawArgs, { signal, cwd }) {
      const args = asArgs(rawArgs);
      const action = requireString(args, "action", "lsp") as LspAction;
      if (!ACTIONS.includes(action)) throw new CodeIntelInvalidParamsError(`Unknown lsp action: ${action}`);
      const manager = managerFor(cwd);
      const context: LspActionContext = {
        manager,
        cwd,
        signal,
        timeoutMs: timeoutMs(args, DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS),
      };
      const file = optionalString(args, "file");
      const position = () => ({
        file: requireString(args, "file", action),
        line: optionalNumber(args, "line"),
        symbol: optionalString(args, "symbol"),
        column: optionalNumber(args, "column"),
      });

      try {
        switch (action) {
          case "status":
            return { text: await manager.status() };
          case "reload":
            return { text: await manager.reload(file && file !== WORKSPACE_ALL ? file : undefined) };
          case "diagnostics":
            return { text: await diagnostics(context, file) };
          case "definition":
          case "type_definition":
          case "implementation":
          case "references":
            return { text: await navigate(context, action, position()) };
          case "hover":
            return { text: await hover(context, position()) };
          case "symbols":
            return { text: await symbols(context, file, optionalString(args, "query")) };
          case "rename":
            return {
              text: await renameSymbol(context, {
                ...position(),
                newName: requireString(args, "new_name", action),
                apply: optionalBoolean(args, "apply") ?? true,
              }),
            };
          case "rename_file":
            return {
              text: await renameFile(context, {
                file: requireString(args, "file", action),
                newName: requireString(args, "new_name", action),
                apply: optionalBoolean(args, "apply") ?? true,
              }),
            };
          case "code_actions":
            return {
              text: await codeActions(context, {
                ...position(),
                query: optionalString(args, "query"),
                apply: optionalBoolean(args, "apply") ?? false,
              }),
            };
          case "capabilities":
            return { text: await capabilities(context, requireString(args, "file", action)) };
          case "request":
            return {
              text: await rawRequest(context, {
                ...position(),
                method: requireString(args, "query", action),
                payload: optionalString(args, "payload"),
              }),
            };
        }
      } catch (error) {
        if (error instanceof CodeIntelInvalidParamsError) throw error;
        if (error instanceof ToolFailure || error instanceof Error) return { text: error.message, isError: true };
        throw error;
      }
    },

    async dispose() {
      const all = [...managers.values()];
      managers.clear();
      await Promise.allSettled(all.map((manager) => manager.dispose()));
    },
  };
}
