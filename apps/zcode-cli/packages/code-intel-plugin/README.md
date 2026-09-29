# code-intel plugin

ZCode plugin that exposes two MCP tools, ported from oh-my-pi (MIT, see `THIRD-PARTY-NOTICES.md`):

- `lsp` — language-server code intelligence: diagnostics, definition, type_definition, implementation, references, hover, symbols, rename, code_actions, status, reload.
- `debug` — local debugging over the Debug Adapter Protocol: launch/attach, breakpoints, stepping, threads, stack, scopes, variables, evaluate, program output.

Behavior and failure semantics: `apps/zcode-cli/docs/specs/code-intel-plugin.md`.

## Build

```sh
pnpm --filter @zcode/code-intel-plugin build
```

Produces `dist/mcp/server.js` (single-file ESM bundle, no runtime npm dependencies).

## Enable

Add the package directory to the user config (`~/.zcode/cli/config.json`):

```json
{
  "plugins": {
    "enabled": true,
    "dirs": ["/absolute/path/to/apps/zcode-cli/packages/code-intel-plugin"]
  }
}
```

The tools appear as `mcp__plugin_code-intel_code-intel__lsp` and `mcp__plugin_code-intel_code-intel__debug`. Set `ZCODE_CODE_INTEL_TRACE=1` to log raw LSP/DAP traffic to the MCP server stderr.

## Requirements

Language servers and debug adapters are not bundled; install the ones you need so they are on `PATH` (or in the project's `node_modules/.bin`), e.g. `typescript-language-server`, `pyright`, `gopls`, `rust-analyzer`, `debugpy`, `lldb-dap`, `gdb`, `dlv`. Override or add servers with `.zcode/lsp.json` in the project or `~/.zcode/lsp.json`.
