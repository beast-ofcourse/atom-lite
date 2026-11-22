import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export interface SupervisedProcess {
  pid: number;
  outputPath: string;
  statusPath: string;
  command: string;
  cwd: string;
  startedAt: number;
  token: string;
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
  const win32 = process.platform === "win32";
  const shell = win32 ? "cmd.exe" : "/bin/sh";
  const wrapped = win32
    ? `(${command}) & echo !ERRORLEVEL! > "${statusPath}"`
    : `(${command}); __atom_code=$?; printf '%s' "$__atom_code" > '${statusPath}'; exit $__atom_code # atom:${token}`;
  const args = win32
    ? ["/v:on", "/d", "/s", "/c", wrapped]
    : ["-c", wrapped];
  const child = spawn(shell, args, {
    cwd,
    env,
    detached: !win32,
    stdio: ["ignore", out, out],
  });
  closeSync(out);
  child.unref();
  return {
    pid: child.pid ?? 0,
    outputPath,
    statusPath,
    command,
    cwd,
    startedAt: Date.now(),
    token,
  };
}

export function supervisedParams(
  target: SupervisedProcess,
): Record<string, unknown> {
  return { ...target };
}

export function supervisedFromParams(
  params: Record<string, unknown> | undefined,
): SupervisedProcess | undefined {
  if (!params) return undefined;
  const { pid, outputPath, statusPath, command, cwd, startedAt, token } = params;
  if (
    typeof pid !== "number" ||
    typeof outputPath !== "string" ||
    typeof statusPath !== "string" ||
    typeof command !== "string" ||
    typeof cwd !== "string" ||
    typeof startedAt !== "number" ||
    typeof token !== "string"
  ) {
    return undefined;
  }
  return { pid, outputPath, statusPath, command, cwd, startedAt, token };
}

function sameProcess(target: SupervisedProcess): boolean {
  if (!target.pid) return false;
  if (process.platform !== "linux") {
    try {
      globalThis.process.kill(target.pid, 0);
      return true;
    } catch {
      return false;
    }
  }
  try {
    const cmdline = readFileSync(`/proc/${target.pid}/cmdline`, "utf8");
    return cmdline.includes(target.token);
  } catch {
    return false;
  }
}

export function isSupervisedProcessRunning(
  target: SupervisedProcess,
): boolean {
  return !isSupervisedFinished(target) && sameProcess(target);
}

export function isSupervisedFinished(target: SupervisedProcess): boolean {
  return readStatusCode(target) !== null;
}

function readStatusCode(target: SupervisedProcess): number | null {
  if (!existsSync(target.statusPath)) return null;
  const raw = readFileSync(target.statusPath, "utf8").trim();
  if (raw === "") return null;
  const code = Number(raw);
  return Number.isFinite(code) ? code : null;
}

export function readSupervised(target: SupervisedProcess): SupervisedResult {
  const output = existsSync(target.outputPath)
    ? readFileSync(target.outputPath, "utf8")
    : "";
  return { code: readStatusCode(target), output };
}

export function supervisedReader(target: SupervisedProcess): () => string {
  let offset = 0;
  const decoder = new StringDecoder("utf8");
  return () => {
    if (!existsSync(target.outputPath)) return "";
    const size = statSync(target.outputPath).size;
    if (size <= offset) return "";
    const fd = openSync(target.outputPath, "r");
    try {
      const length = Math.min(size - offset, 64 * 1024);
      const buffer = Buffer.alloc(length);
      const bytesRead = readSync(fd, buffer, 0, length, offset);
      if (bytesRead <= 0) return "";
      offset += bytesRead;
      return decoder.write(buffer.subarray(0, bytesRead));
    } finally {
      closeSync(fd);
    }
  };
}

export function waitSupervised(
  target: SupervisedProcess,
  intervalMs = 100,
  signal?: AbortSignal,
): Promise<SupervisedResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(readSupervised(target));
    };
    const onAbort = () => finish();
    const poll = () => {
      if (isSupervisedFinished(target) || !sameProcess(target)) {
        finish();
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
  if (!sameProcess(target)) return;
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
