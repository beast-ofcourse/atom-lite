# pi-tui replaces OpenTUI

**Status:** Accepted. Supersedes [ADR 0005](./0005-opentui-for-terminal-ui.md).

## Context

ADR 0005 selected OpenTUI as the terminal UI framework. The implementation instead
built the interactive CLI on `@earendil-works/pi-tui`, a TypeScript component and
differential-rendering library. `@opentui/core` remained in `package.json` without
being imported anywhere until it was removed for the 0.1.0 release.

## Decision

Atom-lite uses `@earendil-works/pi-tui` for the interactive terminal interface.

Reasons:

- It provides the components the CLI actually needs — containers, text, scroll
  views, spacers, and key handling — without pulling a React runtime into the CLI.
- It is plain TypeScript with differential rendering, so there is no native
  renderer binary to ship or build per platform.
- It meets the project's performance budgets: startup stays under 300 ms and
  frame builds stay under 16 ms for the tested workloads.

## Consequences

- `@opentui/core` is not a dependency. Do not reintroduce it without a new ADR.
- Rendering behavior is covered by the TUI tests and the non-gating benchmark
  suite (`npm run bench`).
- Any change of TUI framework requires a new ADR and benchmark evidence.
