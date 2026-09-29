import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";

const IS_WINDOWS = process.platform === "win32";
const DEFAULT_WINDOWS_PATHEXT = ".COM;.EXE;.BAT;.CMD";
const WINDOWS_SHELL_EXTENSIONS = new Set([".cmd", ".bat"]);
const GRACEFUL_KILL_DELAY_MS = 2_000;

async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, IS_WINDOWS ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function candidateNames(command: string): string[] {
  if (!IS_WINDOWS || extname(command)) return [command];
  const extensions = (process.env.PATHEXT ?? DEFAULT_WINDOWS_PATHEXT)
    .split(";")
    .filter(Boolean)
    .map((ext) => ext.toLowerCase());
  return extensions.map((ext) => `${command}${ext}`);
}

/** 从 cwd 向上各级 node_modules/.bin，再到 PATH 查找可执行文件；找不到返回 undefined。 */
export async function resolveCommand(command: string, cwd: string): Promise<string | undefined> {
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    const full = resolve(cwd, command);
    for (const name of candidateNames(full)) if (await isExecutable(name)) return name;
    return undefined;
  }
  const dirs: string[] = [];
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    dirs.push(join(dir, "node_modules", ".bin"));
    if (dirname(dir) === dir) break;
  }
  dirs.push(...(process.env.PATH ?? process.env.Path ?? "").split(delimiter).filter(Boolean));
  for (const dir of dirs) {
    for (const name of candidateNames(command)) {
      const full = join(dir, name);
      if (await isExecutable(full)) return full;
    }
  }
  return undefined;
}

function quoteWindowsArg(arg: string): string {
  if (arg && !/[\s"&|<>^%]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

/**
 * 以参数数组启动子进程。Windows 上 .cmd/.bat 不能直接 spawn（EINVAL），
 * 需经 cmd.exe /d /s /c 并自行加引号。
 */
export function spawnProcess(
  executable: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): ChildProcessWithoutNullStreams {
  const env = { ...process.env, ...options.env };
  if (IS_WINDOWS && WINDOWS_SHELL_EXTENSIONS.has(extname(executable).toLowerCase())) {
    const line = [executable, ...args].map(quoteWindowsArg).join(" ");
    return spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
      cwd: options.cwd,
      env,
      stdio: "pipe",
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
  }
  return spawn(executable, [...args], { cwd: options.cwd, env, stdio: "pipe", windowsHide: true });
}

/** 结束进程及其子进程；Windows 用 taskkill /T，其余平台先 SIGTERM 再 SIGKILL。 */
export async function killProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  if (IS_WINDOWS) {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, GRACEFUL_KILL_DELAY_MS).unref();
  }
  await Promise.race([exited, new Promise((r) => setTimeout(r, GRACEFUL_KILL_DELAY_MS * 2).unref())]);
}

export function installHint(command: string): string {
  return `Install \`${command}\` and make sure it is on PATH (or in the project's node_modules/.bin).`;
}
