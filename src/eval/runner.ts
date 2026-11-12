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
import { join, resolve } from "node:path";
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
} from "../tools/index.js";

export interface EvalTaskResult {
  name: string;
  pass: boolean;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  wallMs: number;
  error?: string;
  checkOutput?: string;
}

export interface EvalReport {
  runId: string;
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
  outDir?: string;
  writeBaseline?: boolean;
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

export async function runEval(options: RunEvalOptions): Promise<EvalReport> {
  const model = options.model ?? (options.provider as any)?.model ?? "default";
  const tasksDir = resolve(options.tasksDir);
  const startedAt = new Date().toISOString();
  const runId = `run-${Date.now()}`;
  const discovered = discoverTasks(tasksDir);
  const names = discovered.filter(
    (n) => !options.taskFilter || n === options.taskFilter,
  );

  const tasks: EvalTaskResult[] = [];
  const taskMessages: any[] = [];
  let totalTurns = 0;
  let totalInput = 0;
  let totalOutput = 0;
  const runStart = Date.now();

  for (const name of names) {
    options.onProgress?.(`task: ${name}`);
    const taskDir = join(tasksDir, name);
    const prompt = readFileSync(join(taskDir, "prompt.txt"), "utf8").trim();
    const workspaceSrc = join(taskDir, "workspace");
    const checkPath = join(taskDir, "check.cjs");
    const tmp = mkdtempSync(join(tmpdir(), `eval-${name}-`));
    // copy workspace fixture
    try {
      if (existsSyncSafe(workspaceSrc)) {
        cpSync(workspaceSrc, tmp, { recursive: true });
      }
    } catch {
      // ignore
    }

    let turns = 0;
    let inputTokens = 0;
    let outputTokens = 0;
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
        },
      });
      session = new InMemorySession(
        `eval-${name}`,
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

    let pass = false;
    let checkOutput = "";
    if (!error) {
      const r = await runCheck(checkPath, tmp);
      pass = r.code === 0;
      checkOutput = r.output;
      if (!pass && !checkOutput) checkOutput = `check exited ${r.code}`;
    } else {
      pass = false;
      checkOutput = error;
    }

    tasks.push({
      name,
      pass,
      turns,
      inputTokens,
      outputTokens,
      wallMs,
      error,
      checkOutput,
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

  const finishedAt = new Date().toISOString();
  const report: EvalReport = {
    runId,
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
      writeFileSync(
        join(options.outDir as string, `${t.name}.log`),
        `pass=${t.pass}\nturns=${t.turns}\ninput=${t.inputTokens}\noutput=${t.outputTokens}\nwallMs=${t.wallMs}\nerror=${t.error ?? ""}\ncheckOutput=${t.checkOutput ?? ""}\n--- transcript ---\n${transcript}\n`,
      );
    });
    if (options.writeBaseline) {
      if (options.outDir)
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
