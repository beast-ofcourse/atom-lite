# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

<!-- Terminal TUI (ANSI) is the only surface today. Recorded as `web` because the
     product schema has no terminal value; it is not a browser product. -->

## Users

*(inferred, unconfirmed — the init interview was dismissed, so this comes from the
repository's README, ADRs, and positioning.)*

Developers and agent builders who run coding agents from a terminal and want a
small, readable, hackable harness instead of a large orchestration product.
They work in a repository workspace, often against local or self-hosted models
(Ollama, LM Studio, llama.cpp), and sometimes against hosted OpenAI-compatible
endpoints, Gemini, or the default Kilo gateway. They value offline operation,
explicit safety boundaries, and the ability to extend the agent without forking
the core.

## Product Purpose

Atom-lite is a local-first, model-agnostic coding agent for the terminal. It
exists to keep the harness small while making the primitives strong: one agent
loop, a conflict-aware scheduler, durable sessions, context management, and
explicit safety boundaries. Success means a model can drive real repository
work (read, edit, search, run commands) reliably without a cloud account,
telemetry, or control plane, and without the harness becoming the product.

## Positioning

The mechanism a neighboring coding agent could not truthfully copy: **a
deliberately tiny core that gains surface area through Pi-compatible
extensions.** Atom-lite ships one agent loop, one conversation, one registry,
and nine built-in tools, then extends through unmodified Pi extensions (tools,
commands, events), MCP servers, and skills. Providers are interchangeable
adapters (OpenAI-compatible, Ollama, Gemini), so the model is a choice rather
than a lock-in.

## Operating Context

- Runs in an interactive terminal (TUI) or as a one-shot CLI task; requires
  Node.js >= 22.19 and is distributed on npm as `atom-lite`.
- Primary workflow: open a repository workspace, talk to the agent, approve or
  run tools, inspect streamed tool output/diffs, and resume sessions later.
- Configuration lives in `~/.config/atom-lite/config.json` and per-project
  `.atom-lite/config.json`; secrets live in
  `~/.config/atom-lite/credentials.json` (0600) or environment variables.
- Sessions are append-only JSONL event logs, grouped by workspace and resumable.
- Modes are `plan` (blocks write/edit/bash) and `yolo`, with optional
  per-session and per-turn token budgets.
- Extensions, MCP servers, and skills are discovered from the project and user
  directories; project extensions require explicit trust.
- Documentation and architectural decisions are Markdown in the repository
  (`docs/`, `docs/adr/`), and issues/specs live under `.scratch/`.

## Capabilities and Constraints

- **Ten built-in tools:** `read`, `write`, `edit`, `bash`, `grep`, `glob`,
  `webfetch`, `websearch`, `task`, and `todo`. Everything else (tests, git,
  builds, package managers) runs through `bash`.
- **One agent loop, no core sub-agents.** Parallelism lives inside a tool-call
  batch; the scheduler applies per-file read/write locks and a global `bash`
  barrier.
- **Provider-agnostic:** OpenAI-compatible adapter, native Ollama adapter,
  Gemini adapter, and a fake adapter for tests; provider profiles combine
  endpoint, model, auth source, and options.
- **Safety boundaries:** file tools resolve against the workspace and reject
  escapes; hash guards reject stale `write`/`edit`; shell approval modes and
  process-tree termination are enforced by the runtime.
- **Durability:** JSONL sessions, session index/search, recovery, context
  compaction with the full transcript retained, and a live context meter.
- **Extensibility:** in-process Pi extension compatibility (discovery, trust,
  tools, commands, events, UI surfaces, providers, reload), MCP client/tools,
  and built-in skills.
- **Terminal UI:** pi-tui-based renderer with streaming text, tool boxes, diff
  view, command palette, pickers, themes (auto/dark/light/ansi), mouse support
  that can be disabled, and no-colour fallbacks.
- **Constraints:** TypeScript strict on NodeNext ESM; the small-core principle
  (new built-in tools need strong justification against ADR 0001); local-first
  with no telemetry or hosted database (ADR 0004).
- **Undecided:** whether the platform ever expands beyond the terminal. The
  repository contains no browser or native-app surface.

## Brand Commitments

- Name: **Atom-lite**. Tagline: "Local-first, model-agnostic coding agent for
  the terminal."
- License: MIT. Author: Atom-lite contributors. npm package: `atom-lite`.
- Voice in docs is direct, technical, and anti-hype: it explains trade-offs and
  records decisions as ADRs rather than marketing claims.
- No logo or wordmark guidance beyond `assets/atom-lite.png` and the README
  banner.

## Evidence on Hand

- `README.md` — install, quick start, configuration, tools, providers, safety,
  sessions, commands, development, and architecture.
- `docs/README.md`, `docs/configuration.md`, `docs/extensions.md` — supporting
  reference docs.
- `docs/adr/0001`–`0013` — architectural decisions, including four-tools-only,
  single agent loop, bash barrier, local-first, pi-tui, expanded toolset, MCP,
  session search, deepened loop, Pi extensions, autonomy primitives, and
  advanced tool features.
- `tests/` — behavioral test suite; `scripts/bench.mjs` — non-gating benchmark.
- `CHANGELOG.md` — release history through 0.6.2.
- **Absences future work must not fabricate:** no customer testimonials, case
  studies, press coverage, pricing page, hosted service, or user-count claims
  exist in the repository.

## Product Principles

1. **Small core, strong primitives.** Add capability by strengthening the loop,
   scheduler, context, and safety layers — not by accumulating orchestration.
2. **The model decides; the runtime enforces.** Validate arguments, enforce
   workspace boundaries, schedule calls safely, and return accurate results
   without hard-coding a workflow.
3. **Local-first is a hard constraint.** No account, telemetry, or control plane
   may become required to use the product.
4. **Extend, don't fork.** Pi extension compatibility, MCP, and skills are the
   preferred path for new surface area.
5. **Thin harness, not weak engineering.** Streaming failures, concurrent file
   access, timeouts, large outputs, context exhaustion, and session recovery are
   handled deliberately.

## Accessibility & Inclusion

- Keyboard-first operation; mouse support is optional and can be disabled
  (`ui.mouse: false`).
- Themes include `auto`, `dark`, `light`, and `ansi`; `NO_COLOR` and
  `--no-color` always win.
- Streaming and status output must remain usable in narrow terminals and
  without colour.
