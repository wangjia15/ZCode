import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const packageRoot = resolve(import.meta.dirname, "..");

// ESM 产物里 esbuild 的 __require shim 没有真实 require；注入 createRequire，
// 避免 CJS 依赖在模块求值阶段抛错（同 node-repl-host/scripts/build.mjs）。
const nodeRequireBanner = `import { createRequire as __zcodeCreateRequire } from "node:module";
const require = __zcodeCreateRequire(import.meta.url);`;

export async function buildCodeIntelBundle({
  outfile = resolve(packageRoot, "dist", "mcp", "server.js"),
} = {}) {
  await mkdir(dirname(outfile), { recursive: true });
  await build({
    banner: { js: nodeRequireBanner },
    bundle: true,
    entryPoints: [resolve(packageRoot, "src", "server.ts")],
    format: "esm",
    legalComments: "none",
    outfile,
    platform: "node",
    target: "node24",
  });
  return { outfile };
}

// Windows 上 argv[1] 是反斜杠路径，必须经 pathToFileURL 比较，否则脚本静默不构建。
const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  const { outfile } = await buildCodeIntelBundle();
  console.log(`[code-intel] built ${outfile}`);
}
