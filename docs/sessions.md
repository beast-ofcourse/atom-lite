# Sessions

A session is an append-only JSONL event log under the user config directory. It records messages, tool calls, approvals, and state changes, and is resumable across restarts.

```bash
atom-lite --continue
atom-lite --session SESSION_ID
atom-lite --list-sessions
atom-lite --search-sessions "auth"
```

## Lifecycle

A new session stays in memory until its first message, so creating one and quitting leaves no file. The index derives a title from the first user message until `/rename rename <title>` overrides it.

| Command                                                      | Behavior                                                              |
| ------------------------------------------------------------ | --------------------------------------------------------------------- |
| `/sessions [all]`                                            | Resume a session from this workspace, or all workspaces.              |
| `/search <query>`                                            | Match titles, content, and workspace paths, ranking title hits first. |
| `/new`                                                       | Start a new session and clear goal and ledger state.                  |
| `/export [path] [--format md\|json] [--force] [--no-redact]` | Export the transcript.                                                |

`--list-sessions` and `--search-sessions` print stable tab-separated rows for scripts.

## Ownership

While a session is open, a sibling `<sessionId>.jsonl.lock` file records the owning process. The terminal and the browser server both take this lock, so one session cannot be driven from two places at once. The refusal names the holder. A lock left by a killed process is reclaimed automatically.

## Compaction

The context manager estimates tokens and summarizes older history before the context budget is exceeded. The full transcript stays on disk. Goal, ledger, success criteria, active file paths, and a bounded recent tail are injected alongside the summary.

The summary is a memory checkpoint with fixed sections: Objective, Requirements, Decisions, Work State, Next Move, Relevant Files, and Important Context. A later compaction updates the existing checkpoint instead of rewriting it from scratch. A response missing the required sections gets one corrective prompt; if it still fails, the previous checkpoint stays in place and a `context_compaction_failed` event is emitted.

The recent tail is sized in tokens, capped at 40% of the usable window, and starts on a user message so a tool call and its result stay together. `context.keepTokens` sets its budget. `context.buffer` sets the compaction reserve as a share of the model window or an exact token count; unset, it derives from `compactAtPercent`.

The session log records `context_compaction_started`, `context_compacted`, and `context_compaction_failed` events. A `context_compacted` event carries the schema version, summary, covered count and tokens, kept count, model, strategy, and usage. Old events without the extra fields still restore.

After a compaction, one continuation message names the goal, criteria, current todo, and next action. It is mirrored into the transcript and survives session resume. See [Goals](./goals.md).

Compaction settings live under `context` in [Config](./config.md#context): `compactAtPercent`, `keepTokens`, `buffer`, `compactEveryNTurns`, `reserveOutputTokens`, and `compactionModel`.

## Retention

`sessions.retentionDays` deletes sessions older than the configured age. `null` keeps everything. See [Config](./config.md#sessions).

## Recovery

Automatic checkpoints are not part of the product. Use git for undo and `/diff` to review workspace changes. Legacy checkpoint directories left by older versions can be removed:

```bash
rm -rf ~/.config/atom-lite/checkpoints
```
