# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `/trust` command: allow, deny, or reset project trust for extensions/agents from within a session (previously the decision could only be made once at the startup prompt).
- `tests/e2e/` layer: the CLI binary is spawned end-to-end against a local stub provider, verifying the full flow (args → config → streamed tool call → read tool → session log → `--json` result) with no network.
- `tests/README.md` documents the test suite's layering (unit / integration / E2E), conventions, and anti-growth rules.
- `test-suite` agent skill (`.agents/skills/test-suite/SKILL.md`) for maintaining and auditing the suite.
- Test coverage added for: the background-task pipeline (`bash background:true` → `task` tool), tool-executor plan-mode gating and lock classification, every `checkApproval` branch, `createProvider` wiring, streamed tool-call assembly, context token budgeting, process-tree termination, session crash-recovery and retention pruning, skill discovery, and config schema validation.

### Changed

- Runtime limits (`runtime.maxParallelToolCalls`, `maxToolOutputBytes`, `maxBashTimeMs`) now reach `AgentRuntime` and the tools; they were documented but silently ignored. `npm run eval` accepts the same limits.
- Plan mode now blocks mutating MCP and extension tools unless they declare `readOnlyHint: true`; previously only the built-in `write`/`edit`/`bash` were gated.
- `read` and the four `lsp_*` tools declare `readOnlyHint: true`, so concurrent reads of the same path no longer serialize on a write lock and read-only turns no longer trigger checkpoints.
- `/export` redaction now also applies the shared `security/redaction.ts` rules, catching `key: value` secret forms the inline patterns missed.
- Unknown `--flags` warn on stderr instead of vanishing.
- Repository formatting brought under Prettier compliance (the `format:check` CI gate was failing on master for previously unmodified files).

### Fixed

- bash tool no longer prompts twice for one command when plan mode and an outside-workspace `cwd` both apply.
- `BackgroundTaskManager` prunes finished task records (bounded at 32) so long sessions cannot leak memory.
- grep passes the pattern after `--`, so patterns starting with `-` are no longer parsed as ripgrep flags.
- Checkpoint worker creation terminates and falls back to the synchronous path after a hard timeout instead of hanging the turn forever.
- `sessions.enabled` and `sessions.retentionDays` are honored: disabled sessions run ephemeral (in-memory), and retention prunes session files older than the configured window.
- Removed dead modules and exports: `cli/renderer.ts`, `cli/approvals.ts`, `context/compaction.ts`, the `ModelTurn` wrapper class, unused panel color helpers, and `estimateTokens`.

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
