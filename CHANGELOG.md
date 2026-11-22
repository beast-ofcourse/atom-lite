# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Every release increments the patch number, regardless of change size: `0.18.0`
becomes `0.18.1`.

## v0.18.9 — 2026-11-22

### Added

- `agent`: Code Mode is available as the `execute` tool. It runs JavaScript in a confined runtime to orchestrate multiple Atom Lite tools in one call, with configurable timeout, tool-call, and output limits.
- `agent`: Code Mode builds nested namespaces from dotted and `__`-separated tool names.
- `agent`: compaction retries transient summarizer failures once and degrades gracefully by trimming the recent tail when compaction fails.
- `agent`: provider overflow now triggers one forced compaction and retries the turn.
- `agent`: tool result events carry Code Mode execution details for UI and session consumers.
- `skills`: bundle `code-review`, `docx`, `pdf`, `pptx`, and `xlsx` skills with their scripts, schemas, and licenses.
- `agent`: default system prompt documents when and how to use Code Mode efficiently.

### Fixed

- `runtime`: serialize concurrent approval checks so parallel tool calls no longer leave unanswered approval prompts.
- `runtime`: manual compaction clears stale context occupancy and reports failure instead of "nothing to compact".
- `agent`: long-horizon turns compact and continue across multiple turns without a fixed iteration cap.

### Changed

- `config`: add `runtime.codeMode` with `enabled`, `timeoutMs`, `maxToolCalls`, and `maxOutputBytes`.
- `agent`: Code Mode is added only when tools are available; direct tools remain available for simple tasks.
- `docs`: document Code Mode and its configuration.

## v0.18.8 — 2026-11-21

### Changed

- `npm`: republish the v0.18.7 changes because npm held v0.18.7 in staging. No source changes since v0.18.7.

## v0.18.7 — 2026-11-21

### Added

- `cli`: footer shows the model's context window, occupancy percentage, cumulative token and cache counts, cache-hit rate, and cost.
- `cli`: `/thinking` selects the reasoning level from the levels the active model supports; `/effort` is an alias. `keybindings.cycleThinking` can cycle them.
- `config`: `modelOverrides` and `modelThinkingLevels` carry per-model metadata and default thinking levels. The shipped model catalog can be refreshed by a curated remote overlay.
- `cli`: `/usage` prints token and cost totals grouped by the models that answered in the session.
- `cli`: `/q` is an alias for `/exit`.
- `agent`: a neutral seven-level thinking scale is clamped to each model's supported levels before a provider request.
- `cli`: a shipped model catalog plus a curated refresh overlay resolves context windows and reasoning capabilities.
- `usage`: per-call ledger records expose a separate tool and summary bucket for cost breakdowns.
- `bench`: TUI benchmarks cover streaming, keystroke latency, scrolling, and a side-by-side comparison against Pi's TUI.

### Fixed

- `cli`: streamed assistant answers now render after the current user turn instead of at the top of the transcript.
- `cli`: the status line shows `agent:default` when no other persona is selected.
- `cli`: provider and path are no longer duplicated in the footer and status line.
- `runtime`: plan mode returns an error naming the blocked tool and telling the agent to press Tab to switch to yolo mode.
- `cli`: tool-box clicks map to the correct block when the transcript is scrolled up.
- `agent`: Kilo gateway models resolve their context window from the catalog or provider metadata instead of showing zero.
- `web`: DuckDuckGo search uses browser-style headers to avoid bot blocking.

### Changed

- `agent`: the model context window is fixed for the session. Oversized requests are handled by compaction instead of growing the window.
- `agent`: context occupancy is unknown after compaction until the next response supplies real usage.
- `agent`: the window now resolves from profile config, user overrides, and the shipped catalog instead of live provider metadata or a model-name guess.
- `cli`: the status line and footer use two compact rows with the path dimmed after a pipe separator.
- `cli`: the footer reports the active thinking level for reasoning models.
- `cli`: the bundled `pi-tui` dependency is upgraded to 1.6.

### Performance

- `cli`: the live streaming block is reused and pre-warmed, cutting the first-token render from about 33 ms to about 6 ms.
- `cli`: the one-time cold render runs at startup, leaving no interaction frame over 16 ms in the live TUI benchmark.
- `cli`: stream sealing invalidates layout once per seal instead of twice; transcript pruning uses smaller batches to avoid scroll jumps.
- `bench`: 10k-line frame builds measure about 0.04 ms, streamed-line appends peak around 5 ms, and thinking frames measure about 0.7 ms against a 16 ms budget.

## v0.18.6 — 2026-11-19

### Fixed

- `web`: clicking the workspace path on Android or Termux now opens the in-app directory explorer instead of hanging on the unavailable native SAF picker.
- `cli`: thinking lines re-render with the current theme and terminal width instead of keeping stale styled output.

### Changed

- `web`: `hello` carries a `nativePicker` flag so the browser chooses a folder picker the host can actually open.

### Performance

- `cli`: reasoning streams wrap incrementally instead of re-wrapping the whole buffer each frame. Measured frame cost on a 512 KiB buffer at 120 columns drops from 35.01 ms to 2.41 ms.
- `bench`: add a thinking-frame metric with a 16 ms budget; 4k sealed lines measure 0.54 ms.

## v0.18.5 — 2026-11-19

### Added

- `agent`: normalize provider finish reasons (`length`, `MAX_TOKENS`, `max_tokens`, `content_filter`) through a shared resolver across Gemini, Ollama, OpenAI-compatible, and fake providers.
- `agent`: emit a `response_truncated` event when a model hits its output token limit.
- `runtime`: add `LockManager.cacheStats` and a bounded lock cache with idle-only eviction for long-session diagnostics.
- `agent`: allow a shared `lockManager` override on `AgentRuntimeOptions` for cross-batch tool exclusion.

### Changed