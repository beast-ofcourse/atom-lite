# Subagent extension

Delegate tasks to specialized subagents with isolated context windows. This is
the Atom-lite port of Pi's shipped `subagent` example: one tool, one child
process per task, and markdown agent definitions.

## Install

Copy or symlink the extension and agent definitions:

```bash
mkdir -p ~/.pi/agent/extensions/subagent ~/.pi/agent/agents ~/.pi/agent/prompts
ln -sf "$(pwd)/examples/extensions/subagent/index.ts" ~/.pi/agent/extensions/subagent/index.ts
ln -sf "$(pwd)/examples/extensions/subagent/agents.ts" ~/.pi/agent/extensions/subagent/agents.ts
for f in examples/extensions/subagent/agents/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/agents/$(basename "$f")
done
for f in examples/extensions/subagent/prompts/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/prompts/$(basename "$f")
done
```

Load it for one run with `atom-lite -e ./examples/extensions/subagent/index.ts`.
Prompt templates load as slash commands: `/implement add caching`,
`/scout-and-plan refactor auth`, and `/implement-and-review add validation`.
They expand `$@` to the argument text before entering the agent.

## Modes

| Mode     | Parameters         | Description                                    |
| -------- | ------------------ | ---------------------------------------------- |
| Single   | `{ agent, task }`  | One agent, one task.                           |
| Parallel | `{ tasks: [...] }` | Up to 8 tasks, 4 at a time.                    |
| Chain    | `{ chain: [...] }` | Sequential with `{previous}` for prior output. |

Ask the model directly, for example: "Use scout to find all authentication
code" or "run two scouts in parallel".

## Agent definitions

Agents are markdown files with YAML-style frontmatter:

```md title="~/.pi/agent/agents/scout.md"
---
name: scout
description: Fast codebase recon
tools: read, grep, find, ls, bash
model: anthropic/claude-haiku-4-5
---

You are a scout. Return compressed findings for the next agent.
```

`tools` accepts a comma-separated string or a YAML array. `model` accepts
`provider/model`; omit it to reuse the parent process's `--model`, `--provider`,
and `--thinking` flags, or the configured defaults.
The body becomes the child's appended system prompt.

Locations:

- `~/.pi/agent/agents/*.md` — user agents, loaded by default.
- `.atom-lite/agents/*.md` and `.pi/agents/*.md` — project agents, opt-in.

Pass `agentScope: "both"` to include project agents. Interactive sessions ask
for confirmation before running them; only do this for trusted repositories.

## Child invocation

Each task spawns `atom-lite --mode json -p --no-session` with the agent's
system prompt, model, thinking level, and tool allowlist. The extension parses
`message_end` records to stream progress and returns the final text with usage
counts to the parent. Abort (Ctrl+C) sends SIGTERM, then SIGKILL after five
seconds. Usage in tool details includes turns, tokens, cache reads and writes,
cost when pricing is configured, and the responding model.

## Limits

- A scoped extension that does not declare `exec` still works: the extension
  calls `node:child_process.spawn` directly, so it is a trusted, user-installed
  extension. Do not install extensions from sources you do not trust.
- Child output is capped at 50 KB per task in the tool result; full details stay
  in tool metadata.
- Child usage is shown in tool details and is not added to the parent session's
  usage ledger.
- No session log is written for child turns.
