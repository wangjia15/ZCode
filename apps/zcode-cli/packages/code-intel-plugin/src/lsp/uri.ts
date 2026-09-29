import { basename, extname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function fileToUri(filePath: string): string {
  return pathToFileURL(resolve(filePath)).href;
}

export function uriToFile(uri: string): string {
  return uri.startsWith("file:") ? fileURLToPath(uri) : uri;
}

/** Windows 上不同服务器返回的 URI 盘符大小写 / 编码不同，比较前统一。 */
export function normalizeUriKey(uri: string): string {
  return uri.startsWith("file:") ? fileToUri(uriToFile(uri)).toLowerCase() : uri;
}

export function displayPath(filePath: string, cwd: string): string {
  const rel = relative(cwd, filePath);
  return rel && !rel.startsWith("..") ? rel.replace(/\\/g, "/") : filePath.replace(/\\/g, "/");
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescriptreact",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascriptreact",
  py: "python", pyi: "python", rs: "rust", go: "go", mod: "go.mod", sum: "go.sum",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hxx: "cpp", cu: "cuda-cpp",
  m: "objective-c", mm: "objective-cpp", java: "java", kt: "kotlin", kts: "kotlin",
  scala: "scala", sbt: "scala", sc: "scala", hs: "haskell", lhs: "haskell",
  ml: "ocaml", mli: "ocaml", ex: "elixir", exs: "elixir", heex: "phoenix-heex", eex: "eex",
  erl: "erlang", hrl: "erlang", gleam: "gleam", rb: "ruby", rake: "ruby", gemspec: "ruby", erb: "erb",
  sh: "shellscript", bash: "shellscript", zsh: "shellscript", lua: "lua", php: "php", phtml: "php",
  cs: "csharp", csx: "csharp", yaml: "yaml", yml: "yaml", tf: "terraform", tfvars: "terraform-vars",
  dockerfile: "dockerfile", nix: "nix", odin: "odin", dart: "dart", md: "markdown", markdown: "markdown",
  tex: "latex", bib: "bibtex", graphql: "graphql", gql: "graphql", prisma: "prisma", vim: "vim",
  html: "html", htm: "html", css: "css", scss: "scss", sass: "sass", less: "less",
  json: "json", jsonc: "jsonc", vue: "vue", svelte: "svelte", astro: "astro", zig: "zig",
  swift: "swift", tla: "tlaplus", tpl: "helm",
};

export function languageIdFor(filePath: string): string {
  const name = basename(filePath).toLowerCase();
  if (name === "dockerfile") return "dockerfile";
  const ext = extname(name).slice(1);
  return LANGUAGE_BY_EXTENSION[ext] ?? (ext || "plaintext");
}
