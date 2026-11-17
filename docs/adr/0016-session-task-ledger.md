# ADR 0016 — Session task ledger (`todo` tool)

Date: 2026-11-07
Status: Accepted

## Context

ADR 0001 keeps the built-in tool surface small and requires a strong
justification for every new tool. Long agent turns and context compaction can
drop earlier user requests, so a model can finish one task while silently
forgetting another. Message history alone is not a reliable task list: it is
compactable and it cannot distinguish an open request from a completed one.

## Decision

- Add a tenth built-in tool, `todo`, backed by `TodoStore` in
  `src/runtime/todos.ts`. It has three actions: `read`, `write` (replace the
  list), and `update` (change one item).
- The ledger is **session state, not workspace state**. It is persisted as
  `todos_updated` session events, restored when a session resumes, injected
  next to the system prompt, and never treated as a checkpoint trigger.
- Because it does not mutate the workspace, `todo` remains available in
  `plan` mode (see the amendment to ADR 0012). `write`, `edit`, and `bash`
  stay blocked in plan mode.
- The runtime records each distinct user request in the ledger independently
  of the model, but skips continuation phrases and informational questions so
  ordinary conversation does not create phantom tasks.
- Completion is enforced softly: when the model has touched the ledger during
  the turn and items remain open, the runtime nudges the model up to three
  times before settling. The cap prevents an unresolvable item from looping
  forever.

## Consequences

- Justification against ADR 0001: a task ledger is core agent-loop state, not
  a workflow tool. It strengthens the loop's durability across compaction and
  resumption instead of adding a new action surface for repository work.
- The model still decides what to do; the runtime only preserves and surfaces
  the task list.
- Users can override the store via `todoStore`; the runtime preserves that
  instance across resumptions.
- Ledger content is part of the session log and is therefore subject to the
  same retention rules as other session events.

## Amendment (2026-11-17) — extended actions and stable identifiers

ADR 0022 extends the ledger tool from `read`, `write`, and `update` to seven
actions: `read`, `write`, `update`, `add`, `complete`, `clear`, and `remove`.
`add` appends one item, `complete` sets one item's status to `completed` with an
optional verification note, `remove` deletes one item, and `clear` empties the
list in one action. The original `write` and `update` actions are unchanged so
existing scripts keep working.

Todos use stable string identifiers. Callers may supply their own id; otherwise
the store generates `T1`, `T2`, and so on, bumping past any numeric suffix it
sees. Identifiers survive content edits and session resume, so an update or
remove action cannot silently target a different item after the list changes.
Verification notes remain optional, and the status vocabulary is unchanged.
No priorities, due dates, or dependency links were added.
