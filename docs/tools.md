# Tools

Atom-lite ships built-in tools. The model chooses which to call; the runtime validates arguments, applies permissions, and schedules execution.

| Tool        | Behavior                                                         |
| ----------- | ---------------------------------------------------------------- |
| `read`      | Inspect files, directories, images, and PDFs, with ranges.       |
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

`read` returns a bounded page: at most 2000 lines or 50 KiB of content, whichever comes first. The header names the path, size, hash, and returned line range. Each text line is prefixed with its 1-based number for reference; the prefix is not file content. Lines longer than 2000 characters are clamped with a visible marker. When more content remains, the result ends with `[Output truncated. Continue reading with offset: N]`. Pass that offset to the next call to resume at the exact line.

```jsonc title="tool call"
{ "path": "src/large.ts", "offset": 2001, "limit": 2000 }
```

The runtime [`maxToolOutputBytes`](./config.md) cap is authoritative and applies on top of these bounds. With its default of `30000`, the smaller cap wins. If the cap clips first, the cursor still names the first line you did not see. An offset past the end returns the file's last lines and states the actual line count.

A directory path lists its entries instead of failing. Directories come first with a trailing `/`, then files in name order. Use the same `offset` and `limit` arguments to page the listing; the cursor follows the same form as text reads. Symlinks appear as entries but are not followed.

Images and PDFs are detected from file bytes, not extensions, and attach to the tool result when the model supports vision. Media ingestion is capped at 20 MiB; a larger file returns `MEDIA_TOO_LARGE`. Text files keep the 10 MiB limit.

A missing path is corrected when one sibling has the same stem with another extension, when a name differs only by Unicode look-alikes, or when an absolute path was written from the workspace's parent directory. Otherwise the error names up to three ranked sibling suggestions, and a missing folder names its nearest existing parent. Recovery never reads outside the workspace.

`AGENTS.md` and `CLAUDE.md` files beside a path you read become project instructions for the session. The walk stops at the workspace root; root-level instruction files are always injected, and duplicates are loaded once.

## Web fetch

`webfetch` takes a `url` and optional `format` (`text`, `markdown`, or `html`), `timeout` in seconds, `freshness`, and `extract` (`auto`, `main`, or `full`). Markdown is the default. The tool sends format-specific `Accept` headers and reads the response in bounded chunks, cancelling the stream once the useful-text threshold or `web.fetch.maxBytes` is reached. A body over the byte cap returns `OUTPUT_TRUNCATED: response too large`.

The `extract` mode selects the main or article element when it is substantial, always prefers it with `main`, or converts the whole body with `full`. Page title and description come back in structured content, not in the model-visible text. When the converted result exceeds the output cap, the full text is written to a bounded output-artifact directory and the model sees a preview plus `OUTPUT_TRUNCATED: full output at <path>`; that path can be read with `read`. The artifact is not a cache entry.

The result is capped by the smaller of `web.fetch.maxOutputChars` and `runtime.maxToolOutputBytes`. With `freshness` set to `fast` (the default), a cached result is returned immediately and refreshed in the background while it is stale; `fresh` revalidates with ETag or Last-Modified and reuses the body on `304`; `strict` bypasses and never populates the cache. Responses marked `Cache-Control: no-store` are not cached. Cache lifetime and limits are set in [`web`](./config.md).

## Web search

`websearch` takes a required `query` and optional `num_results`. It parses results, removes tracking parameters, collapses duplicate destinations, and ranks by query-term matches with domain diversity. The text result keeps a numbered title, URL, and snippet layout; structured content carries title, URL, content, and published fields. An empty result set returns `No results found.`

`web.search.maxResults` supplies the count when `num_results` is absent and caps an explicit value at 20. Search selects Tavily, Brave, Exa, or Serper from environment keys, or DuckDuckGo when no key is configured. A failing provider is cooled down and skipped on later calls; set `web.search.fallback` to `false` to disable failover and DuckDuckGo fallback. The same `freshness` modes as `webfetch` apply. Provider keys and cache settings are in [`web`](./config.md).

## Code Mode

`execute` runs JavaScript in a confined runtime to orchestrate multiple Atom Lite tools in one call. Tool results stay inside the runtime; only the final, relevant output is returned. Use it for multi-step workflows, parallel calls, loops, conditionals, and data processing. Simple tasks should still use direct tool calls.

Available tools are exposed as `tools.<name>(...)`. Limits are configured under `runtime.codeMode`: `enabled`, `timeoutMs`, `maxToolCalls`, and `maxOutputBytes`.

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
