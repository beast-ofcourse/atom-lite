# Plan 001: `edit` inserts replacement text literally (no `$` expansion)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise.
>
> **Drift check (run first)**:
> `git diff --stat d2d4d2b..HEAD -- src/tools/edit.ts tests/tools/tools.test.ts`
> If either file changed since this plan was written, compare the "Current
> state" excerpt against the live code before proceeding; on a mismatch, treat
> it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `d2d4d2b`, 2026-11-03

## Why this matters

`edit` is one of the four core tools every agent turn relies on. It applies
replacements with `String.prototype.replace(string, string)`, which interprets
`$&`, `$'`, `` $` ``, `$$`, and `$1` inside the replacement string. When the
model is editing a file that contains regex code, `String.replace` templates, or
shell/sed examples, those sequences are silently rewritten, and the tool still
returns success (`Edited <path> (sha256:…)`) — so the model believes a correct
edit landed and moves on. Fixing this makes the tool's output equal to its
intent: the replacement text goes in exactly as written.

Verified today: `"aXb".replace("X", "$&$&")` returns `"aXXb"`, and
`"x".replace("x", "$\`y")` returns `"y"`.

## Current state

- `src/tools/edit.ts` — the `edit` tool: zod-validated args, hash guard, exact
  single-match replace, atomic write via temp file + `renameSync`.
- `tests/tools/tools.test.ts` — existing tool tests; `edit` is covered at
  "edit exact match and ambiguous handling" and "edit not found".

The buggy lines, `src/tools/edit.ts:85-108`:

```ts
    const text = buf.toString("utf8");
    let count = 0;
    let idx = text.indexOf(old_string);
    while (idx !== -1) {
      count++;
      idx = text.indexOf(old_string, idx + old_string.length);
    }
    // …EDIT_NOT_FOUND / EDIT_AMBIGUOUS_MATCH returns…
    const newText = text.replace(old_string, new_string);
```

Conventions to match (see `src/tools/write.ts` as the exemplar): every tool
starts with a `z.object({...}).strict()` schema, returns
`{ toolCallId, name, content, isError? }`, uses `UPPER_SNAKE` error codes in
`content`, and writes atomically with a `full + ".tmp-" + process.pid` temp file
plus `renameSync`. Do not change any of that.

## Commands you will need

| Purpose   | Command              | Expected on success   |
|-----------|----------------------|-----------------------|
| Install   | `npm install`        | exit 0                |
| Typecheck | `npm run typecheck`  | exit 0, no errors     |
| Tests     | `npm test`           | exit 0, all pass      |

`npm test` runs `npm run build && node --test`; the tests import compiled output
from `dist/`, so they cannot pass without a successful build.

## Scope

**In scope** (the only files you may modify):
- `src/tools/edit.ts`
- `tests/tools/tools.test.ts`

**Out of scope** (do NOT touch, even though they look related):
- `src/tools/write.ts`, `src/tools/read.ts`, `src/tools/bash.ts` — other tools.
- Extracting the duplicated `sha256` helper or the atomic-write block into a
  shared module. That refactor is a separate decision; keep this change surgical.
- `src/runtime/locks.ts` / `src/runtime/scheduler.ts` — lock-key resolution is
  plan 002 and would conflict.

## Git workflow

- Branch: `advisor/001-edit-literal-replacement`
- Commits: one commit is enough. The repo uses conventional-commit subjects,
  e.g. `fix: /skill invocation + skill_loaded tracing` — use
  `fix: insert edit replacement text literally`.
- Do NOT push or open a PR.

## Steps

### Step 1: Replace the counting loop with an index-based splice

Replace the whole block from `const text = buf.toString("utf8");` through
`const newText = text.replace(old_string, new_string);` with:

```ts
    const text = buf.toString("utf8");
    const firstIndex = text.indexOf(old_string);
    if (firstIndex === -1) {
      return {
        toolCallId: call.id,
        name: "edit",
        content: "EDIT_NOT_FOUND",
        isError: true,
      };
    }
    let count = 0;
    let scan: number = firstIndex;
    while (scan !== -1) {
      count++;
      scan = text.indexOf(old_string, scan + old_string.length);
    }
    if (count > 1) {
      return {
        toolCallId: call.id,
        name: "edit",
        content: "EDIT_AMBIGUOUS_MATCH",
        isError: true,
      };
    }
    const newText =
      text.slice(0, firstIndex) +
      new_string +
      text.slice(firstIndex + old_string.length);
```

Delete the now-unreachable `if (count === 0)` and `if (count > 1)` blocks that
followed the old loop — the new code returns the same codes from the same
conditions, so behavior for missing/ambiguous strings is unchanged.

**Verify**: `npm run typecheck` → exit 0.

### Step 2: Add the regression test

Append to `tests/tools/tools.test.ts` (keep the file's existing style: `ctx(dir)`
helper, `node:test`, `node:assert/strict`):

```ts
test("edit inserts replacement text literally (no $ expansion)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  writeFileSync(join(dir, "s.txt"), "price 10\n");
  const replacement = "price $1 $$ $& $` $'";
  const r = await editTool.execute(
    {
      id: "1",
      name: "edit",
      arguments: { path: "s.txt", old_string: "10", new_string: replacement },
    },
    ctx(dir),
  );
  assert.ok(!r.isError);
  assert.equal(readFileSync(join(dir, "s.txt"), "utf8"), replacement + "\n");
});
```

`readFileSync` is already imported at the top of that test file; confirm before
adding an import.

**Verify**: `npm test` → exit 0; the output lists the new test and 0 failures.

### Step 3 (optional, only if Step 2 was already covered): re-run the suite

**Verify**: `npm test` → exit 0, 18 tests pass.

## Test plan

- New test: `edit inserts replacement text literally (no $ expansion)` in
  `tests/tools/tools.test.ts`, covering `$1`, `$$`, `$&`, `` $` ``, `$'` in one
  replacement. It must fail on the pre-fix code (the file would contain the
  expanded match/prefix/suffix instead of the literal text).
- Existing tests must keep passing: `edit exact match and ambiguous handling`
  (ambiguous still rejected), `edit not found` (`EDIT_NOT_FOUND` preserved),
  and the scheduler test `conflicting edits to same file serialize`.
- Pattern to follow: the existing `edit` tests in the same file.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0 with the new test passing
- [ ] `grep -n "text.replace(old_string" src/tools/edit.ts` returns no matches
- [ ] `git status` shows only `src/tools/edit.ts` and `tests/tools/tools.test.ts`
- [ ] `plans/README.md` status row for 001 updated

## STOP conditions

Stop and report back (do not improvise) if:

- `src/tools/edit.ts` no longer contains the excerpted block (code drifted).
- The file imports or uses a different replacement mechanism than
  `String.prototype.replace` (e.g. someone already fixed it).
- `npm test` fails in a test unrelated to `edit` — report the failure rather
  than "fixing" the other tool.

## Maintenance notes

- If `edit` later gains a `replace_all` option, keep the splice-based approach;
  never reintroduce `String.replace(string, string)` with model-provided text.
- A reviewer should confirm: ambiguous/missing behavior unchanged, the
  `expected_hash` check untouched, and the atomic temp-file + rename still used.
- Deferred deliberately: deduplicating the `sha256`/atomic-write helpers shared
  by `write` and `edit`, and preserving file mode on replace (out of scope here).
