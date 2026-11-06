// Process policy helpers (full implementation in later tickets).
import { spawn } from "node:child_process";

export function defaultShell(): string {
  if (process.platform === "win32") {
    return process.env.ComSpec ?? "cmd.exe";
  }
  return process.env.SHELL ?? "/bin/sh";
}

/**
 * Terminate a spawned child and, where possible, its whole process tree.
 * POSIX: kill the process group (requires the child to have been spawned with
 * `detached: true`). Windows: use `taskkill /T`.
 */
export function terminateProcessTree(
  child: {
    pid?: number;
    killed?: boolean;
    kill(signal?: NodeJS.Signals | number): boolean;
  },
  signal: NodeJS.Signals = "SIGTERM",
): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    // Non-blocking: spawn taskkill asynchronously instead of execSync.
    try {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
      });
      killer.on("error", () => {
        try {
          child.kill();
        } catch {
          // Ignore.
        }
      });
    } catch {
      try {
        child.kill();
      } catch {
        // Ignore.
      }
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Ignore.
    }
  }
}
