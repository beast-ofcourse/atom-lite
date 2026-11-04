# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
