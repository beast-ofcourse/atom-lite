import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeProvider } from "../../dist/providers/fake.js";
import { runSmokeCheck } from "../../dist/eval/smoke.js";

test("smoke check loads tasks, executes them, grades them, and writes a report", async () => {
  const result = await runSmokeCheck();

  assert.equal(result.ok, true, result.failures.join("\n"));
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.checks, {
    taskLoading: true,
    execution: true,
    grading: true,
    reportCreation: true,
  });
  assert.deepEqual(result.taskNames, [
    "smoke-create-file",
    "smoke-legacy-file",
  ]);
  assert.equal(result.report.summary.total, 2);
  assert.equal(result.report.summary.passed, 2);
  assert.equal(result.report.summary.passRate, 1);
  assert.equal(
    result.report.tasks.every((t) => t.turns > 0),
    true,
  );
  assert.deepEqual(result.reportOnDisk?.summary, result.report.summary);
});

test("smoke check fails the gate when the provider does not perform the task", async () => {
  const provider = new FakeProvider([
    { text: "no work", usage: { input: 1, output: 1, total: 2 } },
    { text: "no work", usage: { input: 1, output: 1, total: 2 } },
  ]);

  const result = await runSmokeCheck({ provider });

  assert.equal(result.ok, false);
  assert.equal(result.checks.grading, false);
  assert.ok(result.failures.some((f) => f.includes("grading")));
});
