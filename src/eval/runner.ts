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
    /** The suite this comparison was scoped to. */
    suite: EvalSuite | "all";
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

/** A per-suite snapshot stored in a baseline file. */
interface BaselineSnapshot {
  summary: { passRate: number };
  tasks: Array<{ name: string; pass: boolean; suite?: EvalSuite }>;
}

interface BaselineData {
  suites: Partial<Record<EvalSuite, BaselineSnapshot>>;
  /** A legacy flat baseline, usable as a fallback for any suite. */
  legacy?: BaselineSnapshot;
}

function toBaselineSnapshot(value: unknown): BaselineSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as { summary?: { passRate?: unknown }; tasks?: unknown };
  if (!Array.isArray(v.tasks)) return undefined;
  return {
    summary: { passRate: Number(v.summary?.passRate) || 0 },
    tasks: v.tasks
      .filter(
        (t: any) =>
          t && typeof t.name === "string" && typeof t.pass === "boolean",
      )
      .map((t: any) => ({
        name: t.name,
        pass: t.pass,
        ...(t.suite === "regression" || t.suite === "capability"
          ? { suite: t.suite as EvalSuite }
          : {}),
      })),
  };
}

/**
 * Read a baseline file. New files hold one snapshot per suite under `suites`;
 * a legacy flat report (with `tasks` at the top level) is read as a shared
 * fallback so existing baselines keep working.
 */
function parseBaseline(value: unknown): BaselineData {
  if (!value || typeof value !== "object") return { suites: {} };
  const v = value as { suites?: unknown; suite?: unknown };
  if (v.suites && typeof v.suites === "object") {
    const suites = v.suites as { regression?: unknown; capability?: unknown };
    const data: BaselineData = { suites: {} };
    const regression = toBaselineSnapshot(suites.regression);
    const capability = toBaselineSnapshot(suites.capability);
    if (regression) data.suites.regression = regression;
    if (capability) data.suites.capability = capability;
    return data;
  }
  const snap = toBaselineSnapshot(value);
  if (!snap) return { suites: {} };
  if (v.suite === "regression" || v.suite === "capability") {
    return { suites: { [v.suite]: snap } };
  }
  return { suites: {}, legacy: snap };
}

/** Select the baseline snapshot relevant to a suite. */
function baselineForSuite(
  data: BaselineData,
  suite?: EvalSuite,
): BaselineSnapshot | undefined {
  if (suite) return data.suites[suite] ?? data.legacy;
  if (data.legacy) return data.legacy;
  const snapshots = Object.values(data.suites).filter(
    (s): s is BaselineSnapshot => !!s,
  );
  if (!snapshots.length) return undefined;
  const tasks = snapshots.flatMap((s) => s.tasks);
  const passed = tasks.filter((t) => t.pass).length;
  return {
    summary: { passRate: tasks.length ? passed / tasks.length : 0 },
    tasks,
  };
}

function snapshotOf(
  report: EvalReport,
  tasks: EvalTaskResult[] = report.tasks,
): BaselineSnapshot {
  const passed = tasks.filter((t) => t.pass).length;
  return {
    summary: { passRate: tasks.length ? passed / tasks.length : 0 },
    tasks: tasks.map((t) => ({ name: t.name, pass: t.pass, suite: t.suite })),
  };
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

  // Baseline comparison is scoped to the selected suite. A baseline file may
  // hold one snapshot per suite; a legacy flat report is read as a shared
  // fallback so existing baseline files remain readable.
  const baselinePath = options.outDir
    ? join(options.outDir, "baseline.json")
    : null;
  let baselineData: BaselineData = { suites: {} };
  if (baselinePath && existsSyncSafe(baselinePath)) {
    try {
      baselineData = parseBaseline(
        JSON.parse(readFileSync(baselinePath, "utf8")),
      );
    } catch {
      // no usable baseline; keep the empty container
    }
  }
  const suiteFlag = options.suite as EvalSuite | "all" | undefined;
  const selectedSuite =
    suiteFlag && suiteFlag !== "all" ? suiteFlag : undefined;
  const previousBaseline = baselineForSuite(baselineData, selectedSuite);
  if (previousBaseline) {
    report.baselineComparison = {
      ...compareBaseline(report, previousBaseline as unknown as EvalReport),
      suite: selectedSuite ?? "all",
    };
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
    // Writing a baseline is opt-in and targets one suite at a time, so a
    // capability run can never rewrite the regression standard.
    if (options.writeBaseline && baselinePath) {
      const suites: Partial<Record<EvalSuite, BaselineSnapshot>> = {
        ...baselineData.suites,
      };
      // A legacy shared baseline becomes the starting point for any suite that
      // does not yet have its own snapshot, so no baseline is silently lost.
      if (baselineData.legacy) {
        if (!suites.regression) suites.regression = baselineData.legacy;
        if (!suites.capability) suites.capability = baselineData.legacy;
      }
      if (selectedSuite) {
        suites[selectedSuite] = snapshotOf(report);
      } else {
        for (const suite of ["regression", "capability"] as EvalSuite[]) {
          const suiteTasks = report.tasks.filter((t) => t.suite === suite);
          if (suiteTasks.length) {
            suites[suite] = snapshotOf(report, suiteTasks);
          }
        }
      }
      writeFileSync(
        baselinePath,
        JSON.stringify({ version: 1, suites }, null, 2),
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
