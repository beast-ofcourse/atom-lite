# Goals

A goal is a durable anchor for long work: one statement, success criteria, a lifecycle status, and optional constraints. It is session state, so it survives compaction and session resume and is cleared by `/new`.

```text
/goal set Ship the login fix
/goal criteria tests pass; docs updated
/goal constraints no new dependencies
/goal
```

Bare `/goal` prints the statement, criteria, status, constraints, and open-todo count.

## Fields

| Field       | Owner        | Behavior                                                             |
| ----------- | ------------ | -------------------------------------------------------------------- |
| Statement   | User         | One line. Set with `/goal set`.                                      |
| Criteria    | User         | Short list. Set with `/goal criteria`; lines and `;` separate items. |
| Constraints | User         | Optional. Set with `/goal constraints`.                              |
| Status      | User or tool | `active`, `paused`, or `complete`.                                   |
| Todos       | Model        | Session task ledger, maintained with the `todo` tool.                |

The model can read the goal through the `goal` tool but cannot rewrite the statement, criteria, or constraints.

## Lifecycle

| Command                     | Behavior                                                      |
| --------------------------- | ------------------------------------------------------------- |
| `/goal set <statement>`     | Create or replace the statement and reset status to `active`. |
| `/goal criteria <list>`     | Replace the success criteria.                                 |
| `/goal constraints <text>`  | Set or clear constraints.                                     |
| `/goal pause`               | Freeze the run after in-flight tool calls finish.             |
| `/goal resume`              | Clear pause and continue from saved state.                    |
| `/goal clear`               | Remove the goal and the pause gate.                           |
| `/goal complete [evidence]` | Apply the completion gate.                                    |
| `/goal status`              | Show current state.                                           |

## Pause

Pause is a goal status, not plan mode and not the escape-key abort. The runtime checks it between model iterations: in-flight tools and the current iteration finish, then no new iteration starts. Resume continues from the saved goal and ledger without restating the task. A paused goal survives session resume.

## Completion gate

The model marks a goal complete with the `goal` tool:

```jsonc title="tool call"
{ "action": "complete", "evidence": "CI green and README updated" }
```

Every criterion must be backed by a completed todo whose text names it, a completed todo's verification note, or explicit evidence in the call. Otherwise the call returns `GOAL_CRITERIA_UNMET` with the unmet criteria named. The gate is soft: it rejects the completion call, not the run, and the model can keep working.

## Interface

The goal panel opens beside the transcript whenever a goal or todos exist. It shows the statement, status, criteria, constraints, and todo statuses. `ctrl+j` toggles it. With the panel hidden, the status line still shows `todos:<count>`. The browser shows the same goal state in its right-hand panel and accepts the same `/goal` forms; mutators there are refused for read-only viewers and while a turn runs.

After each compaction, one continuation instruction is injected into model context and mirrored into the transcript. It names the goal, criteria, current todo, and next action, and tells the agent to continue without redoing completed work.
