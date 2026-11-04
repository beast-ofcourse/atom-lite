# ADR 0009 — Session index, search, and resume in place

Date: 2026-11-04
Status: Accepted

## Context

Long-running work spans multiple CLI invocations. Users need to find, inspect,
and resume prior sessions without losing transcript context, and the terminal UI
should support mouse wheel scrolling and click-to-focus on capable terminals.

## Decision

- Derive a session title from the first user message, overridable by a
  `session_renamed` event. Persist `session_resumed` and `session_renamed`
  events in the append-only JSONL log.
- Keep session search in pure helpers (`src/sessions/search.ts`) operating on an
  extended `SessionSummary` (`title`, `messageCount`, `searchText`, `snippet`).
  `/sessions` opens a searchable picker scoped to the workspace with an
  all-workspaces toggle; `/search <q>` prints matching sessions with snippets.
  `--list-sessions` and `--search-sessions` print the same index as stable
  tab-separated rows.
- Resume replaces the active session, restores retained messages into the
  transcript, and surfaces provider/model differences as a switch offer rather
  than switching automatically.
- Capture mouse events only for interactive TTY sessions with `ui.mouse`
  enabled. Wheel events scroll the transcript; left clicks focus the input or
  toggle a tool box; capture is disabled while a modal is open and restored on
  exit or suspend/resume.

## Consequences

- Session lookup and search stay testable without a TUI or store instance.
- Mouse handling degrades to keyboard-only on non-TTY or disabled
  configurations.
- Resume records provenance (`session_resumed.from`) without mutating prior
  events.
