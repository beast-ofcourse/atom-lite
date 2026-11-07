import { spawn } from "node:child_process";
import { terminateProcessTree } from "../security/process.js";

export interface BackgroundTask {
  id: string;
  command: string;
  status: "running" | "completed" | "failed" | "cancelled" | "timed_out";
  output: string;
  exitCode: number | null;
  signal: string | null;
  startedAt: number;
  finishedAt?: number;
  truncated: boolean;
}

interface InternalTask extends BackgroundTask {
  child: ReturnType<typeof spawn> | null;
  timer: NodeJS.Timeout | null;
  waiters: Array<(t: BackgroundTask) => void>;
}

const MAX_CONCURRENT = 4;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_CAP = 30_000;

export class BackgroundTaskManager {
  private tasks = new Map<string, InternalTask>();
  private counter = 0;
  private completedQueue: string[] = [];

  start(command: string, cwd: string, env: NodeJS.ProcessEnv): BackgroundTask {
    const running = [...this.tasks.values()].filter(
      (t) => t.status === "running",
    ).length;
    if (running >= MAX_CONCURRENT) {
      throw new Error("too many background tasks");
    }
    const id = `bg-${++this.counter}`;
    const task: InternalTask = {
      id,
      command,
      status: "running",
      output: "",
      exitCode: null,
      signal: null,
      startedAt: Date.now(),
      truncated: false,
      child: null,
      timer: null,
      waiters: [],
    };
    this.tasks.set(id, task);

    const shell =
      process.platform === "win32"
        ? (process.env.ComSpec ?? "cmd.exe")
        : (process.env.SHELL ?? "/bin/sh");
    const flag = process.platform === "win32" ? "/c" : "-c";
    const child = spawn(shell, [flag, command], {
      cwd,
      env,
      detached: process.platform !== "win32",
    });
    task.child = child;

    const append = (chunk: Buffer) => {
      const s = chunk.toString("utf8");
      if (task.output.length + s.length > OUTPUT_CAP) {
        task.truncated = true;
        const accepted = s.slice(
          0,
          Math.max(0, OUTPUT_CAP - task.output.length),
        );
        task.output += accepted;
      } else {
        task.output += s;
      }
    };
    child.stdout?.on("data", (c: Buffer) => append(c));
    child.stderr?.on("data", (c: Buffer) => append(c));

    const finish = (
      code: number | null,
      signal: string | null,
      timedOut = false,
    ) => {
      if (task.status !== "running") return;
      if (timedOut) task.status = "timed_out";
      else if (signal) task.status = "cancelled";
      else if (code === 0) task.status = "completed";
      else task.status = "failed";
      task.exitCode = code;
      task.signal = signal;
      task.finishedAt = Date.now();
      if (task.timer) clearTimeout(task.timer);
      task.timer = null;
      this.completedQueue.push(id);
      for (const w of task.waiters) w(this.snapshot(task));
      task.waiters = [];
    };

    child.on("exit", (code, signal) => finish(code, signal));
    child.on("error", (err) => {
      task.output += `COMMAND_FAILED: ${err instanceof Error ? err.message : String(err)}`;
      finish(null, null);
    });

    task.timer = setTimeout(() => {
      terminateProcessTree(child, "SIGTERM");
      setTimeout(() => terminateProcessTree(child, "SIGKILL"), 1000).unref();
      finish(null, "SIGTERM", true);
    }, DEFAULT_TIMEOUT_MS);
    task.timer.unref();

    return this.snapshot(task);
  }

  private snapshot(t: InternalTask): BackgroundTask {
    return {
      id: t.id,
      command: t.command,
      status: t.status,
      output: t.output,
      exitCode: t.exitCode,
      signal: t.signal,
      startedAt: t.startedAt,
      finishedAt: t.finishedAt,
      truncated: t.truncated,
    };
  }

  get(id: string): BackgroundTask | undefined {
    const t = this.tasks.get(id);
    return t ? this.snapshot(t) : undefined;
  }

  output(id: string): BackgroundTask | undefined {
    return this.get(id);
  }

  cancel(id: string): BackgroundTask | undefined {
    const t = this.tasks.get(id);
    if (!t || t.status !== "running") return t ? this.snapshot(t) : undefined;
    if (t.child) terminateProcessTree(t.child, "SIGTERM");
    return this.get(id);
  }

  async wait(
    id: string,
    timeoutMs = 30_000,
    signal?: AbortSignal,
  ): Promise<BackgroundTask | undefined> {
    const t = this.tasks.get(id);
    if (!t) return undefined;
    if (t.status !== "running") return this.snapshot(t);
    if (signal?.aborted) return this.get(id);

    return new Promise<BackgroundTask | undefined>((resolve) => {
      let settled = false;
      const finish = (task: BackgroundTask | undefined) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
        const idx = t.waiters.indexOf(waiter);
        if (idx >= 0) t.waiters.splice(idx, 1);
        resolve(task);
      };
      const timer = setTimeout(
        () => finish(this.get(id)),
        Math.max(0, timeoutMs),
      );
      const waiter = (task: BackgroundTask) => finish(task);
      const onAbort = () => finish(this.get(id));
      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }
      t.waiters.push(waiter);
    });
  }

  drainCompleted(): BackgroundTask[] {
    const out: BackgroundTask[] = [];
    for (const id of this.completedQueue) {
      const t = this.get(id);
      if (t) out.push(t);
    }
    this.completedQueue = [];
    return out;
  }
}
