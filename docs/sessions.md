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

`/cd` records a `session_directory_changed` event. Resume restores the latest directory from that event, so the session's workspace follows the last directory you used.

## Ownership

While a session is open, a sibling `<sessionId>.jsonl.lock` file records the owning process. The terminal and the browser server both take this lock, so one session cannot be driven from two places at once. The refusal names the holder. A lock left by a killed process is reclaimed automatically.

## Compaction

The context manager estimates tokens and summarizes older history before the context budget is exceeded. The full transcript stays on disk. Goal, ledger, success criteria, active file paths, and a bounded recent tail are injected alongside the summary.

The model window stays fixed for the session. When a request exceeds it, compaction reduces the context; Atom-lite does not grow the window to fit. After a compaction the footer shows context occupancy as unknown until the next response supplies real usage. Run `/usage` to see token and cost totals grouped by the models that answered in this session.

The summary is a memory checkpoint with fixed sections: Objective, Requirements, Decisions, Work State, Next Move, Relevant Files, and Important Context. A later compaction updates the existing checkpoint instead of rewriting it from scratch. A response missing the required sections gets one corrective prompt; if it still fails, the previous checkpoint stays in place and a `context_compaction_failed` event is emitted.

Instruction text follows the same boundary. The first set is frozen as a baseline in an `instruction_baseline` event, later changes are recorded as hash-identified updates, and each compaction folds the current text into a new baseline. Nested `AGENTS.md` files found beside reads are re-injected after compaction.

The recent tail is sized in tokens, capped at 40% of the usable window, and starts on a user message so a tool call and its result stay together. `context.keepTokens` sets its budget. `context.buffer` sets the compaction reserve as a share of the model window or an exact token count; unset, it derives from `compactAtPercent`.

With `context.background: true`, Atom-lite writes a summary before the trigger and holds it in memory for the session. It swaps the held summary in when compaction is due and the recent tail is still bounded; otherwise it summarizes as usual. Held summaries are lost on restart, and a summary that is never used still costs tokens.

`context.warming` enables opt-in prompt-cache keep-alive. It reuses the last model context on a timer, stops on a reported cache miss, and never treats a provider that reports no cache counters as a miss.

A provider that advertises native compaction can store an encrypted checkpoint on its side. `context.compactionStrategy` selects `native`, `summary`, or `auto`; a provider profile and its per-model `models` map can override the global setting. The active model is used for native compaction, recent user messages stay inside the keep budget, and the provider's opaque payload is stored in the `context_compacted` event with its provider and model id. A provider rejection is an error, not a downgrade to summary. If the model changes, replay continues from the original conversation instead of the foreign payload.

The runtime emits `context_compaction_started` and `context_compaction_failed` as terminal activity events. The session log records the completed `context_compacted` event with the schema version, summary, covered count and tokens, kept count, model, strategy, and usage. Old events without the extra fields still restore.

After a compaction, one continuation message names the goal, criteria, current todo, and next action. It is mirrored into the transcript and survives session resume. See [Goals](./goals.md).

Compaction settings live under `context` in [Config](./config.md#context): `compactAtPercent`, `keepTokens`, `buffer`, `compactEveryNTurns`, `reserveOutputTokens`, and `compactionModel`.

## Retention

`sessions.retentionDays` deletes sessions older than the configured age. `null` keeps everything. See [Config](./config.md#sessions).

## Recovery

Automatic checkpoints are not part of the product. Use git for undo and `/diff` to review workspace changes. Legacy checkpoint directories left by older versions can be removed:

```bash
rm -rf ~/.config/atom-lite/checkpoints
```
