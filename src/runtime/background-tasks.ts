import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { userConfigDir } from "../config/paths.js";
import { terminateProcessTree } from "../security/process.js";
import {
  isSupervisedProcessRunning,
  readSupervised,
  spawnSupervised,
  supervisedFromParams,
  supervisedParams,
  supervisedReader,
  terminateSupervised,
  waitSupervised,
  type SupervisedProcess,
} from "./supervised-process.js";

const OUTPUT_DIR = join(tmpdir(), "atom-lite-task-output");

export function writeOutputFile(output: string, label: string): string {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const path = join(OUTPUT_DIR, `${label}-${randomUUID()}.log`);
  writeFileSync(path, output);
  return path;
}

function deleteOutputFile(outputPath: string | undefined): void {
  if (!outputPath || !existsSync(outputPath)) return;
  try {
    unlinkSync(outputPath);
  } catch {
    // A concurrent reader may already have removed it.
  }
}

export type BackgroundTaskStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export type JobKind = "shell" | "subagent" | "image" | "codemode";

export interface RecoveryDescriptor {
  kind: JobKind;
  id: string;
  params?: Record<string, unknown>;
}

export interface BackgroundTask {
  id: string;
  type: JobKind;
  command: string;
  title?: string;
  status: BackgroundTaskStatus;
  output: string;
  error?: string;
  exitCode: number | null;
  signal: string | null;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  truncated: boolean;
  outputPath?: string;
  path?: string;
  model?: string;
  childSessionID?: string;
  agent?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  recovery?: RecoveryDescriptor;
}

export interface StartJobInput {
  kind: JobKind;
  run: () => Promise<string>;
  id?: string;
  startedAt?: number;
  title?: string;
  command?: string;
  path?: string;
  model?: string;
  childSessionID?: string;
  agent?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  recovery?: RecoveryDescriptor;
  cancel?: () => void;
}

export type JobRecoverer = (descriptor: RecoveryDescriptor) => Promise<string>;
export type JobProducer = (
  params: Record<string, unknown>,
  registerCancel: (cancel: () => void) => void,
) => Promise<string>;

interface InternalTask extends BackgroundTask {
  child: ReturnType<typeof spawn> | null;
  timer: NodeJS.Timeout | null;
  waiters: Array<(t: BackgroundTask) => void>;
  cancelJob?: () => void;
  supervised?: SupervisedProcess;
  pollTimer?: NodeJS.Timeout;
}

export interface WaitOutcome {
  task?: BackgroundTask;
  timedOut: boolean;
}

export interface TaskStore {
  load(): BackgroundTask[];
  save(task: BackgroundTask): void;
  remove(id: string): void;
}

export function createTaskStore(
  namespace: string,
  baseDir = join(userConfigDir(), "background-tasks"),
): TaskStore {
  const dir = baseDir;
  const key = createHash("sha256").update(namespace).digest("hex").slice(0, 16);
  const path = join(dir, `${key}.json`);
  return {
    load() {
      if (!existsSync(path)) return [];
      try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
        return Array.isArray(parsed) ? (parsed as BackgroundTask[]) : [];
      } catch {
        return [];
      }
    },
    save(task) {
      mkdirSync(dir, { recursive: true });
      const all = this.load().filter((t) => t.id !== task.id);
      all.push(task);
      const kept = all.slice(-MAX_FINISHED);
      for (const dropped of all.slice(0, -MAX_FINISHED)) {
        deleteOutputFile(dropped.outputPath);
      }
      writeFileSync(path, JSON.stringify(kept));
    },
    remove(id) {
      if (!existsSync(path)) return;
      const all = this.load();
      const removed = all.find((t) => t.id === id);
      deleteOutputFile(removed?.outputPath);
      writeFileSync(path, JSON.stringify(all.filter((t) => t.id !== id)));
    },
  };
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
  private store?: TaskStore;
  private recoverers = new Map<JobKind, JobRecoverer>();
  private producers = new Map<JobKind, JobProducer>();

  setOnComplete(callback: (task: BackgroundTask) => void): void {
    this.onComplete = callback;
  }

  registerRecovery(kind: JobKind, recoverer: JobRecoverer): void {
    this.recoverers.set(kind, recoverer);
  }

  registerProducer(kind: JobKind, producer: JobProducer): void {
    this.producers.set(kind, producer);
  }

  hasProducer(kind: JobKind): boolean {
    return this.producers.has(kind);
  }

  startProducedJob(
    kind: JobKind,
    params: Record<string, unknown> = {},
    fields: Partial<StartJobInput> = {},
  ): BackgroundTask {
    const producer = this.producers.get(kind);
    if (!producer) throw new Error(`NO_PRODUCER_FOR_${kind}`);
    let cancelWork: (() => void) | undefined;
    let work: Promise<string>;
    try {
      work = Promise.resolve(
        producer(params, (cancel) => {
          cancelWork = cancel;
        }),
      );
    } catch (err) {
      work = Promise.reject(err);
    }
    return this.startJob({
      ...fields,
      kind,
      recovery: { kind, id: "pending", params },
      cancel: () => cancelWork?.(),
      run: () => work,
    });
  }

  setStore(store: TaskStore): void {
    this.store = store;
    for (const record of store.load()) {
      const sequence = Number(record.id.replace("bg-", ""));
      if (Number.isFinite(sequence) && sequence > this.counter) {
        this.counter = sequence;
      }
      if (record.status !== "running") {
        this.recordRestored(record);
        continue;
      }
      const supervised =
        record.type === "shell"
          ? supervisedFromParams(record.recovery?.params)
          : undefined;
      if (supervised) {
        const task: InternalTask = {
          ...record,
          child: null,
          timer: null,
          waiters: [],
        };
        this.tasks.set(record.id, task);
        this.reattachSupervised(task, supervised);
        continue;
      }
      const descriptor = record.recovery ?? {
        kind: record.type,
        id: record.id,
      };
      const recoverer = this.recoverers.get(descriptor.kind);
      if (!recoverer) {
        record.status = "cancelled";
        record.error = "PROCESS_LOST_ON_RESTART";
        record.finishedAt = record.startedAt;
        record.durationMs = 0;
        store.save(record);
        this.recordRestored(record);
        continue;
      }
      let resume!: (value: string) => void;
      let abandon!: (reason: unknown) => void;
      const run = new Promise<string>((resolve, reject) => {
        resume = resolve;
        abandon = reject;
      });
      this.startJob({
        kind: record.type,
        id: record.id,
        startedAt: record.startedAt,
        title: record.title,
        command: record.command,
        path: record.path,
        model: record.model,
        childSessionID: record.childSessionID,
        agent: record.agent,
        description: record.description,
        metadata: record.metadata,
        recovery: descriptor,
        run: () => run,
      });
      void Promise.resolve()
        .then(() => recoverer(descriptor))
        .then(resume, abandon);
    }
  }

  private recordRestored(record: BackgroundTask): void {
    this.tasks.set(record.id, {
      ...record,
      child: null,
      timer: null,
      waiters: [],
    });
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
      this.store?.remove(id);
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
    const descriptor = spawnSupervised(
      command,
      cwd,
      env,
      join(tmpdir(), "atom-lite-supervised"),
    );
    const task: InternalTask = {
      id,
      type: "shell",
      command,
      status: "running",
      output: "",
      exitCode: null,
      signal: null,
      startedAt: descriptor.startedAt,
      truncated: false,
      supervised: descriptor,
      recovery: {
        kind: "shell",
        id,
        params: supervisedParams(descriptor),
      },
      child: null,
      timer: null,
      waiters: [],
    };
    this.tasks.set(id, task);
    this.attachSupervised(task, descriptor);
    const snapshot = this.snapshot(task);
    this.store?.save(snapshot);
    return snapshot;
  }

  /**
   * Takes over a process already started by the foreground bash tool. The
   * caller has captured output up to this point; this manager streams and
   * settles everything the process writes afterwards.
   */
  adopt(
    command: string,
    child: ReturnType<typeof spawn>,
    priorOutput: string,
    startedAt: number,
  ): BackgroundTask {
    const id = `bg-${++this.counter}`;
    const task: InternalTask = {
      id,
      type: "shell",
      command,
      status: "running",
      output: "",
      exitCode: null,
      signal: null,
      startedAt,
      truncated: priorOutput.length > OUTPUT_CAP,
      child: null,
      timer: null,
      waiters: [],
    };
    this.tasks.set(id, task);
    this.attach(task, child, priorOutput);
    const snapshot = this.snapshot(task);
    this.store?.save(snapshot);
    return snapshot;
  }

  startJob(input: StartJobInput): BackgroundTask {
    if (input.kind === "shell") {
      this.prune();
      const running = [...this.tasks.values()].filter(
        (t) => t.status === "running",
      ).length;
      if (running >= MAX_CONCURRENT) {
        throw new Error("too many background tasks");
      }
    }
    const id = input.id ?? `bg-${++this.counter}`;
    const sequence = Number(id.replace("bg-", ""));
    if (Number.isFinite(sequence) && sequence > this.counter) {
      this.counter = sequence;
    }
    const task: InternalTask = {
      id,
      type: input.kind,
      command:
        input.command ?? input.title ?? input.description ?? input.kind,
      title: input.title,
      status: "running",
      output: "",
      exitCode: null,
      signal: null,
      startedAt: input.startedAt ?? Date.now(),
      truncated: false,
      path: input.path,
      model: input.model,
      childSessionID: input.childSessionID,
      agent: input.agent,
      description: input.description,
      metadata: input.metadata,
      recovery: input.recovery
        ? { ...input.recovery, id }
        : undefined,
      child: null,
      timer: null,
      waiters: [],
    };
    this.tasks.set(id, task);
    const outputPath = writeOutputFile("", id);
    task.outputPath = outputPath;
    this.store?.save(this.snapshot(task));

    let active = true;
    task.cancelJob = () => {
      active = false;
      input.cancel?.();
    };
    task.timer = setTimeout(() => {
      if (!active) return;
      active = false;
      input.cancel?.();
      this.settle(task, "timed_out", null, "TIMEOUT", "TIMEOUT");
    }, DEFAULT_TIMEOUT_MS);
    task.timer.unref();

    Promise.resolve()
      .then(input.run)
      .then(
        (output) => {
          if (!active) return;
          active = false;
          this.recordOutput(task, output, outputPath);
          this.settle(task, "completed", 0, null);
        },
        (err) => {
          if (!active) return;
          active = false;
          const message =
            err instanceof Error ? err.message : String(err);
          this.recordOutput(task, `JOB_FAILED: ${message}`, outputPath);
          this.settle(task, "failed", null, null, "JOB_FAILED");
        },
      );

    return this.snapshot(task);
  }

  private attachSupervised(
    task: InternalTask,
    descriptor: SupervisedProcess,
  ): void {
    task.outputPath = descriptor.outputPath;
    this.watchSupervised(task, descriptor);
    this.armTimeout(task, descriptor);
  }

  private reattachSupervised(
    task: InternalTask,
    descriptor: SupervisedProcess,
  ): void {
    task.outputPath = descriptor.outputPath;
    task.supervised = descriptor;
    if (!isSupervisedProcessRunning(descriptor)) {
      const current = readSupervised(descriptor);
      this.applyOutput(task, current.output, descriptor.outputPath);
      if (current.code === null) {
        this.settle(task, "cancelled", null, null, "PROCESS_LOST_ON_RESTART");
      } else {
        this.settle(
          task,
          current.code === 0 ? "completed" : "failed",
          current.code,
          null,
          current.code === 0 ? undefined : "COMMAND_FAILED",
        );
      }
      return;
    }
    this.watchSupervised(task, descriptor);
    this.armTimeout(task, descriptor);
  }

  private armTimeout(
    task: InternalTask,
    descriptor: SupervisedProcess,
  ): void {
    task.timer = setTimeout(() => {
      terminateSupervised(descriptor, "SIGTERM");
      setTimeout(() => terminateSupervised(descriptor, "SIGKILL"), 1000).unref();
      this.settle(task, "timed_out", null, "SIGTERM", "TIMEOUT");
    }, DEFAULT_TIMEOUT_MS);
    task.timer.unref();
  }

  private watchSupervised(
    task: InternalTask,
    descriptor: SupervisedProcess,
  ): void {
    const readDelta = supervisedReader(descriptor);
    task.pollTimer = setInterval(() => {
      this.appendOutput(task, readDelta(), descriptor.outputPath);
    }, 100);
    task.pollTimer.unref();
    void waitSupervised(descriptor).then((result) => {
      if (task.status !== "running") return;
      this.applyOutput(task, result.output, descriptor.outputPath);
      this.settle(
        task,
        result.code === 0 ? "completed" : "failed",
        result.code,
        null,
        result.code === 0 ? undefined : "COMMAND_FAILED",
      );
    });
  }

  private appendOutput(
    task: InternalTask,
    text: string,
    outputPath: string,
  ): void {
    if (!text) return;
    task.outputPath = outputPath;
    if (task.output.length + text.length > OUTPUT_CAP) {
      task.truncated = true;
      task.output += text.slice(
        0,
        Math.max(0, OUTPUT_CAP - task.output.length),
      );
    } else {
      task.output += text;
    }
  }

  private applyOutput(
    task: InternalTask,
    output: string,
    outputPath: string,
  ): void {
    if (!output) return;
    task.outputPath = outputPath;
    task.output = output.slice(0, OUTPUT_CAP);
    task.truncated = output.length > OUTPUT_CAP;
  }

  private recordOutput(
    task: InternalTask,
    text: string,
    outputPath: string,
  ): void {
    if (!text) return;
    appendFileSync(outputPath, text);
    if (task.output.length + text.length > OUTPUT_CAP) {
      task.truncated = true;
      task.output += text.slice(
        0,
        Math.max(0, OUTPUT_CAP - task.output.length),
      );
    } else {
      task.output += text;
    }
  }

  private attach(
    task: InternalTask,
    child: ReturnType<typeof spawn>,
    priorOutput = "",
  ): void {
    task.child = child;
    const outputPath = writeOutputFile(priorOutput, task.id);
    task.outputPath = outputPath;
    task.output = priorOutput.slice(0, OUTPUT_CAP);

    if (child.exitCode !== null || child.signalCode !== null) {
      const code = child.exitCode;
      const signal = child.signalCode;
      queueMicrotask(() => {
        if (signal) this.settle(task, "cancelled", code, signal);
        else if (code === 0) this.settle(task, "completed", code, null);
        else this.settle(task, "failed", code ?? null, null, "COMMAND_FAILED");
      });
      return;
    }

    const append = (chunk: Buffer) =>
      this.recordOutput(task, chunk.toString("utf8"), outputPath);
    child.stdout?.on("data", (c: Buffer) => append(c));
    child.stderr?.on("data", (c: Buffer) => append(c));

    child.on("exit", (code, signal) => {
      if (signal) this.settle(task, "cancelled", code, signal);
      else if (code === 0) this.settle(task, "completed", code, null);
      else this.settle(task, "failed", code, null, "COMMAND_FAILED");
    });
    child.on("error", (err) => {
      const text = `COMMAND_FAILED: ${err instanceof Error ? err.message : String(err)}`;
      appendFileSync(outputPath, text);
      task.output += text;
      this.settle(task, "failed", null, null, "COMMAND_FAILED");
    });

    task.timer = setTimeout(() => {
      terminateProcessTree(child, "SIGTERM");
      setTimeout(() => terminateProcessTree(child, "SIGKILL"), 1000).unref();
      this.settle(task, "timed_out", null, "SIGTERM", "TIMEOUT");
    }, DEFAULT_TIMEOUT_MS);
    task.timer.unref();
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
    if (task.pollTimer) clearInterval(task.pollTimer);
    task.pollTimer = undefined;
    this.completedQueue.push(task.id);
    const settled = this.snapshot(task);
    this.store?.save(settled);
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
      title: t.title,
      status: t.status,
      output: t.output,
      ...(t.error !== undefined ? { error: t.error } : {}),
      exitCode: t.exitCode,
      signal: t.signal,
      startedAt: t.startedAt,
      finishedAt: t.finishedAt,
      durationMs: t.durationMs,
      truncated: t.truncated,
      outputPath: t.outputPath,
      path: t.path,
      model: t.model,
      childSessionID: t.childSessionID,
      agent: t.agent,
      description: t.description,
      metadata: t.metadata,
      recovery: t.recovery,
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
    return this.cancelTask(t);
  }

  cancelAll(): BackgroundTask[] {
    return [...this.tasks.values()]
      .filter((t) => t.status === "running")
      .map((t) => this.cancelTask(t));
  }

  private cancelTask(t: InternalTask): BackgroundTask {
    if (t.supervised) terminateSupervised(t.supervised, "SIGTERM");
    const settled = this.settle(t, "cancelled", null, "SIGTERM");
    if (t.cancelJob) t.cancelJob();
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
