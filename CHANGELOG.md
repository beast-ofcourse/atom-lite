# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Every release increments the patch number, regardless of change size: `0.18.0`
becomes `0.18.1`.

## [Unreleased]

### Added

- `cli`: footer shows the model's context window, occupancy percentage, cumulative token and cache counts, cache-hit rate, and cost.
- `cli`: `/thinking` selects the reasoning level from the levels the active model supports; `/effort` is an alias. `keybindings.cycleThinking` can cycle them.
- `config`: `modelOverrides` and `modelThinkingLevels` carry per-model metadata and default thinking levels. The shipped model catalog can be refreshed by a curated remote overlay.
- `cli`: `/usage` prints token and cost totals grouped by the models that answered in the session.

### Changed

- `agent`: the model context window is fixed for the session. Oversized requests are handled by compaction instead of growing the window.
- `agent`: context occupancy is unknown after compaction until the next response supplies real usage.
- `agent`: the window now resolves from profile config, user overrides, and the shipped catalog instead of live provider metadata or a model-name guess.

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

- `agent`: type the agent-loop session and tool-call boundary with `AgentSession` and `SessionEventLike`, cutting ad-hoc `as any` casts from 12 to 1.
- `cli`: display provider errors and output-limit truncations in the transcript.
- `web`: display provider errors and output-limit truncations as toasts.

### Fixed

- `agent`: resume a truncated answer once and return the full accumulated text to one-shot and JSON callers instead of only the final continuation.
- `agent`: place the truncation continuation in conversation flow so Gemini keeps the system hint global and other providers keep the resume hint next to the truncated answer.
- `agent`: surface provider content-filter blocks as errors instead of presenting them as complete answers.
- `runtime`: wire the shared lock manager into `AgentRuntime` so cross-batch tool exclusion actually runs.
- `runtime`: fix RWLock writer starvation under reader bursts, detach abort listeners, and bound the live lock map without evicting held locks.

### Performance

- No performance tuning in this release. The non-gating bench reports startup at 244.5 ms against a 300 ms budget; read and write tool overhead remains over its internal 5 ms budget (8.93 ms full, 6.57 ms partial, 5.55 ms write).

## v0.18.4 — 2026-11-19

### Added

- `context`: memory checkpoints use fixed sections, validate summaries with one corrective retry, keep a token-sized recent tail, and fold instruction files into a new baseline at each compaction.
- `context`: compaction events record schema version, covered count and tokens, kept count, model, strategy, and usage; legacy events still restore.
- `context`: `keepTokens`, `buffer`, `background`, and `warming` control the recent tail, compaction reserve, background summaries, and opt-in prompt-cache keep-alive.
- `context`: native compaction uses provider-side checkpoints when advertised; `compactionStrategy` and per-provider or per-model overrides select `auto`, `summary`, or `native`.
- `web`: `webfetch` streams bounded responses, negotiates content type, extracts main content, revalidates with ETag or Last-Modified, and spills oversized output to a readable artifact.
- `web`: `websearch` parses and ranks results, collapses duplicates, adds publication dates, and supports Tavily, Brave, Exa, and Serper from environment keys with cooldown and failover.
- `config`: a new `web` section sets fetch and search cache TTLs, byte and result limits, extraction mode, provider, and fallback.
- `agents`: a deep researcher persona produces structured, cited reports from layered web and local research.
- `skills`: ship the Anthropic skill-creator and improve skills, and update the extensions skill for the current API.
- `web`: the browser shows goal and compaction status beside the task ledger, accepts `/goal` through guarded messages, and restores goal state on resume.
- `tools`: add a non-gating web benchmark and `bench:web` with committed baseline and results.

### Changed

- `context`: compaction reserves accept a percent of the model window or an exact token count, independent of response headroom.
- `web`: cached fetch and search responses are held in memory for the process lifetime, with `no-store` responses excluded.
- `deps`: add `htmlparser2` for bounded HTML parsing without a full DOM library.
- `style`: tracked sources are formatted with Prettier 3.9; the generated compatibility matrix is excluded from formatting.

### Fixed

- `context`: native provider payloads replay on later builds and after resume instead of showing a placeholder.
- `web`: `webfetch` cache entries include the extraction mode, so changing `extract` no longer returns the previous mode's body.
- `web`: goal mutators are refused for read-only viewers and while a turn is running.
- `docs`: provider cooldown behavior now matches the search tool's failure handling.

### Performance

Measured on this machine with non-gating benchmarks.

- `web`: large HTML fetch p50 is 12 ms versus 14.07 ms in the committed baseline; plain-text fetch and search p50 are 6.6 ms and 4.76 ms versus 4.04 ms and 3.25 ms.
- `cli`: the final bench run reports startup at 222 ms; read-path overhead remains over its internal 5 ms budget (8.35 ms full, 6.37 ms partial).

## v0.18.3 — 2026-11-18

### Added

- `web`: the question dialog shows numbered steps, answered checkmarks, a live answered count, and arrow-key navigation between options.

### Changed

- `cli`: assistant text, thinking, and tool output invalidate the transcript every display frame (16 ms) instead of every 50 ms, so streamed text refreshes at the render rate.
- `web`: streamed text drains up to 512 characters per 16 ms frame instead of 64 per 48 ms, so fast providers do not back up the display queue.

### Fixed

- `cli`: switching models no longer prints a "switched to" line into the transcript; the persisted choice is still recorded in the session log.

### Performance

Measured on this machine with a local paced SSE server and a real browser. `bench` is non-gating.

- `providers`: Gemini first delta arrives in 7.9 ms versus 398.8 ms for the full 20-chunk response. Earlier builds buffered the response, so first token waited for completion.
- `web`: first token paints synchronously in 0.2 ms in a browser smoke test instead of waiting a 48 ms timer.
- `cli`: stream append max 3.76 ms and uncached live 200-line frame 0.77 ms (both budget ≤ 16 ms).

### Breaking

- `context`: the repo map is now off by default. Set `context.repoMap.enabled` to `true` to restore it; the docs warn against enabling it in a home directory that contains several projects.

## v0.18.2 — 2026-11-18

### Added

- `tools`: `read` returns bounded pages with a continuation cursor, so a long file resumes at the exact next line instead of ending in a dead-end truncation marker.
- `tools`: `read` lists directories with sorted entries, trailing separators, and the same paging cursor as text.
- `tools`: `read` detects images and PDFs from file bytes, attaches them inline, and enforces a 20 MiB media ingestion limit.
- `tools`: `read` corrects mistyped paths from a same-stem sibling, Unicode look-alikes, or a wrong-root absolute path, and suggests up to three ranked siblings otherwise.
- `context`: `read` discovers `AGENTS.md` and `CLAUDE.md` beside the path and injects them as project instructions for the session.

### Changed

- `tools`: text pages carry a header with the path, size, hash, and returned line range; line-number prefixes are model-visible reference, not file content.
- `tools`: the runtime `maxToolOutputBytes` cap stays authoritative; internal 50 KiB and 2000-line budgets bound each page before that cap applies.
- `agent`: the default system prompt answers general-knowledge questions directly without tools, prefers Mermaid fences for concept diagrams, and keeps inline image paths inside the workspace.
- `docs`: tool reference and troubleshooting describe paging, directory listings, media, path recovery, and the new media errors.

### Fixed

- `tools`: clipped read output now names the first unseen line, including after the output cap clips a page or a past-end tail.
- `tools`: NUL detection applies only to the consumed page, and the sha256 header still covers the whole file after a paged read.
- `tools`: directory listings sort by raw name, bound past-end tails, and keep header ranges consistent with the entries shown.
- `context`: adding or changing a discovered instruction file invalidates the context cache on the next build.

### Performance

Measured on this machine, 15 runs, 1024 KiB file. `bench` is non-gating.

- `read full`: overhead 9.52 ms (budget ≤ 5 ms, over).
- `read partial`: overhead 7.43 ms (budget ≤ 5 ms, over).
- `write`: overhead 5.01 ms (budget ≤ 5 ms, over).
- `startup`: `--version` 266.1 ms (budget ≤ 300 ms).

## v0.18.1 — 2026-11-18

### Added

- `context`: a default-on repo map injects a bounded map of workspace definitions into every turn, with deterministic relevance ranking and TS/JS, Python, Go, Rust, and generic sources; `context.repoMap` keys resize or disable it.
- `extensions`: a generated compatibility matrix and `/extensions doctor --json` name the supported, reduced, no-op, and unsupported APIs for each extension.
- `extensions`: `pi.store` persists namespaced JSON state across restarts and reloads with versioned migrations and archiving on unload.
- `extensions`: `pi.wrapTool` intercepts built-in and extension tools; `pi.provide` and `pi.consume` share versioned services between extensions.
- `extensions`: a capability manifest exposes declared scopes in the trust prompt, enforces `exec` and `fetch` allowlists, and reports denied scopes with a typed compatibility error.
- `extensions`: `atom-lite extension test` runs a fixture with a fake provider, fake TUI, and fake session; `pi.span` and `pi.metric` record bounded observability data in doctor.
- `cli`: `matrix:generate`, `skills:sync`, and `skills:check` keep generated artifacts and the shipped extension skill in sync.
- `agent`: the system prompt gives per-tool guidance, including when to use `question`, `todo`, `goal`, and `task`.

### Changed

- `extensions`: activation and reload are transactional. A factory that throws or a reload that fails leaves zero new registrations and keeps the previous set live.
- `extensions`: the model-visible tool set resolves from the live loader on every refresh, so tool changes, `--no-tools`, and reload take effect immediately.
- `extensions`: tool registration validates name and schema, renames collisions deterministically, filters hidden tools from the model, and rejects stale definition hashes.
- `extensions`: turn, message, tool, and lifecycle events are typed and awaited; handlers run behind catch, timeout, and a reload generation guard.
- `extensions`: `getSessionManager` returns a real session read model, entries persist through resume, and extension commands receive `ExtensionContext`.
- `release`: version bumps always increment the patch number, regardless of change size.

### Fixed

- `extensions`: async lifecycle handlers, command handlers, and dialog promises no longer leak unhandled rejections or hang when an overlay closes.
- `extensions`: removing an extension drops its providers and models from selection and does not persist partial provider config to `config.json`.
- `extensions`: `exec` no longer blocks the event loop and enforces `maxBuffer` in bytes for multi-byte output.
- `extensions`: compatibility documentation, diagnostics, and the shipped skill now match the implemented API.

### Breaking

- `extensions`: deferred (Tier 3) APIs now throw a typed `ExtensionCompatibilityError` instead of a raw `TypeError`. Check `pi.supports(name)` before calling one.

## v0.18.0 — 2026-11-18

### Added

- `tools`: `question` asks you to choose labeled options or type an answer mid-turn. Supports multi-select, a custom-answer row, tabs, and a review step; dismissal stops the turn instead of inventing an answer.
- `cli`: question prompt in the TUI with number, arrow, tab, space, and escape controls. It works in plan mode and falls back to a model-facing error without an interactive terminal.
- `cli`/`web`: every completed turn reports its measured wall time and output-token throughput (`56 tok/s`) from real provider usage and call timing.
- `web`: the sidebar shows the live context window (`1.3k / 200k`, percent and fill) from the runtime's current occupancy; reconnects receive the same value in `hello`.
- `web`: the header agent chip lists primary personas and switches the active profile for the next turn; the switch is refused while a turn runs.
- `web`: the MCP overlay gains a refresh action and per-server Connect/Disconnect controls; changes apply to the running process only and are refused during a turn.
- `web`: question tool calls render as a stacked form with single-select options, multi-select checkboxes, custom answers, and dismissal that stops the turn.
- `web`: the favicon is now an `A` monogram with an orbital ring and nucleus, legible at 16px and richer at 32px and above.
- `web`: a chat's row menu can pin or unpin it; pinned chats stay in a `Pinned` group above the dated history and the choice is stored locally.
- `web`: the sidebar workspace path opens the host OS's native folder picker on Linux, macOS, Windows, and Android/Termux, and switches the workspace to the selected directory.
- `agent`: the system prompt tells the model when to show generated images inline in the web UI.

### Changed

- `web`: the desktop transcript widens to 900px while the composer stays at 768px; MCP and persona state labels are clearer and low-contrast metadata is raised.
- `web`: the home state drops the four suggestion chips and the "Atom-lite can make mistakes" disclaimer; the heading sits directly above the composer.
- `repo`: the git skill automates audit, branch, commit, gates, merge, and cleanup behind an explicit push gate; local agent and Playwright artifacts are ignored.

### Fixed

- `cli`/`web`: sub-second turns show their measured duration (`0.4s`) instead of rounding to a misleading `0s`.
- `web`: the slash-command menu no longer flickers shut while a turn streams, or when session/context updates and viewport resizes arrive.

## v0.17.0 — 2026-11-16

### Added

- `cli`: `--serve --share` now binds the web server on the LAN and prints a direct LAN URL plus QR code. Phone access needs only the same Wi-Fi network and a scan.
- `agent`: goal system with persistent statement, criteria, and constraints; `/goal` command with set, status, pause, resume, clear, and complete subcommands; goal panel in the TUI sidebar.
- `agent`: task ledger (opt-in) that the model can write to decompose work; persisted through session resume and surfaced in the TUI panel and web UI.
- `cli`: `ctrl+j` toggles the sidebar; background fill on sidebar rows; hint lines removed for cleaner rendering.
- `context`: automatic stable-prefix prompt layout keeps system prompt, skills, and context headers fixed while conversation scrolls.
- `usage`: per-call cost ledger (opt-in) with monetary cost and no-cache counterfactual fields; provider cache counters surfaced in usage and ledger; ledger tokens attributed to context components.
- `eval`: full evaluation harness with repeated isolated trials, structured graders with partial credit, pass@1 and pass^k distributions, per-suite baselines with explicit updates, durable per-run artifacts, and failed-trial review.
- `eval`: deterministic fake-provider smoke gate for CI; eval maintainer skill and public eval documentation.
- `web`: task ledger panel and resizable sidebars in the web UI.
- `web`: share mode accepts the machine's LAN address in Host and Origin checks; the per-run token remains mandatory.
- `docs`: deterministic git maintenance skill; redesigned published docs with privatized ADRs and docs skill.

### Changed

- `cli`: the outbound tunnel provider, `--tunnel-command`, and the cloudflared setup step removed; `--no-qr` remains.
- `cli`: share mode does not open a local browser; it prints the local URL for diagnostics instead.
- `runtime`: goal state persists across compaction, pause, tools, commands, and TUI; goal injection works in plan mode without enabling write tools.
- `runtime`: model decides when to use the task ledger (not forced on every turn).
- `config`: new schema fields for goal, ledger, and eval settings.

### Removed

- `cli`: the outbound tunnel provider, `--tunnel-command`, and the cloudflared setup step.
- `eval`: legacy eval scripts replaced by the new harness.

### Performance

- `read` tool: full read overhead 6.00 ms (target ≤ 5 ms); partial read 1.88 ms; write overhead 4.38 ms; edit overhead 2.89 ms; bash overhead 0.41 ms.
- `startup`: --version 192.3 ms (target ≤ 300 ms).
- `frame build`: 1k components first render 0.82 ms, cached 0.19 ms; 10k streamed lines 0.00 ms; stream append max 3.72 ms.

## v0.16.2 — 2026-11-16

### Added

- `cli`: `--serve --share` publishes the web surface through an outbound HTTPS tunnel and prints a tokenized URL plus a terminal QR code for phone access.
- `cli`: `--tunnel-command COMMAND` substitutes another tunnel provider with a `{port}` placeholder, and `--no-qr` prints only the URL.
- `web`: the server accepts exactly one published tunnel hostname in Host and Origin checks. The per-run token remains mandatory for HTTP and WebSocket requests.
- `docs`: ADR 0021 records the explicit opt-in cross-machine path and keeps default serve mode localhost-only.

### Changed

- `cli`: tunnel and server shut down together on Ctrl-C, SIGTERM, tunnel failure, or early provider exit.
- `cli`: share mode does not open a local browser; it prints the local URL for diagnostics instead.
- `deps`: terminal QR rendering adds `qrcode` to the CLI dependency set.
- `release`: v0.16.1 was superseded before npm publication; v0.16.2 carries the same web changes.

## v0.16.0 — 2026-11-16

### Added

- `web`: assistant and thinking deltas are presented through a bounded pacing queue, so a burst provider reveals text in readable steps. A live stream uses plain text with a quiet caret and gets one final markdown render; history renders only the latest 80 events behind a `Load earlier messages` control that preserves scroll position.
- `web`: `write` and `edit` results render as inline unified diffs with a path/stats header, hunk separators, sign column, subtle add/remove tints, and word-level highlights. The full diff remains available through Copy.
- `web`: thinking disclosures are restored from durable `message.thinking` in session history instead of a volatile client cache, with explicit live/done labels and a short expand transition. Mobile adds safe-area padding, larger coarse-pointer targets, and internally scrolling code and diff blocks.
- `web`: tool cards start collapsed, thinking blocks stay expanded, the composer send button becomes the stop control while a turn runs with a quiet ring pulse, and selecting a skill in `/skills` inserts `/<name> ` at the composer caret.
- `web`: live thinking gains a drawn constellation mark, a faint wash, and a pulsing rail; completed thoughts keep the expanded disclosure. A mic button uses browser speech recognition where supported and inserts recognized text at the caret.
- `web`: Escape, `/stop`, and the server-side stop protocol cancel a running turn and end it with `stopped` instead of an error.

### Removed

- `web`: the separate activity status row above the composer. Running state is now carried by the send button and the live thinking block.

### Fixed

- `web`: switching sessions no longer loses, duplicates, or misplaces thinking blocks; a single view token invalidates queued stream frames and late events from the outgoing session. Reconnecting during a thinking turn produces exactly one live block.

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
