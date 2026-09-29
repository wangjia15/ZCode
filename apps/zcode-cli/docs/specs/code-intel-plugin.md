# code-intel 插件：LSP 与本地调试（DAP）

## 背景

omp（oh-my-pi，MIT）提供 `lsp`（语言服务器查询/重构）与 `debug`（Debug Adapter Protocol 本地调试）两个工具。
ZCode 通过插件机制接入：插件只以 MCP server 暴露能力，不修改 core 工具面。

## 交付形态

- 工作区包 `apps/zcode-cli/packages/code-intel-plugin`（`@zcode/code-intel-plugin`）。
- 插件清单 `.zcode-plugin/plugin.json`，名称 `code-intel`，内联 `mcpServers.code-intel`：
  `node ${ZCODE_PLUGIN_ROOT}/dist/mcp/server.js`，`cwd = ${ZCODE_PROJECT_DIR}`。
- 构建：esbuild 打成单文件 `dist/mcp/server.js`（ESM，node24，无运行时 npm 依赖）。
- 启用：把包目录加入用户配置 `plugins.dirs`；本次不注册为官方 bundled 插件。
- 从 omp 移植的代码保留 MIT 署名（`THIRD-PARTY-NOTICES.md`）。

## 工具

MCP 工具名 `lsp`、`debug`。插件 MCP server 名为 `plugin:code-intel:code-intel`，模型侧可见名为
`mcp__plugin_code-intel_code-intel__lsp` / `mcp__plugin_code-intel_code-intel__debug`。
server 同时接受 modern 与 legacy MCP 协议（`serveStdio` 的 `legacy: "serve"`）。

### lsp

| action | 说明 |
|---|---|
| `diagnostics` | 路径 / glob / `"*"`（已启动服务器推送过的全部诊断）；支持 pull diagnostics，否则等待 publishDiagnostics |
| `definition` / `type_definition` / `implementation` / `references` / `hover` | 位置查询，`file` + `line`(1-based) + `symbol`（`name#N` 取第 N 个）或 `column` |
| `symbols` | `file` 列 documentSymbol；`file: "*"` + `query` 做 workspace/symbol |
| `rename` | workspace rename；`apply=false` 仅预览，默认应用到磁盘 |
| `rename_file` | 移动文件并按 willRenameFiles 改写 import；默认应用 |
| `code_actions` | 列出；`apply=true` + `query`（序号或标题子串）应用唯一一个 |
| `status` / `capabilities` | 已配置 / 未安装 / 运行中的服务器；某文件对应服务器的能力 |
| `reload` | 重启某文件对应的服务器；`"*"` 关闭全部并重读配置 |
| `request` | 原始 LSP 请求：`query` = method，`payload` = JSON 参数 |

- 工程级请求前等待服务器的 `$/progress`（工程加载 / 索引）结束：首个 didOpen 后给 1.5s 窗口等待 progress 开始。
  否则 tsserver 在工程加载完成前只返回已打开文件内的引用，重命名会漏改调用点。
- 以 `_` 开头的厂商私有反向请求（如 tsserver 重构后的 `_typescript.rename` UI 钩子）回 `null`，其余未知方法回 MethodNotFound。

- 服务器目录沿用 omp `defaults.json`（按扩展名/根标记选择，命令需在 PATH 或项目 `node_modules/.bin`）。
- 项目 / 用户可用 `.zcode/lsp.json`、`~/.zcode/lsp.json` 覆盖（与 omp `lsp.json` 同构）。
- 语言服务器按 (serverName, workspaceRoot) 懒启动并在 MCP server 进程内复用，进程退出时全部关闭。
- 不移植：omp 的写后格式化/诊断回写（writethrough，依赖宿主 Edit 工具钩子）、lspmux 守护进程、biome/swiftlint 专用客户端。

### debug

| action | 说明 |
|---|---|
| `launch` / `attach` | 启动或附加调试会话，适配器按程序类型或 `adapter` 选择 |
| `set_breakpoint` / `remove_breakpoint` | 源码行断点（可带 condition）、函数断点 |
| `continue` / `step_over` / `step_in` / `step_out` / `pause` | 执行控制，等待下一个 stopped/terminated |
| `threads` / `stack_trace` / `scopes` / `variables` / `evaluate` | 状态检查 |
| `output` | 读取被调试程序输出 |
| `sessions` / `terminate` | 会话列表 / 结束 |

- 适配器目录沿用 omp `dap/defaults.json`（gdb、lldb-dap、debugpy、dlv、js-debug 等），需本机已安装。
- 同时最多一个活动会话（与 omp 一致）；会话随 MCP server 进程退出而终止。
- 启动参数带 `stopOnEntry` / `stopAtEntry` 时，按整个请求超时等待入口暂停（Windows 上 debugpy 实测约 15s）；否则只等 5s。
- js-debug 的 `startDebugging` 子会话在同一 TCP 端口上新开连接，断点同步到整个会话树（未在本机实测）。
- 未移植 omp 的指令断点、数据断点、write_memory；可用 `custom_request` 直接发 DAP 请求。

## 失败语义

- 找不到语言服务器 / 适配器：返回 `isError` 文本，列出期望的命令名与安装提示，不抛出协议错误。
- 参数非法：MCP `INVALID_PARAMS`。
- 请求超时（默认 lsp 20s，debug 30s，可用 `timeout` 覆盖）：返回 `isError`，服务器保持运行。
- 取消：MCP 请求 signal 中止挂起的 LSP/DAP 请求。

## 调试入口

`ZCODE_CODE_INTEL_TRACE=1` 时把 LSP/DAP 原始消息（截断 2000 字符）写到 MCP server 的 stderr；默认关闭，因为可能包含源码和变量值。

## 平台

Windows / macOS / Linux：子进程用参数数组 `spawn`，Windows 解析 `.cmd`/`.exe`；路径与 URI 用 `node:url` 转换。

## 验收

1. 启用插件后 `zcode` 会话里出现 `mcp__plugin_code-intel_code-intel__lsp`、`mcp__plugin_code-intel_code-intel__debug`。
2. TypeScript 项目：`lsp definition/references/hover/diagnostics/rename(apply=false)` 返回正确结果。
3. Node 或 Python 程序：`debug launch` → `set_breakpoint` → `continue` 停在断点 → `variables`/`evaluate` → `terminate`。
