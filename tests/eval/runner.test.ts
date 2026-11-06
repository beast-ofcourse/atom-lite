import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeProvider } from "../../dist/providers/fake.js";
import { runEval } from "../../dist/eval/runner.js";

test("runEval discovers tasks and reports pass/fail", async () => {
  const provider = new FakeProvider([
    { toolCalls: [{ id: "w1", name: "write", arguments: { path: "hello.txt", content: "hi" } }] },
    { text: "done" },
    { toolCalls: [{ id: "b2", name: "bash", arguments: { command: "printf '{\"x\":2}' > config.json" } }] },
    { text: "done" },
  ]);
  const tasksDir = join(process.cwd(), "evals", "tasks");
  const outDir = mkdtempSync(join(tmpdir(), "evalout-"));
  const report = await runEval({ provider, tasksDir, outDir });
  assert.equal(report.tasks.length, 2);
  assert.equal(report.summary.total, 2);
  // both should pass given the scripted writes
  assert.equal(report.summary.passed, 2);
  assert.equal(report.summary.failed, 0);
  rmSync(outDir, { recursive: true, force: true });
});

test("runEval writes report.json and per-task logs", async () => {
  const provider = new FakeProvider([
    { toolCalls: [{ id: "w1", name: "write", arguments: { path: "hello.txt", content: "hi" } }] },
    { text: "done" },
  ]);
  const tasksDir = join(process.cwd(), "evals", "tasks");
  const outDir = mkdtempSync(join(tmpdir(), "evalout-"));
  const report = await runEval({ provider, tasksDir, taskFilter: "create-file", outDir });
  assert.equal(report.tasks.length, 1);
  const { existsSync } = await import("node:fs");
  assert.ok(existsSync(join(outDir, "report.json")));
  assert.ok(existsSync(join(outDir, "create-file.log")));
  rmSync(outDir, { recursive: true, force: true });
});

test("runEval task filter limits tasks", async () => {
  const provider = new FakeProvider([
    { toolCalls: [{ id: "w1", name: "write", arguments: { path: "hello.txt", content: "hi" } }] },
    { text: "done" },
  ]);
  const tasksDir = join(process.cwd(), "evals", "tasks");
  const report = await runEval({ provider, tasksDir, taskFilter: "create-file" });
  assert.equal(report.tasks.length, 1);
  assert.equal(report.tasks[0].name, "create-file");
});

test("runEval records turns and tokens from usage events", async () => {
  const provider = new FakeProvider([
    { toolCalls: [{ id: "w1", name: "write", arguments: { path: "hello.txt", content: "hi" } }], usage: { input: 10, output: 2, total: 12 } },
    { text: "done", usage: { input: 5, output: 1, total: 6 } },
  ]);
  const tasksDir = join(process.cwd(), "evals", "tasks");
  const report = await runEval({ provider, tasksDir, taskFilter: "create-file" });
  const t = report.tasks[0];
  assert.equal(t.turns, 2);
  assert.equal(t.inputTokens, 15);
  assert.equal(t.outputTokens, 3);
});

test("runEval baseline comparison when baseline.json exists", async () => {
  const provider = new FakeProvider([
    { toolCalls: [{ id: "w1", name: "write", arguments: { path: "hello.txt", content: "hi" } }] },
    { text: "done" },
  ]);
  const tasksDir = join(process.cwd(), "evals", "tasks");
  const outDir = mkdtempSync(join(tmpdir(), "evalout-"));
  // write a baseline with 0 passed
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(outDir, "baseline.json"), JSON.stringify({ summary: { passRate: 0 }, tasks: [{ name: "create-file", pass: false }] }));
  const report = await runEval({ provider, tasksDir, taskFilter: "create-file", outDir });
  assert.ok(report.baselineComparison);
  assert.equal(report.baselineComparison?.newlyPassing.includes("create-file"), true);
  rmSync(outDir, { recursive: true, force: true });
});

test("compareBaseline computes deltas", async () => {
  const { compareBaseline } = await import("../../dist/eval/runner.js");
  const cur = { summary: { passRate: 1 }, tasks: [{ name: "a", pass: true }] } as any;
  const base = { summary: { passRate: 0 }, tasks: [{ name: "a", pass: false }] } as any;
  const cmp = compareBaseline(cur, base);
  assert.equal(cmp.newlyPassing.includes("a"), true);
  assert.equal(cmp.deltaPassRate, 1);
}
);
