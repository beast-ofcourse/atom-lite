import { spawn } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  rmSync,
  readdirSync,
  statSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";
import type { ProviderAdapter } from "../providers/types.js";
import { AgentRuntime } from "../agent/loop.js";
import { InMemorySession } from "../sessions/store.js";
import {
  readTool,
  writeTool,
  editTool,
  bashTool,
  grepTool,
  globTool,
  webfetchTool,
  websearchTool,
  taskTool,
  todoTool,
  goalTool,
} from "../tools/index.js";

export type EvalSuite = "regression" | "capability";

/** A deterministic grader declared in a task's manifest.json. */
export interface GraderDeclaration {
  name: string;
  type:
    | "fileExists"
    | "fileContains"
    | "command"
    | "toolUsed"
    | "toolNotUsed"
    | "maxTurns"
    | "maxToolCalls";
  path?: string;
  contains?: string;
  command?: string;
  tool?: string;
  max?: number;
}

/** The observable outcome of one grader for one task run. */
export interface GraderResult {
  name: string;
  pass: boolean;
  reason: string;
}

export interface EvalTaskResult {
  name: string;
  suite: EvalSuite;
  pass: boolean;
  /** Fraction of declared graders that passed (0..1). Legacy: 0 or 1. */
  score: number;
  /** Per-grader outcomes. Empty for legacy check-script tasks. */
  graders: GraderResult[];
  turns: number;
  inputTokens: number;
  outputTokens: number;
  wallMs: number;
  error?: string;
  checkOutput?: string;
  /** 1-based trial index; present only when the run uses more than one trial. */
  trialIndex?: number;
  /** Total trials configured per task; present only when greater than one. */
  trialCount?: number;
}

export interface EvalReport {
  runId: string;
  suite: EvalSuite | "all";
  provider: string;
  model: string;
  startedAt: string;
  finishedAt: string;
  tasks: EvalTaskResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    passRate: number;
    totalTurns: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    wallMs: number;
  };
  baselineComparison?: {
    previousPassRate: number;
    deltaPassRate: number;
    newlyPassing: string[];
    newlyFailing: string[];
  };
}

export interface RunEvalOptions {
  provider: ProviderAdapter;
  model?: string;
  tasksDir: string;
  taskFilter?: string;
  suite?: EvalSuite;
  outDir?: string;
  writeBaseline?: boolean;
  /** Independent runs per selected task. Defaults to 1 (legacy behavior). */
  trials?: number;
  /** Partial limits override; defaults to the harness DEFAULT_LIMITS. */
  limits?: Partial<import("../types.js").AgentLimits>;
  onProgress?: (msg: string) => void;
}

const BUILTIN_TOOLS = [
  readTool,
  writeTool,
  editTool,
  bashTool,
  grepTool,
  globTool,
  webfetchTool,
  websearchTool,
  taskTool,
  todoTool,
  goalTool,
];

function discoverTasks(tasksDir: string): string[] {
  const out: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(tasksDir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(tasksDir, name);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    if (!existsSyncSafe(join(full, "prompt.txt"))) continue;
    if (!existsSyncSafe(join(full, "check.cjs"))) continue;
    out.push(name);
  }
  return out.sort();
}

function existsSyncSafe(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Workspace entries that carry shared or stale state. They are left out of
 * every trial copy so one trial can neither inherit another trial's files nor
 * start with an old git history or project-local agent state.
 */
const STRIPPED_FIXTURE_ENTRIES = new Set([".git", ".atom-lite"]);

/** Copy a task's workspace fixture into a fresh, isolated trial directory. */
function copyFixture(workspaceSrc: string, dest: string): void {
  if (!existsSyncSafe(workspaceSrc)) return;
  cpSync(workspaceSrc, dest, {
    recursive: true,
    filter: (srcPath: string) => !STRIPPED_FIXTURE_ENTRIES.has(basename(srcPath)),
  });
}

interface TaskManifest {
  suite: EvalSuite;
  graders: GraderDeclaration[];
}

/**
 * Read a task's optional manifest.json. A task without a manifest — or with an
 * unreadable one — is a regression task using the existing check-script flow.
 */
function loadManifest(taskDir: string): TaskManifest {
  try {
    const manifest = JSON.parse(
      readFileSync(join(taskDir, "manifest.json"), "utf8"),
    ) as { suite?: unknown; graders?: unknown };
    const suite: EvalSuite =
      manifest?.suite === "capability" ? "capability" : "regression";
    const graders = Array.isArray(manifest?.graders)
      ? manifest.graders.filter(
          (g): g is GraderDeclaration =>
            !!g && typeof g === "object" && typeof g.type === "string",
        )
      : [];
    return { suite, graders };
  } catch {
    // no manifest or invalid JSON -> legacy regression behavior
    return { suite: "regression", graders: [] };
  }
}

function runCheck(
  checkPath: string,
  cwd: string,
  timeoutMs = 30000,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", [checkPath], {
      cwd,
      env: { ...process.env, WORKSPACE: cwd },
    });
    let out = "";
    let err = "";
    child.stdout?.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    child.stderr?.on("data", (c: Buffer) => {
      err += c.toString("utf8");
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output: (out + err).trim() });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 1, output: String(e) });
    });
  });
}

/** Run a shell command in the workspace; used by `command` graders. */
function runCommand(
  command: string,
  cwd: string,
  timeoutMs = 30000,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: { ...process.env, WORKSPACE: cwd },
    });
    let out = "";
    let err = "";
    child.stdout?.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    child.stderr?.on("data", (c: Buffer) => {
      err += c.toString("utf8");
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output: (out + err).trim() });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 1, output: String(e) });
    });
  });
}

interface GraderContext {
  workspace: string;
  toolNames: string[];
  toolCallCount: number;
  turns: number;
}

/** Execute declared graders deterministically and return named results. */
async function runGraders(
  graders: GraderDeclaration[],
  ctx: GraderContext,
): Promise<GraderResult[]> {
  const results: GraderResult[] = [];
  for (const g of graders) {
    const name = typeof g.name === "string" && g.name ? g.name : g.type;
    let pass = false;
    let reason: string;
    switch (g.type) {
      case "fileExists": {
        const p = String(g.path ?? "");
        pass = existsSyncSafe(join(ctx.workspace, p));
        reason = pass ? `file exists: ${p}` : `file missing: ${p}`;
        break;
      }
      case "fileContains": {
        const p = String(g.path ?? "");
        const needle = String(g.contains ?? "");
        try {
          const content = readFileSync(join(ctx.workspace, p), "utf8");
          pass = content.includes(needle);
          reason = pass
            ? `file contains expected text: ${p}`
            : `file missing expected text: ${p}`;
        } catch {
          reason = `file missing: ${p}`;
        }
        break;
      }
      case "command": {
        const command = String(g.command ?? "");
        const r = await runCommand(command, ctx.workspace);
        pass = r.code === 0;
        reason = pass
          ? `command exited 0: ${command}`
          : `command exited ${r.code}: ${r.output || command}`;
        break;
      }
      case "toolUsed": {
        const tool = String(g.tool ?? "");
        pass = ctx.toolNames.includes(tool);
        reason = pass ? `tool used: ${tool}` : `tool not used: ${tool}`;
        break;
      }
      case "toolNotUsed": {
        const tool = String(g.tool ?? "");
        pass = !ctx.toolNames.includes(tool);
        reason = pass ? `tool not used: ${tool}` : `tool used: ${tool}`;
        break;
      }
      case "maxTurns": {
        const max = Number(g.max);
        pass = ctx.turns <= max;
        reason = pass
          ? `turns ${ctx.turns} <= ${max}`
          : `turns ${ctx.turns} > ${max}`;
        break;
      }
      case "maxToolCalls": {
        const max = Number(g.max);
        pass = ctx.toolCallCount <= max;
        reason = pass
          ? `tool calls ${ctx.toolCallCount} <= ${max}`
          : `tool calls ${ctx.toolCallCount} > ${max}`;
        break;
      }
      default:
        reason = `unknown grader type: ${(g as GraderDeclaration).type}`;
    }
    results.push({ name, pass, reason });
  }
  return results;
}

export async function runEval(options: RunEvalOptions): Promise<EvalReport> {
  const model = options.model ?? (options.provider as any)?.model ?? "default";
  const tasksDir = resolve(options.tasksDir);
  const startedAt = new Date().toISOString();
  const runId = `run-${Date.now()}`;
  const discovered = discoverTasks(tasksDir);
  const manifests = new Map<string, TaskManifest>(
    discovered.map((n) => [n, loadManifest(join(tasksDir, n))]),
  );
  const suites = new Map<string, EvalSuite>(
    discovered.map((n) => [n, manifests.get(n)?.suite ?? "regression"]),
  );
  const names = discovered.filter(
    (n) =>
      (!options.taskFilter || n === options.taskFilter) &&
      (!options.suite || suites.get(n) === options.suite),
  );

  const tasks: EvalTaskResult[] = [];
  const taskMessages: any[] = [];
  let totalTurns = 0;
  let totalInput = 0;
  let totalOutput = 0;
  const runStart = Date.now();
  const trials = Math.max(1, Math.floor(options.trials ?? 1));

  for (const name of names) {
    const taskDir = join(tasksDir, name);
    const prompt = readFileSync(join(taskDir, "prompt.txt"), "utf8").trim();
    const workspaceSrc = join(taskDir, "workspace");
    const checkPath = join(taskDir, "check.cjs");

    for (let trial = 1; trial <= trials; trial++) {
      options.onProgress?.(
        trials > 1
          ? `task: ${name} (trial ${trial}/${trials})`
          : `task: ${name}`,
      );
      // Each trial gets its own fresh workspace copied from the fixture, with
      // shared state and stale git history stripped from the copy.
      const tmp = mkdtempSync(join(tmpdir(), `eval-${name}-`));
      try {
        copyFixture(workspaceSrc, tmp);
      } catch {
        // ignore
      }

      let turns = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      let toolCallCount = 0;
      const toolNames: string[] = [];
      const seenToolCalls = new Set<string>();
      let error: string | undefined;
      let session: any = null;
      const t0 = Date.now();
      try {
        const runtime = new AgentRuntime({
          provider: options.provider,
          model,
          workspace: tmp,
          tools: BUILTIN_TOOLS,
          mode: "yolo",
          limits: options.limits,
          onEvent: (e: any) => {
            if (e?.type === "usage") {
              turns += 1;
              inputTokens += e.input ?? 0;
              outputTokens += e.output ?? 0;
            }
            if (e?.type === "tool_call") {
              // The runtime and its turn recorder both emit tool_call for one
              // call; dedupe by id so tool-usage graders count calls once.
              const callId = e.toolCallId ?? e.id;
              const key =
                callId != null ? String(callId) : `anon-${toolNames.length}`;
              if (!seenToolCalls.has(key)) {
                seenToolCalls.add(key);
                toolNames.push(e.name);
                toolCallCount += 1;
              }
            }
          },
        });
        session = new InMemorySession(
          trials > 1 ? `eval-${name}-trial-${trial}` : `eval-${name}`,
          tmp,
          options.provider.id ?? "fake",
        );
        const result = await runtime.runAgentTurn(
          prompt,
          session,
          new AbortController().signal,
        );
        if (typeof result === "string" && result === "TOKEN_BUDGET_REACHED") {
          error = "TOKEN_BUDGET_REACHED";
        }
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      const wallMs = Date.now() - t0;

      const declaredGraders = manifests.get(name)?.graders ?? [];
      let graders: GraderResult[] = [];
      let score: number;
      let pass: boolean;
      let checkOutput = "";
      if (declaredGraders.length > 0) {
        graders = await runGraders(declaredGraders, {
          workspace: tmp,
          toolNames,
          toolCallCount,
          turns,
        });
        score = graders.filter((g) => g.pass).length / graders.length;
        pass = score === 1;
        checkOutput = graders
          .map((g) => `${g.pass ? "PASS" : "FAIL"} ${g.name}: ${g.reason}`)
          .join("\n");
      } else if (!error) {
        const r = await runCheck(checkPath, tmp);
        pass = r.code === 0;
        score = pass ? 1 : 0;
        checkOutput = r.output;
        if (!pass && !checkOutput) checkOutput = `check exited ${r.code}`;
      } else {
        pass = false;
        score = 0;
        checkOutput = error;
      }

      tasks.push({
        name,
        suite: suites.get(name) ?? "regression",
        pass,
        score,
        graders,
        turns,
        inputTokens,
        outputTokens,
        wallMs,
        error,
        checkOutput,
        ...(trials > 1 ? { trialIndex: trial, trialCount: trials } : {}),
      });
      taskMessages.push(session ? session.messages : []);
      totalTurns += turns;
      totalInput += inputTokens;
      totalOutput += outputTokens;

      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }

  const finishedAt = new Date().toISOString();
  const report: EvalReport = {
    runId,
    suite: options.suite ?? "all",
    provider: options.provider.id ?? "unknown",
    model,
    startedAt,
    finishedAt,
    tasks,
    summary: {
      total: tasks.length,
      passed: tasks.filter((t) => t.pass).length,
      failed: tasks.filter((t) => !t.pass).length,
      passRate: tasks.length
        ? tasks.filter((t) => t.pass).length / tasks.length
        : 0,
      totalTurns,
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      wallMs: Date.now() - runStart,
    },
  };

  // Baseline comparison
  const baselinePath = options.outDir
    ? join(options.outDir, "baseline.json")
    : null;
  if (baselinePath) {
    try {
      const prev = JSON.parse(readFileSync(baselinePath, "utf8")) as EvalReport;
      const prevMap = new Map(prev.tasks.map((t) => [t.name, t.pass]));
      const newlyPassing: string[] = [];
      const newlyFailing: string[] = [];
      for (const t of tasks) {
        const was = prevMap.get(t.name);
        if (was === false && t.pass) newlyPassing.push(t.name);
        if (was === true && !t.pass) newlyFailing.push(t.name);
      }
      report.baselineComparison = {
        previousPassRate: prev.summary.passRate,
        deltaPassRate: report.summary.passRate - prev.summary.passRate,
        newlyPassing,
        newlyFailing,
      };
    } catch {
      // no baseline or unreadable
    }
  }

  if (options.outDir) {
    mkdirSync(options.outDir, { recursive: true });
    writeFileSync(
      join(options.outDir, "report.json"),
      JSON.stringify(report, null, 2),
    );
    // per-task logs
    tasks.forEach((t, i) => {
      const transcript = (taskMessages[i] ?? [])
        .map((m: any) => JSON.stringify(m))
        .join("\n");
      const graderLines = t.graders
        .map((g) => `${g.pass ? "PASS" : "FAIL"} ${g.name}: ${g.reason}`)
        .join("\n");
      writeFileSync(
        join(options.outDir as string, `${t.name}.log`),
        `pass=${t.pass}\nscore=${t.score}\nturns=${t.turns}\ninput=${t.inputTokens}\noutput=${t.outputTokens}\nwallMs=${t.wallMs}\nerror=${t.error ?? ""}\ncheckOutput=${t.checkOutput ?? ""}\n--- graders ---\n${graderLines}\n--- transcript ---\n${transcript}\n`,
      );
    });

    // Stable, durable artifact tree for this run. Layout:
    //   <outDir>/runs/<runId>/report.json
    //   <outDir>/runs/<runId>/outcome-snapshot.json
    //   <outDir>/runs/<runId>/trials/<task>[--trial-N]/transcript.json
    //   <outDir>/runs/<runId>/trials/<task>[--trial-N]/graders.json
    const runDir = join(options.outDir, "runs", report.runId);
    const trialsRoot = join(runDir, "trials");
    mkdirSync(trialsRoot, { recursive: true });
    writeFileSync(join(runDir, "report.json"), JSON.stringify(report, null, 2));
    writeFileSync(
      join(runDir, "outcome-snapshot.json"),
      JSON.stringify(
        {
          runId: report.runId,
          suite: report.suite,
          provider: report.provider,
          model: report.model,
          startedAt: report.startedAt,
          finishedAt: report.finishedAt,
          outcomes: tasks.map((t) => ({
            name: t.name,
            trialIndex: t.trialIndex,
            pass: t.pass,
            score: t.score,
            error: t.error,
            checkOutput: t.checkOutput,
          })),
        },
        null,
        2,
      ),
    );
    tasks.forEach((t, i) => {
      const label =
        (t.trialCount ?? 1) > 1 ? `${t.name}--trial-${t.trialIndex}` : t.name;
      const trialDir = join(trialsRoot, label);
      mkdirSync(trialDir, { recursive: true });
      writeFileSync(
        join(trialDir, "transcript.json"),
        JSON.stringify(taskMessages[i] ?? [], null, 2),
      );
      writeFileSync(
        join(trialDir, "graders.json"),
        JSON.stringify(
          {
            name: t.name,
            trialIndex: t.trialIndex,
            pass: t.pass,
            score: t.score,
            checkOutput: t.checkOutput,
            graders: t.graders,
          },
          null,
          2,
        ),
      );
    });
    // Pointer to the most recent run, so review needs no run id.
    writeFileSync(
      join(options.outDir, "latest.json"),
      JSON.stringify({ runId: report.runId }, null, 2),
    );

    if (options.writeBaseline) {
      writeFileSync(
        join(options.outDir, "baseline.json"),
        JSON.stringify(report, null, 2),
      );
    }
  }

  options.onProgress?.(
    `done: ${report.summary.passed}/${report.summary.total} passed`,
  );
  return report;
}

export function compareBaseline(
  current: EvalReport,
  baseline: EvalReport,
): {
  previousPassRate: number;
  deltaPassRate: number;
  newlyPassing: string[];
  newlyFailing: string[];
} {
  const prevMap = new Map(baseline.tasks.map((t) => [t.name, t.pass]));
  const newlyPassing: string[] = [];
  const newlyFailing: string[] = [];
  for (const t of current.tasks) {
    const was = prevMap.get(t.name);
    if (was === false && t.pass) newlyPassing.push(t.name);
    if (was === true && !t.pass) newlyFailing.push(t.name);
  }
  return {
    previousPassRate: baseline.summary.passRate,
    deltaPassRate: current.summary.passRate - baseline.summary.passRate,
    newlyPassing,
    newlyFailing,
  };
}

/** One failed trial surfaced by a review, with its transcript and grader detail. */
export interface ReviewedFailure {
  name: string;
  trialIndex?: number;
  transcript: any[];
  graders: GraderResult[];
  checkOutput?: string;
  error?: string;
}

export interface ReviewResult {
  runId: string;
  failed: ReviewedFailure[];
}

export interface ReviewOptions {
  outDir: string;
  /** Run id to review; defaults to the most recent run in the output directory. */
  runId?: string;
  /** Receives one compact line per emitted record. */
  printer?: (line: string) => void;
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function resolveRunId(outDir: string, requested?: string): string | undefined {
  if (requested) return requested;
  const pointer = readJson<{ runId: string }>(join(outDir, "latest.json"));
  if (pointer?.runId) return pointer.runId;
  // Fall back to the most recently created run directory.
  try {
    const runsRoot = join(outDir, "runs");
    const dirs = readdirSync(runsRoot)
      .filter((n) => {
        try {
          return statSync(join(runsRoot, n)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
    return dirs[dirs.length - 1];
  } catch {
    return undefined;
  }
}

/**
 * Select failed trials from a stored run and print a compact review of each
 * one's transcript and grader detail. The selection is driven by the persisted
 * outcome snapshot; presentation is delegated to the printer and is not part
 * of the contract.
 */
export async function reviewEval(
  options: ReviewOptions,
): Promise<ReviewResult> {
  const runId = resolveRunId(options.outDir, options.runId);
  if (!runId) {
    throw new Error(`no eval run found in ${options.outDir}`);
  }
  const runDir = join(options.outDir, "runs", runId);
  const report = readJson<EvalReport>(join(runDir, "report.json"));
  if (!report) {
    throw new Error(`eval run ${runId} has no report.json`);
  }

  const failed: ReviewedFailure[] = [];
  for (const task of report.tasks) {
    if (task.pass) continue;
    const label =
      (task.trialCount ?? 1) > 1
        ? `${task.name}--trial-${task.trialIndex}`
        : task.name;
    const trialDir = join(runDir, "trials", label);
    const transcript = readJson<any[]>(join(trialDir, "transcript.json")) ?? [];
    const detail = readJson<{
      graders: GraderResult[];
      checkOutput?: string;
      error?: string;
    }>(join(trialDir, "graders.json"));
    const failure: ReviewedFailure = {
      name: task.name,
      trialIndex: task.trialIndex,
      transcript,
      graders: detail?.graders ?? task.graders ?? [],
      checkOutput: detail?.checkOutput ?? task.checkOutput,
      error: detail?.error ?? task.error,
    };
    failed.push(failure);

    const emit = options.printer ?? (() => {});
    emit(`FAILED ${label}`);
    for (const g of failure.graders) {
      emit(`  ${g.pass ? "PASS" : "FAIL"} ${g.name}: ${g.reason}`);
    }
    if (failure.error) emit(`  error: ${failure.error}`);
    if (failure.checkOutput) emit(`  checkOutput: ${failure.checkOutput}`);
    for (const m of transcript) {
      emit(`  ${JSON.stringify(m)}`);
    }
  }

  return { runId, failed };
}
