# Quick start

Start an interactive session in the current directory:

```bash
atom-lite
```

Ask a question in the prompt, then press Enter. The agent streams its answer, calls tools when needed, and returns to the prompt.

## One-shot task

Run a task and exit:

```bash
atom-lite "explain the auth module"
```

For scripts and CI, use JSON output:

```bash
atom-lite --json "list failing tests" > result.json
```

## Pipe input

```bash
echo "summarize this repo" | atom-lite
```

## Resume work

Sessions are append-only JSONL logs grouped by workspace.

```bash
atom-lite --continue            # most recent session here
atom-lite --session SESSION_ID  # a specific session
atom-lite --list-sessions
atom-lite --search-sessions "auth"
```

In the TUI, `/sessions` opens a searchable picker and `/search <query>` prints matching sessions with snippets. See [Sessions](./sessions.md).

## First settings

User config lives at `~/.config/atom-lite/config.json`. Project config lives at `<workspace>/.atom-lite/config.json` and cannot set secrets or safety fields.

```jsonc title="~/.config/atom-lite/config.json"
{
  "runtime": { "mode": "plan" },
  "ui": { "theme": "auto" },
}
```

See [Config](./config.md) for fields and precedence.
