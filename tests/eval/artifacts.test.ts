import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeProvider } from "../../dist/providers/fake.js";
import { runEval } from "../../dist/eval/runner.js";

// --- ticket 05: durable run artifacts and failed-trial review ----------------

function makeArtifactTask(tasksDir: string, name: string): void {
  const dir = join(tasksDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "prompt.txt"), "do the thing\n");
  writeFileSync(join(dir, "check.cjs"), "process.exit(0);\n");
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      suite: "regression",
      graders: [
        { name: "hello-exists", type: "fileExists", path: "hello.txt" },
        {
          name: "hello-content",
          type: "fileContains",
          path: "hello.txt",
          contains: "hi",
        },
      ],
    }),
  );
}

/** Write hello.txt with the given content, then finish. */
function writeHello(content: string): any[] {
  return [
    {
      toolCalls: [
        {
          id: `w-${content}`,
          name: "write",
          arguments: { path: "hello.txt", content },
        },
      ],
      usage: { input: 5, output: 1, total: 6 },
    },
    { text: "done", usage: { input: 5, output: 1, total: 6 } },
  ];
}

test("runEval writes a stable per-run artifact tree with report, transcripts, grader detail, and outcome snapshot", async () => {
  const tasksDir = mkdtempSync(join(tmpdir(), "evaltasks-"));
  const outDir = mkdtempSync(join(tmpdir(), "evalout-"));
  try {
    makeArtifactTask(tasksDir, "graded");
    const report = await runEval({
      provider: new FakeProvider(writeHello("hi")),
      tasksDir,
      outDir,
    });

    const runDir = join(outDir, "runs", report.runId);
    assert.ok(existsSync(join(runDir, "report.json")), "run report.json");
    assert.ok(
      existsSync(join(runDir, "outcome-snapshot.json")),
      "outcome snapshot",
    );
    assert.ok(
      existsSync(join(runDir, "trials", "graded", "transcript.json")),
      "per-trial transcript",
    );
    assert.ok(
      existsSync(join(runDir, "trials", "graded", "graders.json")),
      "per-trial grader detail",
    );

    const snapshot = JSON.parse(
      readFileSync(join(runDir, "outcome-snapshot.json"), "utf8"),
    );
    assert.equal(snapshot.outcomes.length, 1);
    assert.equal(snapshot.outcomes[0].name, "graded");
    assert.equal(snapshot.outcomes[0].pass, true);
    assert.equal(snapshot.runId, report.runId);
  } finally {
    rmSync(tasksDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("runEval retains machine-readable transcripts for both passing and failing trials", async () => {
  const tasksDir = mkdtempSync(join(tmpdir(), "evaltasks-"));
  const outDir = mkdtempSync(join(tmpdir(), "evalout-"));
  try {
    makeArtifactTask(tasksDir, "graded");
    const provider = new FakeProvider([...writeHello("hi"), ...writeHello("bad")]);
    const report = await runEval({ provider, tasksDir, outDir, trials: 2 });
    assert.deepEqual(report.tasks.map((t) => t.pass), [true, false]);

    for (const t of report.tasks) {
      const path = join(
        outDir,
        "runs",
        report.runId,
        "trials",
        `graded--trial-${t.trialIndex}`,
        "transcript.json",
      );
      assert.ok(existsSync(path), `transcript for trial ${t.trialIndex}`);
      const messages = JSON.parse(readFileSync(path, "utf8"));
      assert.ok(Array.isArray(messages), "transcript is a JSON array");
      assert.ok(messages.length > 0, "transcript is non-empty");
      assert.ok(
        messages.some(
          (m: any) =>
            m.role === "user" && JSON.stringify(m.content).includes("do the thing"),
        ),
        "transcript includes the recorded user message",
      );
    }
  } finally {
    rmSync(tasksDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("reviewEval selects only failed trials and returns their transcript and grader detail", async () => {
  const tasksDir = mkdtempSync(join(tmpdir(), "evaltasks-"));
  const outDir = mkdtempSync(join(tmpdir(), "evalout-"));
  try {
    makeArtifactTask(tasksDir, "graded");
    const provider = new FakeProvider([
      ...writeHello("hi"),
      ...writeHello("bad"),
      ...writeHello("hi"),
    ]);
    const report = await runEval({ provider, tasksDir, outDir, trials: 3 });
    assert.deepEqual(report.tasks.map((t) => t.pass), [true, false, true]);

    const printed: string[] = [];
    const { reviewEval } = await import("../../dist/eval/runner.js");
    const review = await reviewEval({
      outDir,
      runId: report.runId,
      printer: (line: string) => printed.push(line),
    });

    assert.equal(review.runId, report.runId);
    assert.equal(review.failed.length, 1);
    assert.equal(review.failed[0].name, "graded");
    assert.equal(review.failed[0].trialIndex, 2);
    assert.ok(Array.isArray(review.failed[0].transcript));
    assert.ok(review.failed[0].transcript.length > 0);
    assert.equal(
      review.failed[0].graders.some((g: any) => g.pass === false),
      true,
    );

    // Content surfaces in the printed output; no particular format is assumed.
    const text = printed.join("\n");
    assert.ok(text.includes("graded"));
    assert.ok(text.includes("hello-content"));
    assert.ok(text.includes("do the thing"));
  } finally {
    rmSync(tasksDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("reviewEval defaults to the latest run and reports no failures when all trials pass", async () => {
  const tasksDir = mkdtempSync(join(tmpdir(), "evaltasks-"));
  const outDir = mkdtempSync(join(tmpdir(), "evalout-"));
  try {
    makeArtifactTask(tasksDir, "graded");
    const report = await runEval({
      provider: new FakeProvider(writeHello("hi")),
      tasksDir,
      outDir,
    });
    const printed: string[] = [];
    const { reviewEval } = await import("../../dist/eval/runner.js");
    const review = await reviewEval({
      outDir,
      printer: (line: string) => printed.push(line),
    });
    assert.equal(review.runId, report.runId);
    assert.deepEqual(review.failed, []);
  } finally {
    rmSync(tasksDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("run artifacts are ignored by git", () => {
  const gi = readFileSync(join(process.cwd(), ".gitignore"), "utf8");
  assert.match(gi, /evals\/out\/?/);
});
