# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
