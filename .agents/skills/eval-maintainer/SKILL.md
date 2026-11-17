---
name: eval-maintainer
description: "Run and improve the local eval harness. Use when running an eval suite or repeated trials, triaging an eval failure, reviewing a failed transcript, adding or strengthening a task or grader, or fixing harness drift. The public eval documentation is the source of truth."
---

# Eval maintainer

The eval loop finds harness failures, fixes them, and locks them down so they cannot come back. This skill owns the loop. It is a workflow, not a second harness: call the same commands a human would call, and keep state in the conversation and in run artifacts rather than a new database.

The [public eval documentation](../../../docs/eval.md) is the single source of truth for the task format, suites, graders, commands, metrics, and artifact layout. Read it before changing the harness and link to it instead of duplicating it here. Detailed reference lives on that page, not in this skill.

## When to use

- A suite run reports a failure or a score drop against its baseline.
- A task passes once but fails across repeated trials (a stability problem, not a capability win).
- You need to add a task, a grader, or a reference solution.
- The agent drifts: a missed tool call, a lost thread on compaction, a mishandled approval, or an ignored persona permission.

## The loop

Work through these steps in order. Do not skip step 4.

1. **Select the suite.** `regression` tasks should always pass and are the baseline target; `capability` tasks are unsolved or unstable and must not rewrite the regression baseline. Pick the suite that matches the failure.
2. **Run trials.** Run the affected suite with repeated trials so one lucky or unlucky model run does not decide the result. Narrow to a single task while debugging. Gate the harness plumbing with the deterministic fake-provider smoke check; provider eval stays opt-in and non-gating.
3. **Classify the failure** as a harness bug, task bug, grader bug, or model gap (see below). Fix the right thing; a genuine model gap stops the loop.
4. **Read at least one failed transcript before proposing a fix (required).** Use `npm run eval -- --review` to print failed trials, or read the stored `transcript.json` and `graders.json` directly. No fix is proposed from a score or summary line alone.
5. **Minimize the repro.** Reduce the failing case to the smallest stable task that still fails, so the regression test is small and deterministic.
6. **Fix the right thing.** Change the harness only for a harness bug; change the task or grader for a task or grader bug. Stop and report a model gap without changing the harness to compensate for model behavior.
7. **Add or strengthen a regression task for every harness fix.** A fix without a task that fails before it and passes after it is not complete.
8. **Re-run locally, then fully.** First re-run the affected task, then the full regression suite. Confirm the new task fails on the old behavior and passes on the fix.
9. **Record the outcome.** Note what was tried, the classification, the evidence from the transcript, the fix, the task added, and the re-run results in the conversation and the run artifacts, so the next maintainer knows what happened. Include the eval results in the change description so a reviewer can judge quality claims against evidence.

## Failure classification

| Class       | Signal                                                                                                                                                        | Action                                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Harness bug | Agent runtime drifts despite a correct task and grader: missed tool call, lost thread on compaction, mishandled approval, ignored persona permission.         | Fix the harness, then add or strengthen a regression task (steps 5–8).                                                                                |
| Task bug    | Even a correct reference solution fails; a task scores zero across repeated trials. Check its spec, reference solution, and fixture before blaming the agent. | Fix the task; do not change the harness.                                                                                                              |
| Grader bug  | The workspace outcome is actually correct but the grader reports failure, or the grader checks a path rather than the outcome.                                | Fix the grader; keep it deterministic and outcome-based.                                                                                              |
| Model gap   | The agent genuinely lacks the capability; task, grader, and harness are all correct.                                                                          | **Stop.** Report it as a capability gap and do not contort the harness to compensate. Promote it into the capability suite, not the regression suite. |

A task that scores zero across repeated trials is presumed broken until its specification, grader, and reference solution are checked. A task that passes once and fails across trials is a stability problem.

## Saturation

When a capability task passes across repeated trials, promote it into the regression suite so the win stays locked down. When a capability suite saturates at 100%, retire it into regression and add harder capability tasks to replace it. Suite definitions live on the [eval documentation page](../../../docs/eval.md).

## Overfitting warning

> **Warning:** Do not add tasks that only match one transcript. A task that hard-codes the exact path, wording, or tool-call sequence of a single failing run measures memorization, not behavior. Prefer deterministic, outcome-based graders that accept any valid solution, keep positive and negative cases balanced so the agent is not taught to over-trigger a behavior, and fix the harness rather than the transcript.

## Commands quick reference

Run these from the repository root. Full flag and field reference is on the [eval documentation page](../../../docs/eval.md).

| Goal                               | Command                                            |
| ---------------------------------- | -------------------------------------------------- |
| Full regression suite              | `npm run eval -- --suite regression`               |
| Single task                        | `npm run eval -- --task <name>`                    |
| Repeated trials                    | `npm run eval -- --suite <suite> --trials <n>`     |
| Review failed trials               | `npm run eval -- --review` (or `--review <runId>`) |
| Deterministic harness smoke gate   | `npm run eval:smoke`                               |
| Update a suite baseline explicitly | `npm run eval -- --suite <suite> --baseline`       |

Artifacts for each run live under `evals/out/runs/<runId>/`: `report.json`, `outcome-snapshot.json`, and one trial directory per trial with `transcript.json` and `graders.json`. `evals/out/latest.json` points at the most recent run.

## Next

- [Eval documentation](../../../docs/eval.md) — task format, graders, metrics, and artifact layout.
- [Atom-lite docs skill](../atom-lite-docs/SKILL.md) — house style for any published docs change.
