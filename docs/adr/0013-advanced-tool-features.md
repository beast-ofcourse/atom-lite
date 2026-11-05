# ADR 0013 — Advanced tool features (background execution, vision input)

Date: 2026-11-05
Status: Accepted

## Context

Long-running commands block the agent turn; image files cannot reach vision-capable models; and tool output streaming existed only in the TUI.

## Decision

- Add a `background` flag to `bash` backed by an in-memory `BackgroundTaskManager` (cap 4 concurrent, 10-min timeout, 30k output). Background starts are still serialized through the scheduler's global bash barrier during startup; the running process is not locked.
- Add a single `task` tool for status/output/wait/cancel.
- Inject completed background results as system messages after the current tool batch.
- Extend `ContentPart` and `ToolResult` to carry image data (base64 + mime). `read` detects images, returns base64 for vision-capable models, and rejects oversized/non-vision cases.
- Provider adapters map image parts where supported; others use a text placeholder.
- No new runtime dependencies; no model-facing streaming tool results.

## Consequences

- The built-in tool count increases to nine.
- Background tasks are not persisted across sessions.
- Image token estimation is skipped (risk of context overflow on many large images).