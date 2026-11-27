# Evals

Evals check harness behavior against a provider and grade the workspace each run produces. Run the deterministic smoke pass to gate the harness path, or run a real provider suite to measure quality.

```bash
npm run eval:smoke                          # deterministic fake provider; CI gate
npm run eval -- --suite regression --trials 3
npm run eval -- --task create-file
npm run eval -- --review                    # failed trials from the latest run
```

Provider-based eval is opt-in and non-gating; it is not part of CI. The smoke pass needs no config, credential, or network.

> **Compatibility note:** The task check script is `check.cjs` (not `check.mjs`), and a directory counts as a task only when it has both `prompt.txt` and `check.cjs`. In CI, only the deterministic fake-provider smoke pass (`npm run eval:smoke`) gates the harness path; provider-based eval stays opt-in and non-gating.

## Task format

A task is a directory under `evals/tasks/` (override with `--tasks-dir`). A directory counts as a task only when it has both `prompt.txt` and `check.cjs`.

```text
evals/tasks/<name>/
├── prompt.txt       # task given to the agent
├── check.cjs        # legacy check; exit 0 passes, used when no graders are declared
├── workspace/       # optional clean fixture copied into each trial
└── manifest.json    # optional suite and grader declarations
```

`check.cjs` runs with the trial workspace as its working directory and `WORKSPACE` set to that path. A zero exit code passes; any other code fails. Checks time out after 30 seconds.

Each trial starts from a fresh copy of `workspace/`. The runner strips `.git` and `.atom-lite` from the copy, runs the agent in `yolo` mode with the built-in tools, then removes the workspace. Only provider calls use the network.

## Suites

| Suite        | Purpose                                | Baseline                             |
| ------------ | -------------------------------------- | ------------------------------------ |
| `regression` | Tasks expected to pass every time.     | Default baseline target.             |
| `capability` | Unsolved or unstable work, below 100%. | Reported separately from regression. |

A task without a manifest is a `regression` task and uses `check.cjs`. Set the suite in the manifest:

```json title="evals/tasks/<name>/manifest.json"
{ "suite": "capability" }
```

Baseline comparison is scoped to the selected suite. Writing a baseline requires `--baseline`. With `--suite`, the write updates only that suite's snapshot and leaves other stored suites untouched. With no `--suite`, it keeps the legacy behavior of storing one snapshot per suite present in the report.

## Manifest fields

`manifest.json` requires only `suite` and `graders` to affect a run. These additional fields are optional and **inert in this slice** — the loader accepts them, but nothing grades them yet. They are declared here so task authors can record intent without changing results.

| Field               | Type                           | Purpose                                                          |
| ------------------- | ------------------------------ | ---------------------------------------------------------------- |
| `suite`             | `"regression" \| "capability"` | Suite membership (defaults to `regression`).                     |
| `graders`           | array                          | Deterministic graders; see [Graders](#graders).                  |
| `referenceSolution` | string                         | Path to a reference solution, used when diagnosing a zero score. |
| `tags`              | string[]                       | Free-form labels for grouping tasks.                             |
| `maxTurns`          | integer                        | Declared transcript turn limit; not enforced by grading.         |
| `maxToolCalls`      | integer                        | Declared tool-call limit; not enforced by grading.               |

To assert a turn or tool-call bound today, declare the `maxTurns` or `maxToolCalls` grader described below; the manifest-level limits above are recorded only. Missing or malformed optional values are ignored, so manifests from earlier slices keep working unchanged.

## Graders

Graders are deterministic checks declared in `manifest.json`. When a task declares graders, the runner uses them instead of `check.cjs`. Each returns a named PASS/FAIL with a reason; the task score is the fraction that pass, and the task passes only when every grader passes.

```jsonc title="evals/tasks/<name>/manifest.json"
{
  "suite": "regression",
  "graders": [
    {
      "name": "result exists",
      "type": "fileExists",
      "path": "out/result.json",
    },
    {
      "name": "has answer",
      "type": "fileContains",
      "path": "out/result.json",
      "contains": "\"ok\"",
    },
    { "name": "tests pass", "type": "command", "command": "npm test" },
  ],
}
```

Every declaration has a `name` (optional; defaults to `type`) and a `type`.

| Type           | Fields             | Passes when                            |
| -------------- | ------------------ | -------------------------------------- |
| `fileExists`   | `path`             | The path exists in the workspace.      |
| `fileContains` | `path`, `contains` | The file contains the text.            |
| `command`      | `command`          | The shell command exits 0.             |
| `toolUsed`     | `tool`             | The agent called that tool.            |
| `toolNotUsed`  | `tool`             | The agent never called that tool.      |
| `maxTurns`     | `max`              | Provider turns are at most `max`.      |
| `maxToolCalls` | `max`              | Distinct tool calls are at most `max`. |

`command` runs in the trial workspace and times out after 30 seconds. `toolUsed` and `toolNotUsed` read the trial's tool calls; the two `max` graders read its observed counts.

> **Note:** Prefer outcome graders (`fileExists`, `fileContains`, `command`). Tool and transcript limits assert behavior that outcome alone cannot show, so use them sparingly.

## Commands

| Command / flag         | Type    | Default        | Behavior                                                                                     |
| ---------------------- | ------- | -------------- | -------------------------------------------------------------------------------------------- |
| `npm run eval`         | —       | —              | Build and run the eval with the configured provider.                                         |
| `npm run eval:smoke`   | —       | —              | Build and run the fake-provider CI smoke pass.                                               |
| `--provider NAME`      | string  | config default | Override the provider adapter.                                                               |
| `--model NAME`         | string  | config default | Override the model.                                                                          |
| `--tasks-dir PATH`     | string  | `evals/tasks`  | Directory holding task folders.                                                              |
| `--out PATH`           | string  | `evals/out`    | Directory for reports and artifacts.                                                         |
| `--task NAME`          | string  | all tasks      | Run one named task.                                                                          |
| `--suite NAME`         | string  | all suites     | `regression` or `capability`.                                                                |
| `--trials N`           | integer | `1`            | Independent runs per task; values below 1 become 1.                                          |
| `--baseline`           | boolean | `false`        | Write `baseline.json`: only the selected suite, or one snapshot per suite with no `--suite`. |
| `--review [RUN_ID]`    | string  | latest run     | Print failed trials; no value selects the latest run.                                        |
| `--system-prompt FILE` | string  | unset          | Override the system prompt used for every trial. Enables prompt A/B comparison.              |
| `--prompt-name NAME`   | string  | unset          | Label recorded in the report for the prompt variant under test.                              |

Pass flags after `--`, as in `npm run eval -- --trials 3`. Provider and model defaults come from [Config](./config.md). `--review` reads stored artifacts and does not re-run tasks or load a provider.

## Metrics

The report's `summary` keeps aggregate totals for continuity; `metrics` adds spread and stability.

| Metric        | Meaning                                                                                                     |
| ------------- | ----------------------------------------------------------------------------------------------------------- |
| `pass@1`      | Mean per-task pass rate: the chance one trial passes.                                                       |
| `pass^k`      | Observed fraction of tasks whose every trial passed; 0 if any trial failed.                                 |
| `k`           | Largest trial count in the run; `pass@1` equals `pass^k` when `k` is 1.                                     |
| Per-task rate | `passed`/`trials`, `passRate`, `passAt1`, `passAtK` for each task.                                          |
| Distributions | `count`, `min`, `max`, `mean`, `median`, `p90` for input/output tokens, total tokens, turns, and wall time. |
| Baseline diff | `previousPassRate`, `deltaPassRate`, `newlyPassing`, `newlyFailing`, scoped to a suite.                     |

A task that passes once but fails across trials is a stability problem, not a capability win: `pass^k` is read from outcomes, so one failed trial drops that task's consistency to 0. When `k` is 1, `pass@k` equals `pass@1`.

## Artifacts

Each run writes a stable tree under `--out` (default `evals/out`, ignored by git):

```text
evals/out/
├── report.json                 # latest run report
├── latest.json                 # pointer to the most recent run id
├── baseline.json               # written only with --baseline
├── <task>.log                  # flat per-task log
└── runs/
    └── <runId>/
        ├── report.json
        ├── outcome-snapshot.json
        └── trials/
            └── <task>[--trial-N]/
                ├── transcript.json
                └── graders.json
```

Trial folders use `<task>--trial-<N>` when `--trials` is greater than 1, otherwise `<task>`. `transcript.json` holds the session messages; `graders.json` holds the grader results and check output.

## Review

Review prints the transcript and grader detail for failed trials without re-running them:

```bash
npm run eval -- --review              # latest run, via latest.json
npm run eval -- --review run-1700000000000
npm run eval -- --out other/out --review
```

Each failed trial prints `FAILED <label>`, one `PASS`/`FAIL` line per grader, then any error, check output, and transcript messages. Select a different run with `--review RUN_ID` or a different output directory with `--out`.

## Prompt comparison

Run the same tasks against two prompt variants and compare pass rates and token cost:

```bash
npm run eval -- --suite capability --trials 3 --baseline
npm run eval -- --suite capability --trials 3 \
  --system-prompt ./prompt-v2.md --prompt-name v2
```

The report's `baselineComparison` shows newly passing and failing tasks; `metrics.distributions` shows the input-token cost of each variant. Keep prompt tasks in the `capability` suite so they do not gate regression.

## Limits

- Check scripts and `command` graders time out after 30 seconds.
- Trials run in `yolo` mode; the approval flow is not part of the eval path.
- Provider calls are the only network dependency. Provider eval stays opt-in.

## Next

- [Config](./config.md) — provider and model defaults.
- [Test suite](../tests/README.md) — unit and integration checks.
- [Contributing](../CONTRIBUTING.md) — change and review workflow.
