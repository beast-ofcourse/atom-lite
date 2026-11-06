# ADR 0014 — Checkpoints and undo

Date: 2026-11-06
Status: Accepted

## Context

`yolo` mode lets the agent mutate the workspace without a recovery point. A bad turn could not be undone, and users could not inspect what changed before accepting it. Recovery must not corrupt the user's own Git state.

## Decision

- Checkpointing is a runtime concern, not a built-in tool. The agent loop captures at most one checkpoint before the first mutating tool batch of a turn.
- Checkpointing is Git-gated: it works only inside a Git worktree. Outside Git it is disabled with a clear warning and no checkpoint is created.
- Snapshots are stored outside the workspace, under the user config directory, with restrictive permissions. The user's index and `HEAD` are never touched; Git is used only to discover the worktree and enumerate tracked/untracked non-ignored files.
- Restore is file-level: snapshot files are copied back and files created after the checkpoint are removed (unless `--keep-untracked`). No `git reset`, `git checkout`, or `git stash` is ever run.
- Read-only built-ins do not trigger a checkpoint. Extension and MCP tools are treated as potentially mutating.
- Non-interactive runs disable checkpointing by default; an explicit config option or flag enables it. Interactive runs always checkpoint.
- Empty (no-change) turns discard their checkpoint.
- `/undo`, `/undo list`, `/undo <n>`, `/diff`, `/diff --stat`, and `/diff <path>` expose recovery and review.

## Consequences

- Recovery is reliable and never clobbers unrelated work, at the cost of not supporting non-Git workspaces (a future fallback may add copy-based snapshots).
- The checkpoint store is a new runtime module with its own storage, pruning, and restore semantics.
- Recovery state is not part of the tool surface, preserving the small built-in tool count.