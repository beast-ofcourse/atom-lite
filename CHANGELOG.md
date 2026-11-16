# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `web`: a live activity hint above the composer mirrors the terminal status line with a looped spinner, rotating verbs (`thinking`, `cooking`, `building`, `crumbling`, and so on), elapsed time, and the active tool. Waiting-for-approval, disconnected, and stopped states are explicit. Escape, the inline Stop button, or `/stop` cancels the running turn; the server ends it with `stopped` instead of surfacing the cancellation as an error.

## v0.15.0 — 2026-11-16

### Added

- `web`: `atom-lite --serve [port]` starts a localhost web server (default 7317, next free port on conflict) and opens a browser UI for the same agent runtime, tools, sessions, and approvals. The server binds localhost only, issues a per-run token carried by the page and every asset, and rejects requests with a foreign origin or host.
- `web`: assistant text streams into the transcript; tool calls render as collapsible cards with live output and their final result or diff; approval prompts offer approve, deny, and trust-for-session, and fail safe as a denial when the browser goes away.
- `web`: the sidebar lists workspace sessions with title, update time, and message count, and supports resume and new. Listings are workspace-scoped and use the same JSONL logs as the terminal.
- `web`: multiple tabs share the stream; the first tab controls, later tabs are read-only viewers, and control passes on when the controller leaves. Messages sent mid-turn join the runtime's steering queue and are delivered in order before the turn ends.
- `web`: a dropped socket reconnects and replays the in-flight turn once, using buffered events and session history sliced to before the turn. A pending approval survives the drop and fails safe if nobody returns.
- `web`: a ChatGPT-style workspace with a dated session sidebar, centered 768px transcript, unframed assistant prose, right-aligned user bubbles, a 28px composer, and a System/Light/Dark theme switch seeded from the configured UI theme.
- `web`: sessions can be renamed and deleted; deleting the active chat opens a fresh one first. The header model overlay refreshes its catalog from every configured provider, and effort and plan/yolo mode are visible and switchable from the composer.
- `web`: markdown supports local workspace images with a lightbox and Mermaid fences as themed SVG with a source fallback. The composer supports file attachments under `.atom-lite/attachments`, live `/skills` and `/mcp` overlays, a workspace explorer, slash autocomplete, a command palette, and `/export`.
- `sessions`: a per-session `.jsonl.lock` gives one live owner. The terminal and the server both refuse a session held by another process and name the holder; a stale lock from a killed process is reclaimed after a short grace period.
- `docs`: ADR 0019 records the server-side web surface and ADR 0020 records session ownership; `web/DESIGN.md` documents the visual system and component decisions.
- `tests`: web protocol, session ownership, browser-serve E2E, and editor keybinding coverage.

**Deliberately deferred for the web surface:** ANSI rendering, shell mode, extension widgets, and any cross-machine access. The terminal remains the primary surface.

### Changed

- `cli`: the prompt editor binds `ctrl+backspace` to delete the previous word and `ctrl+shift+backspace` to delete the current line; legacy `ctrl+w`, `alt+backspace`, and `ctrl+u` bindings remain.
- `sessions`: a new session is written on its first message; creating one and quitting without sending a message leaves no JSONL file.
- `web`: switching sessions preserves rendered markdown, Mermaid diagrams, and the cached thinking block; a pending stream batch is flushed before the transcript resets.

### Fixed

- `tools`: the JS grep fallback applies the `glob` filter on hosts without ripgrep; previously it silently reported non-matching files.
- `web`: `ws` is pinned to 8.23.0, clearing published high-severity memory-exhaustion and moderate memory-disclosure advisories in 8.18.3.
- `web`: session retirement, pending-approval resend, and runtime-state broadcasts now share one path each, so the ownership lock is released on every flush-failure path.

## [0.14.0] — 2026-11-12

### Removed

- Checkpoint feature removed entirely (ADR 0018): automatic pre-mutation snapshots, `/undo`, and the checkpoint runtime (~1,200 lines). Recovery is git-native now; use commits, `git stash`, or your editor's local history.
- `/diff` is now git-only: working-tree changes against `git HEAD` (added, modified, deleted, untracked), same `--stat` and path-filter syntax; outside a git repository it prints a clear unavailability message instead of falling back to checkpoints.
- The `runtime.checkpointing` config key is accepted but ignored; existing user configs still parse unchanged.
- Old session logs containing checkpoint events (`checkpoint_created` / `checkpoint_failed` / `checkpoint_unavailable` / `checkpoint_restored`) still resume cleanly and keep every message intact.
- Orphaned checkpoint capture directories (left by terminated workers before a manifest was written) are purged automatically at startup. Remaining legacy data can be removed manually with `rm -rf ~/.config/atom-lite/checkpoints`; measured on a real machine this reclaims gigabytes of stale captures.

### Changed

- `temp/` scratch directory excluded from Prettier and git.

## [0.13.0] — 2026-11-12

### Added

- `/trust` command: allow, deny, or reset project trust for extensions/agents from within a session (previously the decision could only be made once at the startup prompt).
- Transient scrollbar on the TUI transcript: appears on scroll activity while the content overflows and hides after an idle delay; streaming follow does not trigger it.
- `tests/e2e/` layer: the CLI binary is spawned end-to-end against a local stub provider, verifying the full flow (args → config → streamed tool call → read tool → session log → `--json` result) with no network.
- `tests/README.md` documents the test suite's layering (unit / integration / E2E), conventions, and anti-growth rules.
- `test-suite` agent skill (`.agents/skills/test-suite/SKILL.md`) for maintaining and auditing the suite.
- `extreme-single-file-optimization` skill (`skills/extreme-single-file-optimization/SKILL.md`): an evidence-driven process for optimizing one file with differential testing and a graded report.
- Test coverage added for: the background-task pipeline (`bash background:true` → `task` tool), tool-executor plan-mode gating and lock classification, every `checkApproval` branch, `createProvider` wiring, streamed tool-call assembly, context token budgeting, process-tree termination, session crash-recovery and retention pruning, skill discovery, and config schema validation.

### Changed

- Runtime limits (`runtime.maxParallelToolCalls`, `maxToolOutputBytes`, `maxBashTimeMs`) now reach `AgentRuntime` and the tools; they were documented but silently ignored. `npm run eval` accepts the same limits.
- Plan mode now blocks mutating MCP and extension tools unless they declare `readOnlyHint: true`; previously only the built-in `write`/`edit`/`bash` were gated.
- `read` and the four `lsp_*` tools declare `readOnlyHint: true`, so concurrent reads of the same path no longer serialize on a write lock and read-only turns no longer trigger checkpoints.
- Default system prompt slimmed by ~35% by merging redundant framing, keeping every functional fact and the persona-composition contract.
- `read`, `edit`, `write`, `grep`, and `glob` use non-blocking `fs/promises` IO, so parallel tool calls stop stalling each other and the TUI event loop.
- bash live-output forwarding is coalesced (at most one TUI event per 33 ms or 8 KB) instead of one event per stdout chunk, so chatty commands no longer flood the event pipeline and renderer. Delivery is unchanged: everything pending is flushed before the tool result resolves.
- `ToolBox` renders are cached per (mutation version, width); repeated renders during streaming no longer re-wrap every line of every box in the transcript.
- `ActivityIndicator.setPhase` skips no-op transitions, and tool-output events look up their box via a Map instead of a linear scan.
- `/export` redaction now also applies the shared `security/redaction.ts` rules, catching `key: value` secret forms the inline patterns missed.
- Unknown `--flags` warn on stderr instead of vanishing.
- Removed dead modules and exports: `cli/renderer.ts`, `cli/approvals.ts`, `context/compaction.ts`, the `ModelTurn` wrapper class, unused panel color helpers, and `estimateTokens`.
- Repository formatting brought under Prettier compliance (the `format:check` CI gate was failing on master for previously unmodified files).

### Fixed

- bash resolves as soon as the shell exits even when detached descendants (`setsid`, daemons) hold the output pipes open; the grace period before the pipes are destroyed is 500 ms. stdin-reading commands get an immediate EOF instead of blocking until the timeout.
- bash tool no longer prompts twice for one command when plan mode and an outside-workspace `cwd` both apply.
- `BackgroundTaskManager` prunes finished task records (bounded at 32) so long sessions cannot leak memory.
- grep passes the pattern after `--`, so patterns starting with `-` are no longer parsed as ripgrep flags.
- Checkpoint worker creation terminates and falls back to the synchronous path after a hard timeout instead of hanging the turn forever.
- `sessions.enabled` and `sessions.retentionDays` are honored: disabled sessions run ephemeral (in-memory), and retention prunes session files older than the configured window.

### Performance

- Tool-box click hit-testing renders from a per-child height cache: 291 → 0.07 ms per click on an expanded-box transcript (measured, -99.98%).
- Context build memoizes message token estimates: 2,292 → 133 ms per build on a 400-turn session (measured, -94%).
- Checkpoint capture memoizes ignore matchers, classifies entries from `Dirent`s, and stats each file once: create 99 → 58 ms, diff 63 → 35 ms on a 1022-file workspace (measured, -41..-46%).
- `webfetch` caches successful responses for 60 s (8 entries); grep/glob accumulate ripgrep output linearly instead of quadratic string concatenation.
- bash streaming and ToolBox rendering no longer re-wrap the whole transcript per output event on chatty commands (expected; the per-event cost is bounded by the cache instead of the transcript size).

## [0.12.0] - 2026-11-08

### Added

- Primary agent personas: bundled, global, project, and `.opencode` discovery with override precedence, trust gating, and `/agents`/`/agent` commands plus an agent picker.
- Persona system prompt composition, per-persona temperature, and tool permission policies (allow/ask/deny with glob patterns).
- Architect persona shipped by default alongside default, reviewer, and ultracode.
- Async checkpoint creation via worker threads to keep the TUI responsive, with synchronous fallback.
- Project trust review now covers untrusted project agent personas alongside extensions.
- Reload (`/reload`) rescans extensions, skills, agents, and project instructions.
- Status line shows the active agent name.
- ADR 0017 and `docs/agents.md` documenting primary agent personas.

### Changed

- Agent registry layering: project beats `.opencode` beats global beats bundled; untrusted project/opencode personas are hidden until the project is trusted.
- Persona body replaces the default role instructions while task discipline and tool policy remain intact.
- Checkpoint workspace file listing uses a single combined `git ls-files` invocation with fallback.
- `/reload` refreshes skill and agent registries and recomposes the active persona.
- Trust approval of project files reloads extensions and registers their commands.

### Fixed

- Bundled architect persona is now discovered (removed stray leading blank line).
- `/reload` no longer keeps a stale skill registry.
- Deleted or renamed agent personas are reflected immediately in pickers and lists.
- Active persona is cleared when it disappears after a rescan.
- Project config cannot override the user's `runtime.agent` selection.
- Permission globs split on the final colon so patterns may contain colons.

### Performance

- Checkpoint creation runs off the main thread to avoid blocking the TUI.

## [0.11.0] - 2026-11-07

### Added

- Thinking blocks now persist with assistant messages and are restored when revisiting/resuming a session in the TUI.
- Extensions documentation (`docs/extensions.md`) describing Pi extension support.

### Changed

- Transcript blocks gain vertical spacing (`Spacer`) for clearer separation between user, assistant, tool, and thinking blocks.
- User messages render with trailing breathing room before the agent reply.
- Type-safety cleanup: `Record<string, any>` replaced with `Record<string, unknown>` across CLI, providers, extensions, MCP, and context modules; typed interfaces for provider config, model entries, and schema properties.
- Context window and vision capability extraction use typed model entries instead of untyped records.
- Agent loop and model-turn types tidied (removed unused imports, clarified unreachable return).

### Fixed

- Thinking blocks no longer disappear when leaving and revisiting a session in the TUI.
- MCP manager now returns `undefined` from cleanup path instead of an implicit value.
- Extension tool argument coercion returns are typed correctly.

### Docs

- Added extensions documentation.
- Refreshed atom-lite-extensions skill.

## [0.10.0] - 2026-11-07

### Added

- TUI user messages now render in a distinct boxed panel (`UserBox`) for clear separation from tool panels.
- Four new color themes: dracula, monokai, nord, solarized.
- Release workflow skill (`.agents/skills/release-workflow/`) documenting the full ship procedure.
