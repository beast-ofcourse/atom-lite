# 0018 — Defer removal of the checkpoint feature

Date: 2026-11-12
Status: Accepted
Supersedes: none
Amends: 0014 (checkpoints and undo)

## Context

ADR 0014 introduced git-gated automatic checkpoints before the first mutating
tool batch of a turn, with `/undo` and `/diff`. The implementation is the most
complex single subsystem in the runtime: a ~750-line store, a worker thread,
turn-lifecycle hooks, two commands, a config key, and an on-disk storage tree.

In a real session (workspace = `$HOME`, 2026-11-12) the feature produced:

- a 468,926-file capture (3m22s) that blocked the bash approval prompt;
- a second capture that blocked a 249 ms bash result for 7 minutes (worker
  timeout plus a full synchronous redo, before the d79108a fixes);
- orphan capture directories with no manifest, one of which is so large that
  `du` times out on it;
- a storage tree of 4,148 workspace roots (most pointing at deleted tmpdirs)
  including 1.2 GB and 269 MB sessions — never pruned across sessions.

Commit d79108a bounded the worst cases (self-storage exclusion, capture
budgets, fail-fast worker, orphan pruning). The operational cost and
complexity remain, and the user has decided the feature should be removed
entirely and cleanly.

## Decision

**Defer the removal.** The complete removal plan is written and approved in
direction, but gated on explicit user go-ahead:

- Spec: `.scratch/checkpoint-removal/spec.md` — full impact map, design
  decisions, and an ordered, independently shippable ticket list.
- Tickets: `.scratch/checkpoint-removal/issues/01..07`.

Until the user says go, the checkpoint feature stays exactly as shipped by
d79108a. No removal code lands before that approval.

## Rationale for deferral

- **Complexity.** Removal touches the turn lifecycle, two user-facing
  commands, the config schema, historical session logs, user data on disk, and
  all documentation. Doing it piecemeal without a mapped plan risks exactly the
  class of silent breakage this project's test redesign was built to prevent.
- **Safety net.** Checkpoints are the only automatic pre-mutation snapshot.
  Until a deliberate replacement decision is made, removing them removes a
  recovery path for mutating turns. Deferring keeps the (now-bounded) net in
  place while the decision is live.
- **Data.** Users have gigabytes of checkpoint data on disk. The cleanup
  policy (spec §2.5) needs an explicit choice before any deletion code exists.

## Consequences

- The checkpoint feature remains active with the d79108a mitigations.
- When approved, implementation proceeds ticket-by-ticket (01→07); each ticket
  is independently shippable and the suite must stay green after each.
- ADR 0014 remains in force until ticket 07 marks it superseded.
