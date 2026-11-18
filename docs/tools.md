# Tools

Atom-lite ships built-in tools. The model chooses which to call; the runtime validates arguments, applies permissions, and schedules execution.

| Tool        | Behavior                                                         |
| ----------- | ---------------------------------------------------------------- |
| `read`      | Inspect a file or directory, with optional line or entry ranges. |
| `write`     | Create or replace a file, guarded by `expected_hash`.            |
| `edit`      | Precise find-and-replace edit, guarded by `expected_hash`.       |
| `bash`      | Run a shell command. Tests, Git, builds, and formatters go here. |
| `grep`      | Search file contents with ripgrep, with a JavaScript fallback.   |
| `glob`      | Find files matching a glob pattern.                              |
| `webfetch`  | Fetch a URL and convert HTML to markdown.                        |
| `websearch` | Search the web and return ranked results.                        |
| `task`      | Query or control a background bash task.                         |
| `todo`      | Maintain the session task ledger.                                |
| `question`  | Ask you to choose an option or type an answer mid-turn.          |

## Reading large files

`read` returns a bounded page: at most 2000 lines or 50 KiB of content, whichever comes first. Lines longer than 2000 characters are clamped with a visible marker. When more content remains, the result ends with `[Output truncated. Continue reading with offset: N]`. Pass that offset to the next call to resume at the exact line.

```jsonc title="tool call"
{ "path": "src/large.ts", "offset": 2001, "limit": 2000 }
```

The runtime [`maxToolOutputBytes`](./config.md) cap is authoritative and applies on top of these bounds. With its default of `30000`, the smaller cap wins. If the cap clips first, the cursor still names the first line you did not see. An offset past the end returns the file's last lines and states the actual line count.

A directory path lists its entries instead of failing. Directories come first with a trailing `/`, then files in name order. Use the same `offset` and `limit` arguments to page the listing; the cursor follows the same form as text reads. Symlinks appear as entries but are not followed.

## Scheduling

A tool-call batch runs with at most `runtime.maxParallelToolCalls` (default `10`) concurrent calls. Per-file read/write locks prevent conflicting edits. `bash` is a global exclusive barrier unless `runtime.bashConcurrency` is `parallel`.

Each result is capped at `runtime.maxToolOutputBytes` (default `30000`). A `bash` call times out at `runtime.maxBashTimeMs` (default `120000`).

## Background tasks

```jsonc title="tool call"
{ "command": "npm run build", "background": true }
```

`bash` starts the process and returns a task id. Use `task` to inspect output, check status, or stop it. Background tasks belong to one turn and are drained when the turn ends.

## Plan mode

`plan` allows built-in read-only tools and any tool that declares `readOnlyHint`, including MCP and extension tools. `write`, `edit`, and `bash` are blocked. The `todo`, `goal`, and `question` tools stay available because they change session state or ask for input without touching the workspace. Toggle with Tab or set `runtime.mode`.

## Hash guards

`write` and `edit` accept an optional `expected_hash`. If the file changed since the agent read it, the call returns `FILE_CHANGED_SINCE_READ` instead of overwriting the new content.

## Task ledger

The `todo` tool stores open and completed items as session state. It supports `read`, `write`, `update`, `add`, `complete`, `remove`, and `clear`. Identifiers are stable strings, so editing content does not retarget later updates. The ledger survives compaction and session resume.

## Questions

`question` asks you to pick between labeled options or type an answer while a turn is running. Use it when the model needs a preference, a clarification, or a decision before continuing.

```jsonc title="tool call"
{
  "questions": [
    {
      "header": "Environment",
      "question": "Which environment should I target?",
      "options": [
        { "label": "Dev", "description": "Local development" },
        { "label": "Prod", "description": "Production" },
      ],
    },
  ],
}
```

- Every question needs a short `header` (about 30 characters) and a complete `question`. An empty `options` list asks for free text.
- Set `multiple: true` to allow more than one selection.
- A "Type your own answer" row is added automatically. Do not add an "Other" option.
- In the terminal, one option question answers as soon as you pick. Several questions get tabs and a review before submit. Number keys and arrows move the selection, `Enter` confirms, `Space` toggles a multi-select, `Tab` and `Shift+Tab` move between questions, and `Escape` dismisses.
- In the browser, the questions appear as one stacked form: radio-style options for a single answer, checkboxes for `multiple`, and a "Type your own answer" field for each question. **Submit answers** returns them; **Dismiss**, the close button, or `Escape` dismisses.
- Only the controlling browser tab can answer. If control moves, the pending form follows the new controller.
- Dismissing stops the turn. The model does not receive a fabricated answer.
- Without an interactive terminal or browser, the tool returns an error and the model continues without asking.

## Extension tools

MCP and Pi-compatible extension tools join the same registry. Their names appear as `mcp__<server>__<tool>` for MCP. Tools from untrusted project extensions are not loaded. See [Extensions](./extensions.md) and [Safety](./safety.md).
