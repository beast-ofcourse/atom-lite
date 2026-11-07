# ADR-0011: Host Pi extensions in-process

## Status

Accepted

## Context

Atom-lite aims to run unmodified Pi coding-agent extensions. The
alternative is to spawn Pi as a separate process and bridge its extension
API, but that would duplicate the agent loop, session store, tool
scheduler, and UI, and would prevent extensions from registering tools and
commands into Atom-lite's own runtime.

## Decision

Atom-lite hosts Pi extensions in-process. Each extension is loaded with
`jiti` into the same Node process and receives an Atom-lite-owned
implementation of Pi's `ExtensionAPI`. Extensions register tools, commands,
providers, models, widgets, and event handlers into Atom-lite's own
registries; those registrations are then surfaced through Atom-lite's single
agent loop, tool scheduler, session store, and TUI.

Atom-lite never creates a second agent loop. ADR-0002 remains in force:
extensions hook into the existing loop through events and registered tools
rather than driving their own.

Module identity is kept single by aliasing every supported Pi host specifier
(`pi-tui`, `pi-agent-core`, `pi-ai`, `typebox`, `@sinclair/typebox`, and
the legacy `@mariozechner/*` names) to Atom-lite's own copies.

## Consequences

- Extension code runs with the user's full permissions; the trust boundary
  is the project trust decision (see ticket 01), not a sandbox.
- Class identity checks and schema validation rely on the alias map; a
  missed specifier breaks compatibility.
- Reloads must disable module caching so edits are observed.
- Extensions that depend on Pi-only runtime features outside the Tier 1
  surface fail loudly rather than silently.
