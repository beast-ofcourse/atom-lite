import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeProvider } from "../providers/fake.js";
import type { ProviderAdapter } from "../providers/types.js";
import type { EvalReport, EvalSuite } from "./runner.js";
import { runEval } from "./runner.js";

/** The four harness concerns the CI gate proves are still wired together. */
export interface SmokeChecks {
  taskLoading: boolean;
  execution: boolean;
  grading: boolean;
  reportCreation: boolean;
}

export interface SmokeResult {
  ok: boolean;
  failures: string[];
  checks: SmokeChecks;
  report: EvalReport;
  reportOnDisk: EvalReport | undefined;
  taskNames: string[];
}

export interface SmokeOptions {
  /** Override the provider to prove the gate fails on a broken harness path. */
  provider?: ProviderAdapter;
}

interface SmokeTask {
  name: string;
  file: string;
  content: string;
  suite?: EvalSuite;
}

// Self-contained fixtures: one manifest-declared task and one legacy task.
// Both suites load without any checked-in workspace or external service.
const SMOKE_TASKS: SmokeTask[] = [
  {
    name: "smoke-create-file",
    file: "hello.txt",
    content: "hi",
    suite: "regression",
  },
  { name: "smoke-legacy-file", file: "legacy.txt", content: "ok" },
];

const USAGE = { input: 5, output: 1, total: 6 };

function defaultSmokeProvider(): FakeProvider {
  const responses = SMOKE_TASKS.flatMap((task) => [
    {
      toolCalls: [
        {
          id: `write-${task.name}`,
          name: "write",
          arguments: { path: task.file, content: task.content },
        },
      ],
      usage: USAGE,
    },
    { text: "done", usage: USAGE },
  ]);
  return new FakeProvider(responses);
}

function checkScript(file: string, content: string): string {
  return `const { readFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const p = join(process.cwd(), ${JSON.stringify(file)});
if (!existsSync(p) || readFileSync(p, "utf8") !== ${JSON.stringify(content)}) {
  console.error("expected " + ${JSON.stringify(file)} + " to contain " + ${JSON.stringify(content)});
  process.exit(1);
}
console.log("ok");
`;
}

/**
 * Run the eval harness end-to-end against a deterministic fake provider.
 * Exercises task loading, trial execution, grading, and report creation, then
 * reports whether each concern held. No network, credential, or config needed.
 */
export async function runSmokeCheck(
  options: SmokeOptions = {},
): Promise<SmokeResult> {
  const base = mkdtempSync(join(tmpdir(), "eval-smoke-"));
  const tasksDir = join(base, "tasks");
  const outDir = join(base, "out");
  mkdirSync(tasksDir, { recursive: true });

  try {
    for (const task of SMOKE_TASKS) {
      const dir = join(tasksDir, task.name);
      mkdirSync(join(dir, "workspace"), { recursive: true });
      writeFileSync(
        join(dir, "prompt.txt"),
        `Create ${task.file} containing exactly ${JSON.stringify(task.content)}.\n`,
      );
      writeFileSync(
        join(dir, "check.cjs"),
        checkScript(task.file, task.content),
      );
      if (task.suite) {
        writeFileSync(
          join(dir, "manifest.json"),
          JSON.stringify({ suite: task.suite }),
        );
      }
    }

    const provider = options.provider ?? defaultSmokeProvider();
    const report = await runEval({ provider, tasksDir, outDir });

    const failures: string[] = [];
    const expectedNames = SMOKE_TASKS.map((t) => t.name).sort();
    const taskNames = report.tasks.map((t) => t.name);

    const taskLoading =
      JSON.stringify(taskNames) === JSON.stringify(expectedNames);
    if (!taskLoading) {
      failures.push(
        `task loading: expected ${expectedNames.join(", ")}, got ${taskNames.join(", ")}`,
      );
    }

    const execution =
      report.tasks.length > 0 && report.tasks.every((t) => t.turns > 0);
    if (!execution)
      failures.push("execution: no task recorded a provider turn");

    const grading =
      report.tasks.length > 0 && report.tasks.every((t) => t.pass);
    if (!grading) {
      const failed = report.tasks
        .filter((t) => !t.pass)
        .map((t) => `${t.name} (${t.checkOutput})`)
        .join(", ");
      failures.push(`grading: ${failed}`);
    }

    let reportOnDisk: EvalReport | undefined;
    try {
      reportOnDisk = JSON.parse(
        readFileSync(join(outDir, "report.json"), "utf8"),
      ) as EvalReport;
    } catch {
      reportOnDisk = undefined;
    }
    const reportCreation =
      reportOnDisk?.summary?.total === report.summary.total &&
      reportOnDisk?.summary?.passed === report.summary.passed;
    if (!reportCreation) {
      failures.push("report creation: report.json missing or summary mismatch");
    }

    return {
      ok: failures.length === 0,
      failures,
      checks: { taskLoading, execution, grading, reportCreation },
      report,
      reportOnDisk,
      taskNames,
    };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}
