# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.9.3] - 2026-11-07

### Added

- TUI renders Mermaid diagrams as Unicode box-drawing art (via `grok-mermaid`), in both streamed and sealed transcript chunks.

### Changed

- Checkpoint creation skips files that exceed the byte budget instead of aborting the whole checkpoint; default budget raised to 100 MB.
- Mermaid rendering is cached and deferred to seal/finalize to keep the TUI responsive.

### Fixed

- TUI no longer lags on every streaming delta from per-chunk Mermaid rendering.
- `CHECKPOINT_TOO_LARGE` no longer aborts checkpoint creation for large workspaces.

### Docs

- Added `lsp` configuration reference and a system-prompt note on enabling LSP.

## [0.9.2] - 2026-11-07

### Added

- Optional built-in LSP client subsystem (off by default): lazy per-workspace servers, JSON-RPC over stdio, diagnostics caching, definition/reference/symbol navigation, and clean shutdown.
- `system_message` session event type so system messages round-trip faithfully across save/load.
- LSP diagnostics surfaced after write/edit operations.

### Changed

- Agent loop wraps turn execution in try/finally and flushes the session before reporting completion.
- Provider retries (OpenAI-compatible and Ollama) honor the request AbortSignal via the shared signal-aware `delay` helper.
- Context instruction cache is now scoped by workspace.
- LockManager releases the global read lock when per-file acquire fails.
- Background-task `wait` is abort-aware.
- Scheduler guards `maxParallel` against zero/negative values.

### Fixed

- System messages (skill loads, background-task results) no longer replay as assistant messages after resume.
- `delay()` rejects with `USER_CANCELLED` on abort instead of resolving.
- OpenAI-compatible network-error retry path uses signal-aware delay.
- MCP connect cleanup on reset/close races.
- Sessions tolerate vanished files while listing.
- Ollama retries transient streaming failures.
- LSP shutdown now sends the `shutdown`/`exit` requests before tearing down.

## [0.9.1] - 2026-11-07

### Added

- Session task ledger (`todo` tool) with completion gate, request-id tracking, and resume persistence.
- `/new` command (replacing `/clear`) creates a fresh session and resets token usage to 0.

### Changed

- Context window resolution now prefers live provider metadata and never downgrades below configured/static values; 1M models display correctly.
- Auto-compaction at 85% now also triggers on real provider usage, counts tool schema overhead, and uses adaptive recent-message retention.

### Fixed

- Compaction no longer silently no-ops on small histories.
- `formatContextUsage` shows `?` for an unknown window instead of a bare used count.
- Injected `TodoStore` identity is preserved across session resume.

## [0.9.0] - 2026-11-06

### Added

- Filesystem checkpoint fallback so `/undo` and `/diff` work in non-Git workspaces (copy-based snapshots; honors root `.gitignore`).
- Shared provider retry helper with exponential backoff, `Retry-After` handling, and abort-aware delays.

### Changed

- `grep` now runs ripgrep asynchronously, unblocking parallel tool batches.
- Session persistence is asynchronous (queued writes with `flush()`), reducing per-turn I/O.
- `edit` diff rendering is bounded for large files to stay within the performance budget.
- Process-tree termination on Windows is non-blocking.
- Provider retry behavior (429/5xx/network) is consistent across OpenAI-compatible, Ollama, and Gemini adapters, including streaming.

### Fixed

- Checkpoint availability reporting reflects filesystem fallback.

## [0.8.0] - 2026-11-06

### Added

- Configurable keyboard shortcuts via the `keybindings` config section.
- `/shortcuts` command to list active shortcuts.
- `/keybindings` command to open the keybindings config file.
- Input history on Up/Down using the editor's native history.

### Fixed

- Arrow keys no longer break slash-command autocomplete navigation.

## [0.7.0] - 2026-11-06

### Added

- Clickable “↓ bottom” control above the status line to jump the transcript to the end.
- `/rename` command (replacing `/session`) for showing or renaming the current session.

### Fixed

- Resuming a session via `/sessions` now rebuilds rich transcript components (Markdown, collapsible tool boxes with output/diff/error state) instead of flattening to raw text.
- Thinking blocks are finalized before tool calls, so later thinking steps render as separate blocks.
- Session JSONL storage trimmed: removed redundant `tool_call_started` events and duplicated top-level message fields.

### Changed

- Session tool results now persist `isError` and `diff` for faithful resume rendering.

## [0.6.3] - 2026-11-06

### Added

- Interactive approval prompts (y/n/t) for read/write/edit/bash operations outside the workspace, in both plan and yolo modes.

### Changed

- Default mode is now yolo; legacy `ask`/`trusted` approvalMode values migrate to yolo.
- Outside-workspace operations prompt regardless of mode; hard-blocked in non-interactive sessions.

## [0.6.2] - 2026-11-05

### Fixed

- Direct publish (bypass staged registry conflict).

## [0.6.1] - 2026-11-05

### Fixed

- Shell mode result rendering and @ mention fuzzy search (fd path).
- npm publish (staged 0.6.0 could not be approved locally).

## [0.6.0] - 2026-11-05

### Added

- Autonomy primitives: removed hard caps, added optional token budgets, plan/yolo modes with Tab toggle, higher scheduler parallelism, improved compaction fidelity.
- Interactive `@` file/folder mentions (including hidden files via `fd`) and `!` shell mode.
- Built-in skills: `atom-lite-extensions`, `code-review`, `caveman`, `optimization`.
- Richer default system prompt.

### Changed

- Replaced ask/trusted/deny approval modes with plan/yolo modes.
- Configuration: `approvalMode` -> `mode`; added `maxTokensPerSession`/`maxTokensPerTurn`.

### Fixed

- Shell command results now render (resolve on process exit).
- Hidden files included in `glob`/`grep` tools.

## [0.5.0] - 2026-11-05

### Added

- Unmodified Pi coding-agent extension support: discovery, project trust,
  in-process loading via `jiti`, extension tools, commands, events, and
  session entries, plus ADR-0011 and the extensions guide.
- `/extensions doctor` diagnostics, `/steer` mid-turn injection, and
  message queuing during active turns.
- Continuous dimmed thinking blocks in the TUI.

## [0.4.1] - 2026-11-04

### Fixed

- npm publish retry after staged 0.4.0 conflict.

## [0.4.0] - 2026-11-04

### Added

- Extension discovery and manifest parsing (`src/extensions/discovery.ts`).
- Project trust gating and extension loader lifecycle with `/extensions`.
- `/export` for sessions.
- Markdown rendering for assistant responses and unified diff summaries in tool boxes.
- Literal edit replacement handling.
- Escape to cancel an active turn.
- TUI mouse capture fixes.

### Fixed

- Mouse capture sequence and startup ordering for TUI mouse support.

[0.4.0]: https://github.com/beast-ofcourse/atom-lite/releases/tag/v0.4.0

## [0.3.1] - 2026-11-04

### Added

- MCP client over stdio: user-config-only `mcpServers`, lazy connections, tool
  discovery and execution as `mcp__<server>__<tool>`, refresh on
  `tools/list_changed`, `/mcp` and `/mcp reconnect`, and `/doctor` health.
- Session picker and search (`/sessions`, `/search`), resume in place, and
  `/session rename`.
- Command palette (`ctrl+p`), semantic theme registry, and TUI mouse support.
- Configuration reference and documentation index.

### Fixed

- Ollama provider profiles now forward the `think` option to the adapter.

[0.3.1]: https://github.com/beast-ofcourse/atom-lite/releases/tag/v0.3.1

## [0.1.0] - 2026-11-04

### Added

- Local-first interactive TUI with streaming assistant output, thinking display,
  boxed tool calls, and collapsible transcripts.
- Single agent loop with a conflict-aware tool scheduler.
- Built-in `read`, `write`, `edit`, `bash`, `webfetch`, and `websearch` tools.
- Provider adapters for OpenAI-compatible endpoints, Ollama, and Gemini.
- Interactive `/provider` setup with hidden API-key input and validation.
- Fuzzy `/model` picker spanning every configured provider.
- Durable JSONL sessions with resume support.
- Context management with compaction, project instructions, and skill indexing.
- Live context-window usage in the status line (`tokens: 4.5k/256k`).
- Bold-red ANSI Shadow startup banner.
- Approval modes, workspace path boundaries, and hash-guarded writes.
- Non-gating performance benchmark suite for tools, startup, and TUI rendering.

[0.1.0]: https://github.com/beast-ofcourse/atom-lite/releases/tag/v0.1.0
