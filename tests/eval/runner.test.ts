import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { FakeProvider } from "../../dist/providers/fake.js";
import { runEval } from "../../dist/eval/runner.js";

test("runEval discovers tasks and reports pass/fail", async () => {
  const provider = new FakeProvider([
    {
      toolCalls: [
        {
          id: "w1",
          name: "write",
          arguments: { path: "hello.txt", content: "hi" },
        },
      ],
    },
    { text: "done" },
    {
      toolCalls: [
        {
          id: "b2",
          name: "bash",
          arguments: { command: "printf '{\"x\":2}' > config.json" },
        },
      ],
    },
    { text: "done" },
  ]);
  const tasksDir = join(process.cwd(), "evals", "tasks");
  const outDir = mkdtempSync(join(tmpdir(), "evalout-"));
  const report = await runEval({ provider, tasksDir, outDir });
  assert.equal(report.tasks.length, 12);
  assert.equal(report.summary.total, 12);
  // scripted provider only fully serves the first task; the rest are best-effort
  rmSync(outDir, { recursive: true, force: true });
});

test("runEval writes report.json and per-task logs", async () => {
  const provider = new FakeProvider([
    {
      toolCalls: [
        {
          id: "w1",
          name: "write",
          arguments: { path: "hello.txt", content: "hi" },
        },
      ],
    },
    { text: "done" },
  ]);
  const tasksDir = join(process.cwd(), "evals", "tasks");
  const outDir = mkdtempSync(join(tmpdir(), "evalout-"));
  const report = await runEval({
    provider,
    tasksDir,
    taskFilter: "create-file",
    outDir,
  });
  assert.equal(report.tasks.length, 1);
  const { existsSync } = await import("node:fs");
  assert.ok(existsSync(join(outDir, "report.json")));
  assert.ok(existsSync(join(outDir, "create-file.log")));
  rmSync(outDir, { recursive: true, force: true });
});

test("runEval task filter limits tasks", async () => {
  const provider = new FakeProvider([
    {
      toolCalls: [
        {
          id: "w1",
          name: "write",
          arguments: { path: "hello.txt", content: "hi" },
        },
      ],
    },
    { text: "done" },
  ]);
  const tasksDir = join(process.cwd(), "evals", "tasks");
  const report = await runEval({
    provider,
    tasksDir,
    taskFilter: "create-file",
  });
  assert.equal(report.tasks.length, 1);
  assert.equal(report.tasks[0].name, "create-file");
});

test("runEval records turns and tokens from usage events", async () => {
  const provider = new FakeProvider([
    {
      toolCalls: [
        {
          id: "w1",
          name: "write",
          arguments: { path: "hello.txt", content: "hi" },
        },
      ],
      usage: { input: 10, output: 2, total: 12 },
    },
    { text: "done", usage: { input: 5, output: 1, total: 6 } },
  ]);
  const tasksDir = join(process.cwd(), "evals", "tasks");
  const report = await runEval({
    provider,
    tasksDir,
    taskFilter: "create-file",
  });
  const t = report.tasks[0];
  assert.equal(t.turns, 2);
  assert.equal(t.inputTokens, 15);
  assert.equal(t.outputTokens, 3);
});

test("runEval baseline comparison when baseline.json exists", async () => {
  const provider = new FakeProvider([
    {
      toolCalls: [
        {
          id: "w1",
          name: "write",
          arguments: { path: "hello.txt", content: "hi" },
        },
      ],
    },
    { text: "done" },
  ]);
  const tasksDir = join(process.cwd(), "evals", "tasks");
  const outDir = mkdtempSync(join(tmpdir(), "evalout-"));
  // write a baseline with 0 passed
  const { writeFileSync } = await import("node:fs");
  writeFileSync(
    join(outDir, "baseline.json"),
    JSON.stringify({
      summary: { passRate: 0 },
      tasks: [{ name: "create-file", pass: false }],
    }),
  );
  const report = await runEval({
    provider,
    tasksDir,
    taskFilter: "create-file",
    outDir,
  });
  assert.ok(report.baselineComparison);
  assert.equal(
    report.baselineComparison?.newlyPassing.includes("create-file"),
    true,
  );
  rmSync(outDir, { recursive: true, force: true });
});

test("compareBaseline computes deltas", async () => {
  const { compareBaseline } = await import("../../dist/eval/runner.js");
  const cur = {
    summary: { passRate: 1 },
    tasks: [{ name: "a", pass: true }],
  } as any;
  const base = {
    summary: { passRate: 0 },
    tasks: [{ name: "a", pass: false }],
  } as any;
  const cmp = compareBaseline(cur, base);
  assert.equal(cmp.newlyPassing.includes("a"), true);
  assert.equal(cmp.deltaPassRate, 1);
});

// Build a self-contained task directory. A manifest is only written when the
// caller supplies a suite, so unmanifested tasks exercise the legacy path.
function makeTask(
  tasksDir: string,
  name: string,
  options: { suite?: string } = {},
): void {
  const dir = join(tasksDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "prompt.txt"), "do the thing\n");
  writeFileSync(join(dir, "check.cjs"), "process.exit(0);\n");
  if (options.suite) {
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({ suite: options.suite }),
    );
  }
}

function smokeProvider(): FakeProvider {
  return new FakeProvider([{ text: "done" }, { text: "done" }]);
}

test("runEval runs only capability tasks when the capability suite is selected", async () => {
  const tasksDir = mkdtempSync(join(tmpdir(), "evaltasks-"));
  try {
    makeTask(tasksDir, "legacy-task");
    makeTask(tasksDir, "cap-task", { suite: "capability" });
    const report = await runEval({
      provider: smokeProvider(),
      tasksDir,
      suite: "capability",
    });
    assert.deepEqual(
      report.tasks.map((t) => t.name),
      ["cap-task"],
    );
    assert.equal(report.tasks[0].suite, "capability");
    assert.equal(report.suite, "capability");
  } finally {
    rmSync(tasksDir, { recursive: true, force: true });
  }
});

test("runEval includes manifest-declared and manifest-less regression tasks", async () => {
  const tasksDir = mkdtempSync(join(tmpdir(), "evaltasks-"));
  try {
    makeTask(tasksDir, "legacy-task");
    makeTask(tasksDir, "declared-regression", { suite: "regression" });
    makeTask(tasksDir, "cap-task", { suite: "capability" });
    const report = await runEval({
      provider: smokeProvider(),
      tasksDir,
      suite: "regression",
    });
    assert.deepEqual(
      report.tasks.map((t) => t.name),
      ["declared-regression", "legacy-task"],
    );
    assert.equal(report.tasks.every((t) => t.suite === "regression"), true);
  } finally {
    rmSync(tasksDir, { recursive: true, force: true });
  }
});

test("runEval runs all tasks with no suite selector and names the report all", async () => {
  const tasksDir = mkdtempSync(join(tmpdir(), "evaltasks-"));
  try {
    makeTask(tasksDir, "legacy-task");
    makeTask(tasksDir, "cap-task", { suite: "capability" });
    const report = await runEval({
      provider: smokeProvider(),
      tasksDir,
    });
    assert.deepEqual(
      report.tasks.map((t) => t.name),
      ["cap-task", "legacy-task"],
    );
    const byName = new Map(report.tasks.map((t) => [t.name, t.suite]));
    assert.equal(byName.get("legacy-task"), "regression");
    assert.equal(byName.get("cap-task"), "capability");
    assert.equal(report.suite, "all");
  } finally {
    rmSync(tasksDir, { recursive: true, force: true });
  }
});

// --- ticket 02: structured graders with partial credit -----------------------

interface GraderDecl {
  name: string;
  type: string;
  [key: string]: unknown;
}

function makeGradedTask(
  tasksDir: string,
  name: string,
  graders: GraderDecl[],
  checkScript = "process.exit(0);\n",
): void {
  const dir = join(tasksDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "prompt.txt"), "do the thing\n");
  writeFileSync(join(dir, "check.cjs"), checkScript);
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ suite: "regression", graders }),
  );
}

function writeHelloProvider(): FakeProvider {
  return new FakeProvider([
    {
      toolCalls: [
        {
          id: "w1",
          name: "write",
          arguments: { path: "hello.txt", content: "hi" },
        },
      ],
      usage: { input: 10, output: 2, total: 12 },
    },
    { text: "done", usage: { input: 5, output: 1, total: 6 } },
  ]);
}

test("graded task: full pass reports a named result and reason per grader and score 1", async () => {
  const tasksDir = mkdtempSync(join(tmpdir(), "evaltasks-"));
  try {
    makeGradedTask(tasksDir, "graded", [
      { name: "hello-exists", type: "fileExists", path: "hello.txt" },
      {
        name: "hello-content",
        type: "fileContains",
        path: "hello.txt",
        contains: "hi",
      },
    ]);
    const report = await runEval({
      provider: writeHelloProvider(),
      tasksDir,
      taskFilter: "graded",
    });
    const t = report.tasks[0];
    assert.equal(t.pass, true);
    assert.equal(t.score, 1);
    assert.equal(t.graders?.length, 2);
    assert.deepEqual(
      t.graders?.map((g) => g.name),
      ["hello-exists", "hello-content"],
    );
    assert.equal(
      t.graders?.every((g) => g.pass === true),
      true,
    );
    assert.equal(
      t.graders?.every((g) => g.reason.length > 0),
      true,
    );
  } finally {
    rmSync(tasksDir, { recursive: true, force: true });
  }
});

test("graded task: partial credit rolls up to a fractional task score", async () => {
  const tasksDir = mkdtempSync(join(tmpdir(), "evaltasks-"));
  try {
    makeGradedTask(tasksDir, "graded", [
      { name: "hello-exists", type: "fileExists", path: "hello.txt" },
      { name: "other-exists", type: "fileExists", path: "absent.txt" },
    ]);
    const report = await runEval({
      provider: writeHelloProvider(),
      tasksDir,
      taskFilter: "graded",
    });
    const t = report.tasks[0];
    assert.equal(t.pass, false);
    assert.equal(t.score, 0.5);
    assert.equal(t.graders?.[0].pass, true);
    assert.equal(t.graders?.[1].pass, false);
  } finally {
    rmSync(tasksDir, { recursive: true, force: true });
  }
});

test("graded task: a failing grader reports its name in the reason", async () => {
  const tasksDir = mkdtempSync(join(tmpdir(), "evaltasks-"));
  try {
    makeGradedTask(tasksDir, "graded", [
      { name: "other-exists", type: "fileExists", path: "absent.txt" },
    ]);
    const report = await runEval({
      provider: writeHelloProvider(),
      tasksDir,
      taskFilter: "graded",
    });
    const g = report.tasks[0].graders?.[0];
    assert.ok(g);
    assert.equal(g.pass, false);
    assert.match(g.reason, /absent\.txt/);
  } finally {
    rmSync(tasksDir, { recursive: true, force: true });
  }
});

test("graded task: graders assert workspace state, test results, tool usage, and transcript bounds", async () => {
  const tasksDir = mkdtempSync(join(tmpdir(), "evaltasks-"));
  try {
    makeGradedTask(tasksDir, "graded", [
      { name: "exists", type: "fileExists", path: "hello.txt" },
      {
        name: "content",
        type: "fileContains",
        path: "hello.txt",
        contains: "hi",
      },
      { name: "test-result", type: "command", command: "test -f hello.txt" },
      { name: "used-write", type: "toolUsed", tool: "write" },
      { name: "no-edit", type: "toolNotUsed", tool: "edit" },
      { name: "turn-bound", type: "maxTurns", max: 5 },
      { name: "tool-bound", type: "maxToolCalls", max: 3 },
    ]);
    const report = await runEval({
      provider: writeHelloProvider(),
      tasksDir,
      taskFilter: "graded",
    });
    const t = report.tasks[0];
    assert.equal(t.pass, true);
    assert.equal(t.score, 1);
    assert.equal(t.graders?.length, 7);
    assert.equal(
      t.graders?.every((g) => g.pass === true),
      true,
    );
  } finally {
    rmSync(tasksDir, { recursive: true, force: true });
  }
});

test("graded task: outcome graders pass for an alternative path that produces the file", async () => {
  const tasksDir = mkdtempSync(join(tmpdir(), "evaltasks-"));
  try {
    makeGradedTask(tasksDir, "graded", [
      { name: "exists", type: "fileExists", path: "hello.txt" },
      {
        name: "content",
        type: "fileContains",
        path: "hello.txt",
        contains: "hi",
      },
    ]);
    const provider = new FakeProvider([
      {
        toolCalls: [
          {
            id: "b1",
            name: "bash",
            arguments: { command: "printf hi > hello.txt" },
          },
        ],
        usage: { input: 10, output: 2, total: 12 },
      },
      { text: "done", usage: { input: 5, output: 1, total: 6 } },
    ]);
    const report = await runEval({ provider, tasksDir, taskFilter: "graded" });
    const t = report.tasks[0];
    assert.equal(t.pass, true);
    assert.equal(t.score, 1);
    assert.equal(
      t.graders?.every((g) => g.pass === true),
      true,
    );
  } finally {
    rmSync(tasksDir, { recursive: true, force: true });
  }
});

test("ungraded task keeps the check-script flow with score 0 or 1 and no graders", async () => {
  const tasksDir = mkdtempSync(join(tmpdir(), "evaltasks-"));
  try {
    makeTask(tasksDir, "legacy-pass");
    makeTask(tasksDir, "legacy-fail", {});
    writeFileSync(
      join(tasksDir, "legacy-fail", "check.cjs"),
      "process.exit(1);\n",
    );
    const provider = new FakeProvider([
      { text: "done", usage: { input: 1, output: 1, total: 2 } },
      { text: "done", usage: { input: 1, output: 1, total: 2 } },
      { text: "done", usage: { input: 1, output: 1, total: 2 } },
      { text: "done", usage: { input: 1, output: 1, total: 2 } },
    ]);
    const report = await runEval({ provider, tasksDir });
    const pass = report.tasks.find((t) => t.name === "legacy-pass");
    const fail = report.tasks.find((t) => t.name === "legacy-fail");
    assert.equal(pass?.pass, true);
    assert.equal(pass?.score, 1);
    assert.deepEqual(pass?.graders, []);
    assert.equal(fail?.pass, false);
    assert.equal(fail?.score, 0);
    assert.deepEqual(fail?.graders, []);
  } finally {
    rmSync(tasksDir, { recursive: true, force: true });
  }
});

// --- ticket 03: repeated isolated trials ------------------------------------

function makeTrialTask(
  tasksDir: string,
  name: string,
  opts: {
    workspaceFiles?: Record<string, string>;
    check?: string;
  } = {},
): void {
  const dir = join(tasksDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "prompt.txt"), "do the thing\n");
  writeFileSync(join(dir, "check.cjs"), opts.check ?? "process.exit(0);\n");
  if (opts.workspaceFiles) {
    const ws = join(dir, "workspace");
    mkdirSync(ws, { recursive: true });
    for (const [rel, content] of Object.entries(opts.workspaceFiles)) {
      const p = join(ws, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
    }
  }
}

const RESULT_CHECK = `const { readFileSync } = require("node:fs");
const v = readFileSync("result.txt", "utf8").trim();
process.exit(v === "ok" ? 0 : 1);
`;

/** Emits a uniquely-named marker on even calls and a stop on odd calls. */
class CountingMarkerProvider {
  readonly id = "fake";
  private n = 0;
  async generate(): Promise<any> {
    const i = this.n++;
    if (i % 2 === 1) {
      return {
        message: { role: "assistant", content: undefined },
        finishReason: "stop",
      };
    }
    const toolCalls = [
      {
        id: `m-${i}`,
        name: "write",
        arguments: { path: `marker-${i}.txt`, content: "x" },
      },
    ];
    return {
      message: { role: "assistant", content: undefined, toolCalls },
      toolCalls,
      finishReason: "tool_calls",
    };
  }
}

test("runEval with trials records one distinct outcome per trial", async () => {
  const tasksDir = mkdtempSync(join(tmpdir(), "evaltasks-"));
  try {
    makeTrialTask(tasksDir, "trial-task", { check: RESULT_CHECK });
    // three trials, two calls each; outcomes are pass, fail, pass
    const provider = new FakeProvider([
      {
        toolCalls: [
          { id: "a", name: "write", arguments: { path: "result.txt", content: "ok" } },
        ],
      },
      { text: "done" },
      {
        toolCalls: [
          { id: "b", name: "write", arguments: { path: "result.txt", content: "bad" } },
        ],
      },
      { text: "done" },
      {
        toolCalls: [
          { id: "c", name: "write", arguments: { path: "result.txt", content: "ok" } },
        ],
      },
      { text: "done" },
    ]);
    const report = await runEval({ provider, tasksDir, trials: 3 });
    assert.equal(report.tasks.length, 3);
    assert.deepEqual(
      report.tasks.map((t) => t.trialIndex),
      [1, 2, 3],
    );
    assert.equal(report.tasks.every((t) => t.trialCount === 3), true);
    assert.deepEqual(
      report.tasks.map((t) => t.name),
      ["trial-task", "trial-task", "trial-task"],
    );
    assert.deepEqual(
      report.tasks.map((t) => t.pass),
      [true, false, true],
    );
    assert.equal(report.summary.total, 3);
    assert.equal(report.summary.passed, 2);
  } finally {
    rmSync(tasksDir, { recursive: true, force: true });
  }
});

test("runEval defaults to a single trial with no trial metadata", async () => {
  const tasksDir = mkdtempSync(join(tmpdir(), "evaltasks-"));
  try {
    makeTrialTask(tasksDir, "solo");
    const report = await runEval({
      provider: new FakeProvider([{ text: "done" }]),
      tasksDir,
    });
    assert.equal(report.tasks.length, 1);
    assert.equal(report.tasks[0].trialIndex, undefined);
    assert.equal(report.tasks[0].trialCount, undefined);
    assert.equal(report.summary.total, 1);
  } finally {
    rmSync(tasksDir, { recursive: true, force: true });
  }
});

test("runEval gives each trial a fresh workspace with shared state and git history removed", async () => {
  const tasksDir = mkdtempSync(join(tmpdir(), "evaltasks-"));
  const ISOLATION_CHECK = `const { readdirSync, existsSync } = require("node:fs");
if (existsSync(".git")) { console.error("stale .git present"); process.exit(1); }
if (existsSync(".atom-lite")) { console.error("shared state present"); process.exit(1); }
if (!existsSync("base.txt")) { console.error("fixture missing"); process.exit(1); }
const markers = readdirSync(process.cwd()).filter((f) => /^marker-.*\\.txt$/.test(f));
if (markers.length !== 1) { console.error("expected one marker, got " + markers.length); process.exit(1); }
process.exit(0);
`;
  try {
    makeTrialTask(tasksDir, "iso", {
      check: ISOLATION_CHECK,
      workspaceFiles: {
        "base.txt": "base",
        ".git/HEAD": "ref: refs/heads/main",
        ".atom-lite/state.json": "{}",
      },
    });
    const report = await runEval({
      provider: new CountingMarkerProvider() as any,
      tasksDir,
      trials: 3,
    });
    assert.equal(report.tasks.length, 3);
    assert.deepEqual(
      report.tasks.map((t) => t.pass),
      [true, true, true],
    );
  } finally {
    rmSync(tasksDir, { recursive: true, force: true });
  }
});
