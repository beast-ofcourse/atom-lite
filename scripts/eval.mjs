#!/usr/bin/env node
import { parseArgs } from "node:util";
import { loadConfig } from "../dist/config/load.js";
import { createProvider } from "../dist/providers/factory.js";
import { runEval, reviewEval } from "../dist/eval/runner.js";
import { join } from "node:path";

const { values } = parseArgs({
  options: {
    provider: { type: "string" },
    model: { type: "string" },
    "tasks-dir": { type: "string", default: "evals/tasks" },
    out: { type: "string", default: "evals/out" },
    task: { type: "string" },
    suite: { type: "string" },
    trials: { type: "string" },
    baseline: { type: "boolean", default: false },
    review: { type: "string" },
    "system-prompt": { type: "string" },
    "prompt-name": { type: "string" },
  },
  strict: false,
});

// Review mode: select failed trials from a stored run (default: latest) and
// print their transcript and grader detail without re-running any tasks.
if (values.review !== undefined) {
  const runId = typeof values.review === "string" ? values.review : undefined;
  const review = await reviewEval({
    outDir: values.out,
    runId,
    printer: (line) => console.log(line),
  });
  console.log(
    `reviewed ${review.failed.length} failed trial(s) from ${review.runId}`,
  );
  process.exit(0);
}

const config = loadConfig();
const provider = createProvider(config, values.provider, values.model);

let systemPrompt;
if (values["system-prompt"]) {
  const { readFileSync, existsSync } = await import("node:fs");
  const p = values["system-prompt"];
  if (!existsSync(p)) {
    console.error(`atom-lite: system prompt file not found: ${p}`);
    process.exit(1);
  }
  systemPrompt = readFileSync(p, "utf8");
}

const report = await runEval({
  provider,
  model:
    values.model ??
    config.providers?.[values.provider ?? config.defaultProvider]?.model,
  tasksDir: values["tasks-dir"],
  taskFilter: values.task,
  suite: values.suite,
  trials: values.trials ? Number.parseInt(values.trials, 10) : undefined,
  outDir: values.out,
  writeBaseline: values.baseline,
  systemPrompt,
  promptName: values["prompt-name"],
  onProgress: (m) => console.error(m),
});

console.log(JSON.stringify(report.summary, null, 2));
console.log(`report written to ${values.out}/report.json`);
