# 0022 — Goal continuity for long-horizon work

Date: 2026-11-17
Status: Accepted (implemented)
Related: 0001 (small built-in tool surface), 0012 (autonomy primitives), 0016 (session task ledger)

## Context

The task ledger from ADR 0016 survives compaction, but it records steps rather than the task itself. After a compaction the model can finish one request, forget another, redo completed work, or drift into adjacent work. The statement of what the task is, what success means, and whether work is still active lives only in conversation text, which the summarizer may paraphrase away. The user also has no way to see the plan in the terminal, pause a run without aborting it, or complete the task based on an explicit check.

ADR 0012 already asks compaction to retain task and goal details. The ledger satisfies the task half; there is no goal half.

## Decision

Introduce a durable goal as session state, separate from the task ledger.

- `GoalStore` in `src/runtime/goal.ts` holds a one-line statement, a short success-criteria list, a status of `active`, `paused`, or `complete`, and optional constraints. There is no owner, deadline, key-file list, decision log, or dependency graph.
- The store is owned by `AgentRuntime`, persisted as `goal_updated` session events, and restored from the latest matching event. New sessions start with no goal; resuming a session restores it. No workspace file is written. Goal state is available in plan mode because it never mutates the workspace.
- The runtime injects the rendered goal ahead of the ledger on every model build. The same rendered state is supplied to `ContextManager` as static context and fed to the summarizer, so the summary is anchored to the user's task rather than to incidental chat.
- On the build where compaction occurs, `ContextManager` inserts one continuation instruction derived from the goal and ledger stores. It names the goal, criteria, current todo, and next action, and directs the model to continue without redoing completed work. The runtime mirrors that single message into the transcript and the session log. Repeating it every turn would spend tokens without improving accuracy, since the goal and ledger are already injected each turn.
- Pause is a goal status, not a new global mode and not the escape-key abort. The runtime checks it at the iteration boundary: in-flight tool calls and the current iteration finish, then no new model iteration starts. Resume restores iteration from the saved goal and ledger without replaying completed work.
- Add a `goal` built-in tool with `read` and `complete` actions only. The statement, criteria, status, and constraints stay user-owned through the `/goal` command. Completion is a soft gate: every criterion must be backed by a completed todo or by explicit evidence in the call; otherwise the tool returns a model-visible error naming the unmet criteria and the run continues.
- Extend the `todo` tool with `add`, `complete`, `clear`, and `remove` while keeping `read`, `write`, and `update`. Todos keep stable string identifiers so edits cannot silently retarget another item.
- Add an optional `context.compactionModel` setting. Unset means use the active model, so installing this feature cannot change default compaction behavior. Before summarization, individual tool outputs are bounded, the serialized history is capped, and an earlier file read is dropped when a later read already carries the same content. Goal, ledger, criteria, active file paths, and the retained summary are never dropped. Active file paths are derived from recent `read`/`write`/`edit` tool calls and injected as static context beside the goal and ledger.
- The CLI exposes `/goal` with set, criteria, constraints, pause, resume, clear, complete, and status forms, and a toggleable side panel that renders goal, status, criteria, constraints, and todo statuses from runtime state events. The status line shows the open-todo count.

## Consequences

- Justification against ADR 0001: the goal tool, like the ledger tool, mutates session state only. It is core agent-loop durability across compaction and resumption, not a repository workflow action.
- The goal and ledger remain separate stores. Folding the goal into the ledger would make the anchor editable as an ordinary task and reintroduce drift.
- The completion gate is deliberately soft. It blocks a completion claim, not the run; the model can keep working and retry.
- Web parity is deferred. The browser surface has its own command registry and protocol; adding a second implementation now would not improve CLI reliability.
- Goal and ledger content are part of the session log and follow the same retention rules as other session events.

## Alternatives considered

- **Workspace goal dotfile.** Rejected: it would add a workspace mutation, conflict with plan mode, and leak stale goals into other sessions.
- **Store the goal in the ledger.** Rejected: it would make the user-owned anchor as editable as an ordinary todo.
- **Repeat the continuation every turn.** Rejected: the goal and ledger are already injected every turn, so repetition costs tokens without adding accuracy.
- **Hard completion gate that ends the run.** Rejected: an unmet criterion is feedback for the model, not a reason to abort autonomous work.
