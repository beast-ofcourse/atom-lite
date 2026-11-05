# ADR 0012 — Autonomy primitives: plan/yolo modes and token budgets

Date: 2026-11-05
Status: Accepted

## Context

Hard iteration/tool-call/wall-clock caps and the ask/trusted/deny approval
mode blocked long autonomous runs and forced user intervention. Context
compaction also dropped details needed across long sessions.

## Decision

- Remove `maxIterations`, `maxToolCalls`, and `maxExecutionMs` from the agent
  limits. The loop becomes unbounded, terminated by no tool calls, user abort,
  or an optional token budget.
- Replace approval modes with two modes: `plan` (read + web only) and `yolo`
  (all tools). Tab toggles between them; plan blocks write/edit/bash at
  execution time with a model-visible result.
- Add optional config fields `maxTokensPerSession` (hard stop) and
  `maxTokensPerTurn` (soft warning), defaulting to unset (no limit).
- Raise default scheduler parallelism from 4 to 10; keep bash as a global
  exclusive barrier.
- Improve compaction fidelity to retain task/goal, touched files, and
  decisions while dropping bulky outputs.

## Consequences

- Agent can complete longer multi-file tasks without arbitrary cutoffs.
- Safety shifts from per-command approval to mode + workspace boundaries +
  optional token budgets.
- Existing `approvalMode` config migrates to `mode` (trusted → yolo,
  otherwise plan).