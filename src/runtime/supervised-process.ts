import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SupervisedProcess {
  pid: number;
  outputPath: string;
  statusPath: string;
  command: string;
  cwd: string;
  startedAt: number;
}

export interface SupervisedResult {
  code: number | null;
  output: string;
}

export function spawnSupervised(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  dir: string,
): SupervisedProcess {
  mkdirSync(dir, { recursive: true });
  const token = randomUUID();
  const outputPath = join(dir, `${token}.log`);
  const statusPath = join(dir, `${token}.status`);
  writeFileSync(outputPath, "");
  const out = openSync(outputPath, "a");
  const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
  const flag = process.platform === "win32" ? "/d /s /c" : "-c";
  const wrapped =
    process.platform === "win32"
      ? `(${command}) & echo %ERRORLEVEL% > "${statusPath}"`
      : `(${command}); __atom_code=$?; printf '%s' "$__atom_code" > '${statusPath}'; exit $__atom_code`;
  const child = spawn(shell, [flag, wrapped], {
    cwd,
    env,
    detached: process.platform !== "win32",
    stdio: ["ignore", out, out],
  });
  child.unref();
  return {
    pid: child.pid ?? 0,
    outputPath,
    statusPath,
    command,
    cwd,
    startedAt: Date.now(),
  };
}

export function supervisedParams(
  process: SupervisedProcess,
): Record<string, unknown> {
  return { ...process };
}

export function supervisedFromParams(
  params: Record<string, unknown> | undefined,
): SupervisedProcess | undefined {
  if (!params) return undefined;
  const { pid, outputPath, statusPath, command, cwd, startedAt } = params;
  if (
    typeof pid !== "number" ||
    typeof outputPath !== "string" ||
    typeof statusPath !== "string" ||
    typeof command !== "string" ||
    typeof cwd !== "string" ||
    typeof startedAt !== "number"
  ) {
    return undefined;
  }
  return { pid, outputPath, statusPath, command, cwd, startedAt };
}

export function isSupervisedRunning(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readSupervised(process: SupervisedProcess): SupervisedResult {
  const output = existsSync(process.outputPath)
    ? readFileSync(process.outputPath, "utf8")
    : "";
  const code = existsSync(process.statusPath)
    ? Number(readFileSync(process.statusPath, "utf8").trim())
    : null;
  return { code: Number.isFinite(code) ? code : null, output };
}

export function waitSupervised(
  process: SupervisedProcess,
  intervalMs = 100,
  signal?: AbortSignal,
): Promise<SupervisedResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: SupervisedResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => finish(readSupervised(process));
    const poll = () => {
      const current = readSupervised(process);
      if (current.code !== null || !isSupervisedRunning(process.pid)) {
        finish(current);
        return;
      }
      timer = setTimeout(poll, intervalMs);
      timer.unref();
    };
    if (signal?.aborted) onAbort();
    else poll();
  });
}

export function terminateSupervised(
  target: SupervisedProcess,
  signal: NodeJS.Signals = "SIGTERM",
): void {
  try {
    globalThis.process.kill(-target.pid, signal);
  } catch {
    try {
      globalThis.process.kill(target.pid, signal);
    } catch {
      // Already gone.
    }
  }
}
