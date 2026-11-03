# Plan 006: Harden session durability (ids, retention, enabled, error reporting)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise.
>
> **Drift check (run first)**:
> `git diff --stat 37e692e..HEAD -- src/sessions/store.ts src/cli/main.ts tests/sessions`
> If any of those changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch, treat
> it as a STOP condition (the CLI region is also touched by plan 007).

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none (must land **before** plan 007)
- **Category**: tech-debt / correctness
- **Planned at**: commit `d2d4d2b`, 2026-11-03
- **Verified at**: commit `37e692e` (store excerpts unchanged; the `store`/`session` block of `src/cli/main.ts` is still at lines 65-71 — the TUI code around it changed, do not treat that as drift)

## Why this matters

Durable, resumable sessions are a headline feature ("append-only JSONL event
logs, resumable across CLI restarts"). Three gaps make the claim weaker than the
README:

1. **Session ids are joined into a file path unvalidated.** `--session ID` flows
   into `join(rootDir, \`${id}.jsonl\`)`, so `--session ../../x` reads and writes
   outside the sessions directory.
2. **`sessions.enabled` and `sessions.retentionDays` are configuration no-ops.**
   They are parsed and validated (`src/config/schema.ts:38-43`) but never read —
   sessions cannot be turned off, and the store grows forever.
3. **Persistence failures are swallowed.** `persist()` catches every error and
   does nothing, so a full disk or bad permissions silently degrade "durable" to
   "in-memory" with no signal to the user.

## Current state

- `src/sessions/store.ts` — `JsonlSession` (append-only writer) and
  `JsonlSessionStore` (create/resume/list).
- `src/sessions/store.ts:134-141` — silent failure:

```ts
  private persist(event: SessionEvent): void {
    try {
      ensureDir(join(this.filePath, ".."));
      ensureFile(this.filePath);
      appendFileSync(this.filePath, JSON.stringify(event) + "\n", "utf8");
    } catch {
      // Best effort.
    }
  }
```

- `src/sessions/store.ts:273-275` — unvalidated id:

```ts
  private sessionPath(id: string): string {
    return join(this.rootDir, `${id}.jsonl`);
  }
```

- `src/sessions/store.ts:277-297` — `create()` accepts `{ workspace, provider, id,
  filePath }`; `resumeSession(id)` (line 317) calls `sessionPath(id)`.
- `src/cli/main.ts:65-71` — the session/store construction this plan rewires:

```ts
  const store = new JsonlSessionStore();
  const session =
    sessionOverride
      ? store.resume(sessionOverride) ?? store.create(process.cwd(), provider.id)
      : positional.includes("__continue__")
        ? store.resumeLatest(process.cwd()) ?? store.create(process.cwd(), provider.id)
        : store.create(process.cwd(), provider.id);
```

- `src/config/schema.ts:38-43` — `SessionsConfigSchema` (`enabled`, `retentionDays`).

## Commands you will need

| Purpose   | Command             | Expected on success |
|-----------|---------------------|---------------------|
| Install   | `npm install`       | exit 0              |
| Typecheck | `npm run typecheck` | exit 0              |
| Tests     | `npm test`          | exit 0, all pass    |

## Scope

**In scope**:
- `src/sessions/store.ts`
- `src/cli/main.ts` (only the session/store construction block, lines ~65-71, and
  the imports it needs)
- `tests/sessions/store.test.ts` (create)

**Out of scope**:
- Recording `context_compacted` / `model_switched` events into the session log —
  that lands with the CLI restructure in plan 007.
- Session encryption, compression, export commands, and the `/clear` semantics
  change (plan 007).
- Any change to the event schema in `src/sessions/events.ts`.

## Git workflow

- Branch: `advisor/006-session-durability-hardening`
- Commit subject: `fix: harden session ids, retention, and persist errors`
- Do NOT push or open a PR.

## Steps

### Step 1: Reject unsafe session ids

In `src/sessions/store.ts`, add near `sanitizeWorkspace`:

```ts
const SAFE_SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;

function assertSafeSessionId(id: string): void {
  if (!SAFE_SESSION_ID.test(id) || id === "." || id === "..") {
    throw new Error("INVALID_SESSION_ID");
  }
}
```

Call it at the top of `private sessionPath(id: string)`. Both `create()` (when an
explicit `id` is supplied) and `resumeSession()` route through `sessionPath`, so
one guard covers both. Do not change the UUID default path in `create()`.

**Verify**: `npm run typecheck` → exit 0.

### Step 2: Add error reporting to the writer

In `JsonlSessionOptions` add:

```ts
  onPersistError?: (error: unknown) => void;
```

In `JsonlSession` add a public counter and a private flag:

```ts
  persistErrorCount = 0;
  private persistErrorReported = false;
```

Change `persist()` to:

```ts
  private persist(event: SessionEvent): void {
    try {
      ensureDir(join(this.filePath, ".."));
      ensureFile(this.filePath);
      appendFileSync(this.filePath, JSON.stringify(event) + "\n", "utf8");
    } catch (err) {
      this.persistErrorCount++;
      if (!this.persistErrorReported) {
        this.persistErrorReported = true;
        try {
          this.onPersistError?.(err);
        } catch {
          // Never let the reporter break a turn.
        }
      }
    }
  }
```

Store the callback in the constructor (`this.onPersistError = options.onPersistError;`
with a field `private onPersistError?: (error: unknown) => void;`).

Thread it from the store: add `onPersistError?: (error: unknown) => void;` to
`JsonlSessionStoreOptions`, keep it as `private onPersistError`, and pass
`onPersistError: this.onPersistError` in both `create()` and `resumeSession()`.
When `create()` receives an options object, prefer `opts.onPersistError` if given.

**Verify**: `npm run typecheck` → exit 0.

### Step 3: Implement retention pruning

Add `retentionDays?: number | null;` to `JsonlSessionStoreOptions`, store it, and
prune once per store instance at the start of `create()`:

```ts
  private pruned = false;

  private pruneOldSessions(days: number): void {
    if (this.pruned) return;
    this.pruned = true;
    if (!Number.isFinite(days) || days <= 0) return;
    const cutoff = Date.now() - days * 86_400_000;
    let files: string[] = [];
    try {
      files = readdirSync(this.rootDir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      return;
    }
    for (const f of files) {
      const p = join(this.rootDir, f);
      try {
        if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
      } catch {
        // Ignore individual files we cannot stat or remove.
      }
    }
  }
```

Call `this.pruneOldSessions(this.retentionDays ?? 0);` as the first statement of
`create(...args)`. Add `unlinkSync` to the existing `node:fs` import. Pruning is
deliberately keyed on file mtime (cheap, no JSONL parse); document that in a
one-line comment.

**Verify**: `npm run typecheck` → exit 0.

### Step 4: Wire `sessions.enabled` and retention in the CLI

In `src/cli/main.ts`, import `randomUUID` from `node:crypto` and
`InMemorySession` from `../sessions/store.js`, then replace the block at lines
~65-71 with:

```ts
  const store = config.sessions.enabled
    ? new JsonlSessionStore({
        retentionDays: config.sessions.retentionDays,
        onPersistError: () =>
          process.stderr.write(
            "atom-lite: warning: session could not be persisted; continuing in memory\n",
          ),
      })
    : undefined;
  const session = !store
    ? new InMemorySession(randomUUID(), process.cwd(), provider.id)
    : sessionOverride
      ? store.resume(sessionOverride) ?? store.create(process.cwd(), provider.id)
      : positional.includes("__continue__")
        ? store.resumeLatest(process.cwd()) ?? store.create(process.cwd(), provider.id)
        : store.create(process.cwd(), provider.id);
```

`InMemorySession` satisfies the `runAgentTurn` session parameter
(`{ messages, appendMessage }`). Do not change anything else in this file — plan
007 restructures the surrounding TUI code and will preserve this block.

**Verify**: `npm run typecheck` → exit 0.

### Step 5: Tests

Create `tests/sessions/store.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, writeFileSync as write, existsSync, readdirSync, chmodSync } from "node:fs";
import { utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlSessionStore } from "../../dist/sessions/store.js";
```

(Clean up imports to only what you use.)

1. `rejects unsafe session ids`
   ```ts
   const root = mkdtempSync(join(tmpdir(), "sess-"));
   const store = new JsonlSessionStore({ rootDir: root });
   assert.throws(() => store.resume("../../escape"), /INVALID_SESSION_ID/);
   assert.throws(() => store.create({ workspace: root, id: "../evil" }), /INVALID_SESSION_ID/);
   ```
2. `prunes sessions older than retention`
   - create the root dir; write `join(root, "old.jsonl")` with a valid
     `session_started` line; `utimesSync(path, old, old)` where `old = new Date(Date.now() - 90*86400000)`;
   - `const store = new JsonlSessionStore({ rootDir: root, retentionDays: 30 });`
   - `store.create({ workspace: root, id: "fresh" });`
   - assert `!existsSync(join(root, "old.jsonl"))` and `existsSync(join(root, "fresh.jsonl"))`
3. `reports persist failure once`
   - `const root = mkdtempSync(...)`; `const blocker = join(root, "blocker")`; `writeFileSync(blocker, "x")` (a file, so it cannot be a directory);
   - `let reports = 0;`
   - `const store = new JsonlSessionStore({ rootDir: root, onPersistError: () => { reports++; } });`
   - `const s = store.create({ workspace: root, id: "broken", filePath: join(blocker, "s.jsonl") });`
   - `s.appendMessage({ role: "user", content: [{ type: "text", text: "a" }] });`
   - `s.appendMessage({ role: "user", content: [{ type: "text", text: "b" }] });`
   - assert `reports === 1` and `s.persistErrorCount === 2`
   (The invalid `filePath` under a regular file makes `mkdirSync` fail with
   `ENOTDIR`, which is deterministic even when tests run as root.)

**Verify**: `npm test` → exit 0, three new tests pass.

## Test plan

- New file `tests/sessions/store.test.ts` with the three tests above.
- Regression intent: test 1 fails pre-fix (path traversal allowed), test 2 fails
  pre-fix (retention option ignored, old file survives), test 3 fails pre-fix (no
  callback exists).
- Pattern: `tests/config/load.test.ts` (temp dirs, direct construction, no
  mocks).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0, including the three new session tests
- [ ] `grep -n "INVALID_SESSION_ID" src/sessions/store.ts` matches
- [ ] `grep -n "sessions.enabled" src/cli/main.ts` matches
- [ ] `grep -rn "retentionDays" src/sessions/store.ts` matches
- [ ] `git status` shows only the three in-scope files
- [ ] `plans/README.md` status row for 006 updated

## STOP conditions

Stop and report back if:

- The `create()`/`resumeSession()` shapes no longer accept an options object (the
  plan's plumbing assumes they do).
- `InMemorySession` has gained required members that `runAgentTurn` does not
  provide (check `src/agent/loop.ts`'s session parameter).
- A test cannot force a persist failure on the platform (e.g. `ENOTDIR` behaves
  differently on Windows) — report the platform issue rather than weakening the
  assertion to "does not throw".

## Maintenance notes

- Pruning runs at most once per process, at first `create()`. Long-running
  sessions never delete the session they themselves are appending to; that is
  intentional.
- Any new session-writing path must go through `JsonlSession.persist` so the
  error counter and one-shot report stay accurate.
- Plan 007 will restructure the surrounding CLI and add `model_switched` /
  `context_compacted` recording. Preserve the `store` block verbatim so the two
  plans do not fight.
