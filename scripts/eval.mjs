#!/usr/bin/env node
import { parseArgs } from "node:util";
import { loadConfig } from "../dist/config/load.js";
import { createProvider } from "../dist/providers/factory.js";
import { runEval } from "../dist/eval/runner.js";
import { join } from "node:path";

const { values } = parseArgs({
  options: {
    provider: { type: "string" },
    model: { type: "string" },
    "tasks-dir": { type: "string", default: "evals/tasks" },
    out: { type: "string", default: "evals/out" },
    task: { type: "string" },
    baseline: { type: "boolean", default: false },
  },
  strict: false,
});

const config = loadConfig();
const provider = createProvider(config, values.provider, values.model);
const report = await runEval({
  provider,
  model: values.model ?? config.providers?.[values.provider ?? config.defaultProvider]?.model,
  tasksDir: values["tasks-dir"],
  taskFilter: values.task,
  outDir: values.out,
  writeBaseline: values.baseline,
  onProgress: (m) => console.error(m),
});

console.log(JSON.stringify(report.summary, null, 2));
console.log(`report written to ${values.out}/report.json`);
