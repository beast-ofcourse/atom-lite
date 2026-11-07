# ADR 0015 — Eval harness

Date: 2026-11-06
Status: Accepted

## Context

Prompt, compaction, and tool-schema changes were validated only by unit tests and manual runs. There was no task-level baseline showing whether the agent actually completes coding work, and no way to compare runs across providers or models.

## Decision

- Add an internal, non-gating eval suite under `evals/` and a runner (`npm run eval`).
- Each task is a self-contained directory: `prompt.txt`, an optional `workspace/` fixture, and a deterministic `check.mjs`.
- The runner drives tasks through the normal agent runtime with the built-in tools, records per-task pass/fail, turns, input/output tokens, and wall time, and writes a report plus per-task logs.
- A baseline file records the last accepted run and supports comparison.
- The suite is opt-in and must not require network access for fixtures; provider calls are the only network dependency.
- No task-specific logic lives in the runner.

## Consequences

- Quality changes can be measured against a recorded baseline instead of judged by feel.
- The runner depends on the built-in tool set; adding a tool requires updating the runner's tool list.
- Eval results vary by provider and model; the suite is non-gating to avoid blocking merges on flaky providers.
