# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
