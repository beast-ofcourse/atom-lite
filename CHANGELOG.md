# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
