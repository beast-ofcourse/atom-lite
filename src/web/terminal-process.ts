import { spawn as spawnChild } from "node:child_process";

export interface TerminalProcess {
  pid?: number;
  onData(listener: (data: string) => void): void;
  onExit(listener: (exitCode: number) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface TerminalProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
}

export function createPipeTerminal(
  shell: string,
  options: TerminalProcessOptions,
): TerminalProcess {
  const child = spawnChild(shell, [], {
    cwd: options.cwd,
    env: { ...options.env, CLICOLOR_FORCE: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(exitCode: number) => void>();
  let exitCode: number | null = null;

  const emitExit = (code: number): void => {
    if (exitCode !== null) return;
    exitCode = code;
    for (const listener of exitListeners) listener(code);
  };
  const emitData = (chunk: Buffer): void => {
    for (const listener of dataListeners) listener(chunk.toString("utf8"));
  };

  child.stdout?.on("data", emitData);
  child.stderr?.on("data", emitData);
  child.once("exit", (code) => emitExit(code ?? -1));
  child.once("error", () => emitExit(-1));

  return {
    pid: child.pid,
    onData(listener) {
      dataListeners.add(listener);
    },
    onExit(listener) {
      exitListeners.add(listener);
      if (exitCode !== null) listener(exitCode);
    },
    write(data) {
      if (exitCode !== null) return;
      if (data.includes("\u0003")) {
        child.kill("SIGINT");
        return;
      }
      if (data.includes("\u0004")) {
        child.stdin?.end();
        return;
      }
      if (child.stdin && !child.stdin.destroyed) {
        child.stdin.write(data.replaceAll("\r\n", "\n").replaceAll("\r", "\n"));
      }
    },
    resize() {},
    kill() {
      if (exitCode === null) child.kill("SIGTERM");
    },
  };
}

export async function openTerminalProcess(
  shell: string,
  options: TerminalProcessOptions,
): Promise<TerminalProcess> {
  try {
    const pty = await import("node-pty");
    const child = pty.spawn(shell, [], {
      cwd: options.cwd,
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      env: { ...options.env, TERM: "xterm-256color" },
    });
    return {
      pid: child.pid,
      onData(listener) {
        child.onData(listener);
      },
      onExit(listener) {
        child.onExit(({ exitCode }) => listener(exitCode ?? -1));
      },
      write(data) {
        child.write(data);
      },
      resize(cols, rows) {
        child.resize(cols, rows);
      },
      kill() {
        child.kill();
      },
    };
  } catch {
    return createPipeTerminal(shell, options);
  }
}
