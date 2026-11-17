#!/usr/bin/env node
// CI gate: run the eval harness end-to-end against a deterministic fake provider.
// No config, credential, or network is involved; provider eval stays opt-in via
// `npm run eval`, which is intentionally not part of CI.
import { runSmokeCheck } from "../dist/eval/smoke.js";

const result = await runSmokeCheck();
if (!result.ok) {
  console.error("eval smoke check FAILED:");
  for (const failure of result.failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(
  `eval smoke ok: ${result.report.summary.passed}/${result.report.summary.total} tasks passed via fake provider (task loading, execution, grading, report)`,
);
