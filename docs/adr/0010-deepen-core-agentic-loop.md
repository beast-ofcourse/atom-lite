# ADR 0010 — Deepen the core agentic loop modules

Date: 2026-11-04
Status: Accepted

## Context

The core agent loop inlined provider streaming, session/event recording, and tool
scheduling. This made the loop harder to test and modify.

## Decision

Deepen three modules while preserving behavior:

- `ModelTurn` normalizes provider streaming and generation behind one async
  event stream.
- `TurnRecorder` concentrates session mutation and event emission for assistant
  and tool outcomes.
- `ToolExecutor` owns locking, concurrency, and dispatch behind a small
  `run(calls, context, signal)` interface.

`AgentRuntime` remains the single orchestrator. Compatibility wrappers keep
existing callers and tests working.

## Consequences

- Provider and scheduling details are hidden behind stable seams.
- The loop reads primarily as orchestration.
- Existing tests remain valid through compatibility wrappers.
