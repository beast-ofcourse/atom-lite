import { spawn } from "node:child_process";
import { terminateProcessTree } from "../security/process.js";

export type BackgroundTaskStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export interface BackgroundTask {
  id: string;
  type: "shell";
  command: string;
  status: BackgroundTaskStatus;
  output: string;
  error?: string;
  exitCode: number | null;
  signal: string | null;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  truncated: boolean;
}

interface InternalTask extends BackgroundTask {
  child: ReturnType<typeof spawn> | null;
  timer: NodeJS.Timeout | null;
  waiters: Array<(t: BackgroundTask) => void>;
}

export interface WaitOutcome {
  task?: BackgroundTask;
  timedOut: boolean;
}

const MAX_CONCURRENT = 4;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_CAP = 30_000;
/**
 * Finished task records are kept so the `task` tool can report status, but
 * they are bounded: `start()` prunes the oldest finished records so long
 * sessions cannot grow the manager's memory without limit.
 */
const MAX_FINISHED = 32;

export class BackgroundTaskManager {
  private tasks = new Map<string, InternalTask>();
  private counter = 0;
  private completedQueue: string[] = [];
  private onComplete?: (task: BackgroundTask) => void;

  setOnComplete(callback: (task: BackgroundTask) => void): void {
    this.onComplete = callback;
  }

  private prune(maxFinished: number = MAX_FINISHED): void {
    const finished: string[] = [];
    for (const [id, t] of this.tasks) {
      if (t.status !== "running") finished.push(id);
    }
    let excess = finished.length - maxFinished;
    if (excess <= 0) return;
    // Map iteration is insertion-ordered, so this prunes the oldest.
    for (const id of finished) {
      if (excess <= 0) break;
      this.tasks.delete(id);
      excess--;
    }
  }

  start(command: string, cwd: string, env: NodeJS.ProcessEnv): BackgroundTask {
    this.prune();
    const running = [...this.tasks.values()].filter(
      (t) => t.status === "running",
    ).length;
    if (running >= MAX_CONCURRENT) {
      throw new Error("too many background tasks");
    }
    const id = `bg-${++this.counter}`;
    const task: InternalTask = {
      id,
      type: "shell",
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
      // EOF-on-stdin so commands that read stdin do not block for the whole
      // 10-minute timeout.
      stdio: ["ignore", "pipe", "pipe"],
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

    child.on("exit", (code, signal) => {
      if (signal) this.settle(task, "cancelled", code, signal);
      else if (code === 0) this.settle(task, "completed", code, null);
      else this.settle(task, "failed", code, null, "COMMAND_FAILED");
    });
    child.on("error", (err) => {
      task.output += `COMMAND_FAILED: ${err instanceof Error ? err.message : String(err)}`;
      this.settle(task, "failed", null, null, "COMMAND_FAILED");
    });

    task.timer = setTimeout(() => {
      terminateProcessTree(child, "SIGTERM");
      setTimeout(() => terminateProcessTree(child, "SIGKILL"), 1000).unref();
      this.settle(task, "timed_out", null, "SIGTERM", "TIMEOUT");
    }, DEFAULT_TIMEOUT_MS);
    task.timer.unref();

    return this.snapshot(task);
  }

  private settle(
    task: InternalTask,
    status: Exclude<BackgroundTaskStatus, "running">,
    code: number | null,
    signal: string | null,
    error?: string,
  ): BackgroundTask {
    if (task.status !== "running") return this.snapshot(task);
    task.status = status;
    task.exitCode = code;
    task.signal = signal;
    task.finishedAt = Date.now();
    task.durationMs = task.finishedAt - task.startedAt;
    if (error) task.error = error;
    if (task.timer) clearTimeout(task.timer);
    task.timer = null;
    this.completedQueue.push(task.id);
    const settled = this.snapshot(task);
    for (const waiter of task.waiters) waiter(settled);
    task.waiters = [];
    this.onComplete?.(settled);
    return settled;
  }

  private snapshot(t: InternalTask): BackgroundTask {
    return {
      id: t.id,
      type: t.type,
      command: t.command,
      status: t.status,
      output: t.output,
      ...(t.error !== undefined ? { error: t.error } : {}),
      exitCode: t.exitCode,
      signal: t.signal,
      startedAt: t.startedAt,
      finishedAt: t.finishedAt,
      durationMs: t.durationMs,
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

  list(): BackgroundTask[] {
    return [...this.tasks.values()]
      .map((t) => this.snapshot(t))
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  cancel(id: string): BackgroundTask | undefined {
    const t = this.tasks.get(id);
    if (!t || t.status !== "running") return t ? this.snapshot(t) : undefined;
    const settled = this.settle(t, "cancelled", null, "SIGTERM");
    const child = t.child;
    if (child) {
      terminateProcessTree(child, "SIGTERM");
      setTimeout(() => terminateProcessTree(child, "SIGKILL"), 1000).unref();
    }
    return settled;
  }

  async wait(
    id: string,
    timeoutMs = 30_000,
    signal?: AbortSignal,
  ): Promise<BackgroundTask | undefined> {
    return (await this.waitDetailed(id, timeoutMs, signal))?.task;
  }

  async waitDetailed(
    id: string,
    timeoutMs = 30_000,
    signal?: AbortSignal,
  ): Promise<WaitOutcome | undefined> {
    const t = this.tasks.get(id);
    if (!t) return undefined;
    if (t.status !== "running") return { task: this.snapshot(t), timedOut: false };
    if (signal?.aborted) return { task: this.get(id), timedOut: false };

    return new Promise<WaitOutcome>((resolve) => {
      let settled = false;
      const finish = (outcome: WaitOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
        const idx = t.waiters.indexOf(waiter);
        if (idx >= 0) t.waiters.splice(idx, 1);
        resolve(outcome);
      };
      const timer = setTimeout(
        () => finish({ task: this.get(id), timedOut: true }),
        Math.max(0, timeoutMs),
      );
      const waiter = (task: BackgroundTask) => finish({ task, timedOut: false });
      const onAbort = () => finish({ task: this.get(id), timedOut: false });
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
