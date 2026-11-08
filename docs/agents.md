# Agent personas

Primary agent personas are reusable prompt and permission presets for the one
Atom-lite agent loop. A persona changes the active role instructions,
temperature, and tool permissions; it does not create a second agent,
conversation, or tool registry. See
[ADR 0017](./adr/0017-primary-agent-personas.md) and
[ADR 0002](./adr/0002-single-agent-loop.md).

## Quick start

```sh
# List primary personas and mark the active one.
/agents

# Open an interactive picker, or switch directly.
/agent
/agent reviewer
```

The active persona appears as `agent:<name>` in the status line. Switching
rebuilds the system prompt on the next turn and leaves session messages intact.

To load a persona automatically, set `runtime.agent` in your **user** config
(`~/.config/atom-lite/config.json`):

```json
{
  "runtime": {
    "agent": "reviewer"
  }
}
```

`runtime.agent` is user-owned. Project config cannot select a persona, so
opening a repository cannot silently change the agent's prompt or permissions.
Use `/agent` to select a project-local persona after reviewing trust.

## Locations and precedence

Personas are Markdown files with YAML frontmatter. Atom-lite scans these
directories:

| Scope             | Path                             | Notes                                |
| ----------------- | -------------------------------- | ------------------------------------ |
| Bundled           | `<install>/agents/`              | Shipped personas such as `default`.  |
| Global            | `~/.config/atom-lite/agents/`    | Available in every workspace.        |
| Project migration | `<workspace>/.opencode/agents/`  | Opencode-compatible migration path.  |
| Project canonical | `<workspace>/.atom-lite/agents/` | Highest precedence for a repository. |

Later entries override earlier ones by persona name:
bundled → global → `.opencode` → `.atom-lite`. Only `.md` files with a valid
`mode: primary` frontmatter field become selectable personas.

## Trust

Project-local and `.opencode` personas require project trust. The trust
decision is shared with project extensions and stored under
`extensions.trustedProjects` in user config.

- On the first interactive run, Atom-lite lists pending project extensions and
  personas in one approval prompt.
- Approving reloads the personas immediately.
- Denying keeps them out of the registry.
- Non-interactive runs skip untrusted personas with a warning on stderr.

Bundled and global personas are always available.

## Frontmatter reference

```markdown
---
name: reviewer
description: Reviews changes for correctness and missing tests.
mode: primary
temperature: 0.1
permission:
  bash:
    "*": ask
    "git diff*": allow
    "git log*": allow
  edit: allow
  write: deny
  webfetch:
    "docs.*": ask
---

You review code changes. Focus on correctness, regressions, and missing tests.
Report findings with file and line references. Do not rewrite unrelated code.
```

| Field         | Type       | Required | Description                                                            |
| ------------- | ---------- | -------- | ---------------------------------------------------------------------- |
| `name`        | string     | no       | Persona name. Defaults to the file name without `.md`.                 |
| `description` | string     | no       | One-line summary shown by `/agents`.                                   |
| `mode`        | `primary`  | yes      | Personas without a valid mode are ignored. Subagents are out of scope. |
| `temperature` | number     | no       | Sampling temperature forwarded on every model turn.                    |
| `permission`  | nested map | no       | Per-tool `allow`, `ask`, or `deny` policy. See below.                  |
| body          | Markdown   | no       | Role instructions after the closing `---`.                             |

### Permissions

`permission` is keyed by tool name. Each tool maps invocation patterns to a
decision:

```yaml
permission:
  bash:
    "*": ask
    "git log*": allow
    "rm -rf*": deny
  edit: allow
  write: deny
```

- Patterns support `*` (any run of characters) and `?` (one character).
- An exact pattern beats any glob. Otherwise the most specific glob wins,
  regardless of declaration order.
- A flat value such as `edit: allow` is shorthand for `{ "*": allow }`.
- `allow` runs the tool without an approval prompt.
- `ask` reuses the normal approval flow; non-interactive runs deny it when no
  handler can answer.
- `deny` blocks the tool before execution and returns a model-visible error.

Tool arguments are matched against the meaningful value: `bash` uses
`command`, web tools use `url`/`query`, and file tools use `path`.

## Prompt composition

The persona body **replaces** the default role instructions. The base prompt's
task-discipline and tool-policy sections remain, then project instructions
(`AGENTS.md`/`CLAUDE.md`-style files) and the skill index are appended as usual
by the context manager.

This keeps safety and workflow guidance stable while letting a persona define
its specialty.

## Related

- [Configuration reference](./configuration.md) — `runtime.agent` and config
  precedence.
- [Extensions](./extensions.md) — extension discovery and trust review.
