# Plan 002: Resolve scheduler lock keys against the workspace

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise.
>
> **Drift check (run first)**:
> `git diff --stat 37e692e..HEAD -- src/runtime/scheduler.ts tests/runtime/scheduler.test.ts`
> If either file changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch, treat
> it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW-MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `d2d4d2b`, 2026-11-03
- **Verified at**: commit `37e692e` (excerpts unchanged; `const key = resourceKey(call)` is at line 39)

## Why this matters

The product's headline safety property is a "conflict-aware scheduler": reads
share a lock, writes are exclusive per file, and `bash` is a global barrier. That
guarantee is implemented with a lock key derived from the model's raw `path`
argument. Two tool calls that name the same file differently (`src/a.ts`,
`./src/a.ts`, `/abs/ws/src/a.ts`) receive **different locks** and run in
parallel. The per-file lock manager also canonicalizes relative keys against
`process.cwd()` rather than the workspace, so aliases are not normalized anyway.

Result: within one tool-call batch, a `read` can run concurrently with a `write`
to the same file, and two conflicting edits can both read the pre-edit content —
the lost-update class of bug the scheduler exists to prevent, on the path agents
hit constantly (edit the same file twice in one response).

## Current state

- `src/runtime/scheduler.ts` — `executeToolBatch`: builds tasks, acquires a
  concurrency slot, acquires a lock, executes the tool, returns results in
  original call order. Lines 6-13 hold the key derivation:

```ts
function resourceKey(call: ToolCall): string {
  const args = call.arguments ?? {};
  if (call.name === "bash") return "__bash__";
  const p = (args as any).path ?? (args as any).cwd ?? "";
  return String(p);
}
```

and line ~40 uses it:

```ts
    const key = resourceKey(call);
    if (key === "") return () => {};
    if (isMutation(call)) return lm.acquireWrite(key, signal);
    return lm.acquireRead(key, signal);
```

- `src/runtime/locks.ts` — `LockManager`. `canonical(key)` (lines 6-21) walks up
  to the nearest existing ancestor and applies `realpathSync`, then re-appends
  the suffix. It receives whatever string the scheduler passes: a bare relative
  path is interpreted relative to the process CWD, which may differ from the
  workspace and is never the workspace when `cwd !== workspace`.

Caller: `src/agent/loop.ts:143-151` calls `executeToolBatch(toolCalls, this.toolMap, ctx, …)`, where `ctx.workspace` is set. Tests call it directly with a `ctx(dir)` helper.

## Commands you will need

| Purpose   | Command             | Expected on success |
|-----------|---------------------|---------------------|
| Install   | `npm install`       | exit 0              |
| Typecheck | `npm run typecheck` | exit 0              |
| Tests     | `npm test`          | exit 0, all pass    |

`npm test` builds first; tests import from `dist/`.

## Scope

**In scope**:
- `src/runtime/scheduler.ts`
- `tests/runtime/scheduler.test.ts`

**Out of scope**:
- `src/runtime/locks.ts` — the lock implementation is correct; only the key it
  is given changes. Do not modify it (it has an unrelated listener-cleanup
  concern that is not part of this plan).
- `src/agent/loop.ts`, `src/tools/*` — no signature changes there; `ctx` is
  already passed into `executeToolBatch`.
- Case-insensitive filesystem normalization, path `realpath` on the tool side,
  `bash` concurrency — all explicitly deferred.

## Git workflow

- Branch: `advisor/002-workspace-resolved-lock-keys`
- Commit subject in the repo's style: `fix: resolve scheduler lock keys against the workspace`
- Do NOT push or open a PR.

## Steps

### Step 1: Resolve the key against `ctx.workspace`

In `src/runtime/scheduler.ts`, add `import { resolve } from "node:path";` at the
top, change the signature of `resourceKey` to take the workspace, and resolve:

```ts
function resourceKey(call: ToolCall, workspace: string): string {
  const args = call.arguments ?? {};
  if (call.name === "bash") return "__bash__";
  const p = (args as any).path ?? (args as any).cwd ?? "";
  if (p === "") return "";
  return resolve(workspace, String(p));
}
```

Update the one call site inside `acquire`:

```ts
    const key = resourceKey(call, ctx.workspace);
```

Nothing else in the function changes: `isBash` still short-circuits to
`lm.acquireGlobal(signal)`, and `webfetch`/`websearch` still return a no-op
release before the key is computed.

**Verify**: `npm run typecheck` → exit 0.

### Step 2: Add the aliasing regression test

Append to `tests/runtime/scheduler.test.ts`, reusing its existing `ctx()` helper
and `toolMap` construction style:

```ts
test("aliased paths to the same file serialize", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  writeFileSync(join(dir, "y.txt"), "one");
  const calls = [
    {
      id: "1",
      name: "edit",
      arguments: { path: "y.txt", old_string: "one", new_string: "two" },
    },
    {
      id: "2",
      name: "edit",
      arguments: { path: "./y.txt", old_string: "two", new_string: "three" },
    },
  ];
  const toolMap = new Map([
    ["read", readTool],
    ["write", writeTool],
    ["edit", editTool],
    ["bash", bashTool],
  ]);
  const res = await executeToolBatch(
    calls as any,
    toolMap,
    ctx(dir),
    4,
    new AbortController().signal,
  );
  assert.ok(!res[0].isError);
  assert.ok(!res[1].isError);
  assert.equal(readFileSync(join(dir, "y.txt"), "utf8"), "three");
});
```

On the pre-fix code both edits run in parallel against `"one"`, so the second
returns `EDIT_NOT_FOUND` and the final content is not `"three"` — the test fails
for the right reason.

**Verify**: `npm test` → exit 0, all pass, including the new test.

### Step 3: Confirm absolute paths also share the lock

No code change expected: `resolve(workspace, "/abs/path")` returns the absolute
path and `canonical()` realpaths it. Just re-run the suite.

**Verify**: `npm test` → exit 0.

## Test plan

- New test `aliased paths to the same file serialize` (relative vs `./` relative)
  in `tests/runtime/scheduler.test.ts`.
- Existing scheduler tests must keep passing — especially `results returned in
  original call order even if completion differs`, `bash barrier serializes with
  file ops`, and `conflicting edits to same file serialize`.
- Structural pattern: the existing `conflicting edits to same file serialize`
  test in the same file.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0, including the new aliasing test
- [ ] `grep -n "resourceKey(call, ctx.workspace)" src/runtime/scheduler.ts` matches
- [ ] `git status` shows only the two in-scope files
- [ ] `plans/README.md` status row for 002 updated

## STOP conditions

Stop and report back if:

- `executeToolBatch` no longer receives a `ToolContext` with a `workspace` field.
- A test depends on the old (unresolved) key format, e.g. by asserting on lock
  keys directly.
- Resolving symlinked workspaces changes behavior of the existing symlink-escape
  tests in `tests/tools/tools.test.ts` (they must still reject escapes).

## Maintenance notes

- The lock key is now an absolute, workspace-anchored path. Any future tool that
  mutates files must keep passing its target through `resourceKey`; a tool that
  invents its own locking scheme will break the batch-level guarantee.
- `canonical()` still realpaths only existing paths (plus nearest ancestor for
  new files). If a tool is added that writes through symlinked directories, add a
  test alongside this one.
- Known, deferred: `RWLock.acquire` adds an `abort` listener that is never
  removed, so a batch of >10 file ops on one signal can emit
  `MaxListenersExceededWarning`. Not a regression from this plan.
