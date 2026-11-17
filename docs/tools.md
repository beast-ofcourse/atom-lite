# Tools

Atom-lite ships ten built-in tools. The model chooses which to call; the runtime validates arguments, applies permissions, and schedules execution.

| Tool        | Behavior                                                         |
| ----------- | ---------------------------------------------------------------- |
| `read`      | Inspect a file, with optional line ranges.                       |
| `write`     | Create or replace a file, guarded by `expected_hash`.            |
| `edit`      | Precise find-and-replace edit, guarded by `expected_hash`.       |
| `bash`      | Run a shell command. Tests, Git, builds, and formatters go here. |
| `grep`      | Search file contents with ripgrep, with a JavaScript fallback.   |
| `glob`      | Find files matching a glob pattern.                              |
| `webfetch`  | Fetch a URL and convert HTML to markdown.                        |
| `websearch` | Search the web and return ranked results.                        |
| `task`      | Query or control a background bash task.                         |
| `todo`      | Maintain the session task ledger.                                |

## Scheduling

A tool-call batch runs with at most `runtime.maxParallelToolCalls` (default `10`) concurrent calls. Per-file read/write locks prevent conflicting edits. `bash` is a global exclusive barrier unless `runtime.bashConcurrency` is `parallel`.

Each result is capped at `runtime.maxToolOutputBytes` (default `30000`). A `bash` call times out at `runtime.maxBashTimeMs` (default `120000`).

## Background tasks

```jsonc title="tool call"
{ "command": "npm run build", "background": true }
```

`bash` starts the process and returns a task id. Use `task` to inspect output, check status, or stop it. Background tasks belong to one turn and are drained when the turn ends.

## Plan mode

`plan` allows built-in read-only tools and any tool that declares `readOnlyHint`, including MCP and extension tools. `write`, `edit`, and `bash` are blocked. The `todo` and `goal` tools stay available because they change session state, not the workspace. Toggle with Tab or set `runtime.mode`.

## Hash guards

`write` and `edit` accept an optional `expected_hash`. If the file changed since the agent read it, the call returns `FILE_CHANGED_SINCE_READ` instead of overwriting the new content.

## Task ledger

The `todo` tool stores open and completed items as session state. It supports `read`, `write`, `update`, `add`, `complete`, `remove`, and `clear`. Identifiers are stable strings, so editing content does not retarget later updates. The ledger survives compaction and session resume.

## Extension tools

MCP and Pi-compatible extension tools join the same registry. Their names appear as `mcp__<server>__<tool>` for MCP. Tools from untrusted project extensions are not loaded. See [Extensions](./extensions.md) and [Safety](./safety.md).
