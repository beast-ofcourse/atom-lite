# External tools arrive through MCP

**Status:** Accepted.

## Context

Atom-lite keeps a deliberately small built-in toolset: `read`, `write`, `edit`,
`bash`, `webfetch`, and `websearch` (ADR 0001, ADR 0006). Users still need
integrations that Atom-lite should not grow into the core: repository hosts,
issue trackers, databases, browser drivers, and organization-specific services.

A plugin system that loads arbitrary Node modules would give those integrations
the same privileges as the agent process. That conflicts with the local-first,
small-core posture and makes the safety boundary impossible to describe.

## Decision

External tools enter Atom-lite only through the Model Context Protocol (MCP)
over stdio.

- MCP servers are declared in **user config only**. Project config cannot add,
  replace, or enable a server, because opening a repository must not launch a
  process.
- The built-in toolset stays fixed. MCP tools are additive and namespaced as
  `mcp__<server>__<tool>`.
- Servers connect lazily on first tool discovery. A failed server is marked
  unavailable, reported once, and does not break the session. `/mcp reconnect`
  retries it explicitly.
- Server processes receive a minimal environment plus the variables declared in
  user config. Provider API keys are not inherited unless the user declares
  them.
- A server marked `requiresApproval` routes every call through the same approval
  policy as shell commands, showing the tool name and arguments.
- MCP tool results map into the normal tool result shape. Text passes through;
  non-text content is summarised so the model can still reason about it.
- The transport is a small JSON-RPC 2.0 client, not the full SDK. v0.3.1 ships
  stdio only; HTTP and SSE remain out of scope for this program.

## Consequences

- A malicious or crashing MCP server is isolated to its own child process and
  cannot silently change Atom-lite's built-in tools.
- Users pay a configuration cost for integrations, but the core remains
  dependency-light and local-first.
- MCP server mode for editors (ADR 0012, later) is a separate direction of the
  same protocol and does not change the client rules above.
- Tests can inject a fake transport for protocol, timeout, cancellation, and
  refresh behaviour; one opt-in stdio smoke test exercises a real child
  process.
