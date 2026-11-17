import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
