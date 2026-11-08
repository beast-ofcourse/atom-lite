# ADR 0017 — Primary agent personas

Date: 2026-11-08
Status: Accepted

## Context

ADR 0002 keeps Atom-lite to one agent loop, one conversation, one tool
registry, and one control loop. Users still need different working styles:
a reviewer, an architect, or a backend engineer should be able to change role
instructions, sampling temperature, and tool permissions without inventing a
second orchestration layer.

Opencode-style personas are Markdown files with frontmatter and a prompt body.
They are a natural fit for Atom-lite because they can reuse the existing
context builder, model turn, and approval matcher.

## Decision

- Add a persona registry in `src/agents/registry.ts`. It scans bundled, global,
  `.opencode`, and `.atom-lite` agent directories, parses frontmatter, and
  applies precedence bundled → global → `.opencode` → `.atom-lite`.
- A persona has a name, description, mode, optional temperature, nested
  permission policy, body, source, and path. Flat permission values normalize
  to `{ "*": decision }`.
- Apply a persona to the **existing** `AgentRuntime`:
  - the body replaces the default role instructions while task discipline and
    tool policy remain;
  - temperature flows through `ModelTurnRequest` into provider options;
  - permissions are resolved at the tool-execution seam and reuse
    `checkApproval` for `ask`.
- Add `/agents` and `/agent <name>`, and show the active persona in the status
  line. Switching recomposes the system prompt without clearing messages.
- Add `runtime.agent` to user config to select a startup persona. It is
  user-owned so a repository cannot silently change the active prompt or
  permissions.
- Gate project-local and `.opencode` personas behind the existing project trust
  decision shared with extensions. Untrusted personas are skipped; the
  interactive trust prompt lists them, and non-interactive runs warn on
  stderr.
- Ship a bundled `agents/default.md` so the feature works out of the box.

## Consequences

- Personas remain prompt and policy presets. There are still no sub-agents,
  swarms, workflow graphs, or competing loops, preserving ADR 0002.
- Project personas require an explicit trust decision; trusted repositories can
  ship personas and users can select them with `/agent`.
- `mode: subagent` files are parsed for forward compatibility but are not
  selectable in this scope.
- Permission `ask` in a non-interactive run is denied because no handler can
  answer, matching existing approval behavior.
- Hot reloading is out of scope; restart the process or switch with `/agent`.
