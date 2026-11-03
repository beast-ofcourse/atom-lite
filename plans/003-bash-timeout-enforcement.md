# Plan 003: Enforce bash timeouts and cancellation with process-group kill

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise.
>
> **Drift check (run first)**:
> `git diff --stat d2d4d2b..HEAD -- src/tools/bash.ts tests/tools/tools.test.ts`
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

`bash` is the agent's only way to run tests, builds, and git. Its timeout is
enforced by sending `SIGTERM` to the direct child and resolving the tool promise
on the child's `close` event. Two things break that:

1. A process that ignores `SIGTERM` (common: shells with `trap`, some test
   runners, `git` waiting on a lock) never exits, so `close` never fires and the
   tool promise never settles — the agent turn hangs indefinitely even though
   `timed_out` was intended to fire.
2. Descendants are not killed. `spawn` without `detached` puts the child in the
   caller's process group, and only `child.kill()` (the leader) is signalled, so
   a grandchild holding the stdout/stderr pipe keeps the streams open.

Either way, `runtime.maxBashTimeMs` stops being a budget and the whole session
stalls. Killing the process group and escalating to `SIGKILL` after a grace
period makes the documented timeout real.

## Current state

- `src/tools/bash.ts` — spawns `${shell} -c <command>` (or `/c` on Windows),
  captures stdout/stderr with byte caps, applies approval checks, and resolves a
  single `ToolResult`.
- Relevant block, `src/tools/bash.ts:75-140` (abridged):

```ts
      const child = spawn(shell, [flag, command], {
        cwd: workdir,
        env: process.env,
      });
      // …stdout/stderr append helpers…
      let timedOut = false;
      let killedByAbort = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeout);
      const onAbort = () => {
        killedByAbort = true;
        child.kill("SIGTERM");
      };
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      child.on("error", (err) => { /* resolve COMMAND_FAILED */ });
      child.on("close", (code, signal) => { /* build parts, resolve */ });
```

Conventions: `UPPER_SNAKE` error codes, `content` is a newline-joined report
(`exit_code:`, `signal:`, `timed_out:`, `cancelled:`, `duration_ms:`), and the
tool never throws — it resolves `{ toolCallId, name, content, isError? }`.

## Commands you will need

| Purpose   | Command             | Expected on success |
|-----------|---------------------|---------------------|
| Install   | `npm install`       | exit 0              |
| Typecheck | `npm run typecheck` | exit 0              |
| Tests     | `npm test`          | exit 0, all pass    |

## Scope

**In scope**:
- `src/tools/bash.ts`
- `tests/tools/tools.test.ts`

**Out of scope**:
- Environment scrubbing (`env: process.env` passthrough is deliberate and
  documented), `cwd` validation, output byte-capping, and approval flow.
- `maxBashTimeMs` wiring from config — that is a separate finding (the CLI never
  passes `limits`; do not fix it here).
- Windows-specific process-tree termination beyond `child.kill()`.

## Git workflow

- Branch: `advisor/003-bash-timeout-enforcement`
- Commit subject: `fix: enforce bash timeout with process-group kill`
- Do NOT push or open a PR.

## Steps

### Step 1: Spawn detached on POSIX and add a kill helper

Change the `spawn` options to:

```ts
      const child = spawn(shell, [flag, command], {
        cwd: workdir,
        env: process.env,
        detached: process.platform !== "win32",
      });
```

Add, immediately after `const child = spawn(...)`, a helper plus a single
settle guard:

```ts
      const GRACE_MS = 2000;
      let settled = false;
      let escalation: NodeJS.Timeout | undefined;

      const killTree = (sig: NodeJS.Signals): void => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        try {
          if (process.platform !== "win32" && typeof child.pid === "number") {
            process.kill(-child.pid, sig);
          } else {
            child.kill(sig);
          }
        } catch {
          // Process (or group) already gone.
        }
      };

      const terminate = (): void => {
        killTree("SIGTERM");
        if (!escalation) {
          escalation = setTimeout(() => killTree("SIGKILL"), GRACE_MS);
        }
      };
```

`detached: true` on POSIX makes the child a process-group leader, so
`process.kill(-pid, …)` reaches grandchildren. On Windows, `detached` has
different semantics; keep the plain `child.kill()` path there.

**Verify**: `npm run typecheck` → exit 0.

### Step 2: Use the helper in the timer and abort paths

Replace the timer body with:

```ts
      const timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeout);
```

and the abort handler with:

```ts
      const onAbort = () => {
        killedByAbort = true;
        terminate();
      };
```

**Verify**: `npm run typecheck` → exit 0.

### Step 3: Make settlement single-shot and clean up both timers

Both `child.on("error")` and `child.on("close")` currently resolve the promise.
Guard them so the promise settles once, both timers are cleared, and the abort
listener is removed on every path. Add near the top of the promise body:

```ts
      const finish = (result: ToolResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (escalation) clearTimeout(escalation);
        ctx.signal.removeEventListener("abort", onAbort);
        resolvePromise(result);
      };
```

Then replace `resolvePromise({...})` in the `error` and `close` handlers with
`finish({...})`, and replace their existing `clearTimeout(timer)` /
`removeEventListener` lines (the `finish` helper does both). Keep the existing
`parts` construction and the `failed` computation:

```ts
        const failed = code !== 0 || timedOut || killedByAbort;
        finish({ toolCallId: call.id, name: "bash", content: parts.join("\n"), isError: failed });
```

Note ordering: `finish` is referenced by handlers defined later in the same
closure, which is fine; but the `let timer` declaration must come before
`finish` uses it, or `finish` must be declared after `timer`. Declare
`killTree`/`terminate` first, then `timer`, then `finish` — or hoist `timer` with
`let timer: NodeJS.Timeout;`. Keep the file compiling.

**Verify**: `npm run typecheck` → exit 0.

### Step 4: Add the hanging-process regression test

Append to `tests/tools/tools.test.ts`. The test must fail (by racing out) on the
pre-fix code instead of hanging the whole suite:

```ts
test("bash timeout kills a SIGTERM-ignoring process group", async () => {
  if (process.platform === "win32") return;
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const started = Date.now();
  const result = await Promise.race([
    bashTool.execute(
      {
        id: "t1",
        name: "bash",
        arguments: { command: "trap '' TERM; sleep 5", timeout_ms: 200 },
      },
      {
        workspace: dir,
        signal: new AbortController().signal,
        maxBashTimeMs: 5000,
        maxToolOutputBytes: 30000,
      },
    ),
    new Promise<null>((res) => setTimeout(() => res(null), 4000)),
  ]);
  assert.ok(result, "bash tool did not settle within 4s");
  assert.match(result!.content, /timed_out: true/);
  assert.ok(Date.now() - started < 4000);
});
```

Timing margins: the tool sends `SIGTERM` at 200 ms (ignored), escalates to
`SIGKILL` at ~2.2 s, and settles before the 4 s race; pre-fix it settles at ~5 s,
so the race wins and the assertion fails.

Add a second test for cancellation:

```ts
test("bash cancellation terminates a running command", async () => {
  if (process.platform === "win32") return;
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  const controller = new AbortController();
  const started = Date.now();
  const pending = bashTool.execute(
    {
      id: "t2",
      name: "bash",
      arguments: { command: "trap '' TERM; sleep 5", timeout_ms: 5000 },
    },
    { workspace: dir, signal: controller.signal, maxBashTimeMs: 5000, maxToolOutputBytes: 30000 },
  );
  setTimeout(() => controller.abort(), 100);
  const result = await Promise.race([
    pending,
    new Promise<null>((res) => setTimeout(() => res(null), 4000)),
  ]);
  assert.ok(result, "cancelled bash tool did not settle within 4s");
  assert.match(result!.content, /cancelled: true/);
  assert.ok(Date.now() - started < 4000);
});
```

**Verify**: `npm test` → exit 0, both new tests pass in a few seconds each.

## Test plan

- `bash timeout kills a SIGTERM-ignoring process group` — proves escalation.
- `bash cancellation terminates a running command` — proves the abort path also
  escalates.
- Existing `bash runs command and returns output` must keep passing (exit_code 0,
  output captured), as must `tests/agent/integration.test.ts`'s cancellation test.
- Platform guard: both new tests early-return on `win32`, matching the existing
  symlink test's pattern.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0, including both new bash tests
- [ ] `grep -n 'process.kill(-child.pid' src/tools/bash.ts` matches
- [ ] `grep -n 'SIGKILL' src/tools/bash.ts` matches
- [ ] `git status` shows only the two in-scope files
- [ ] `plans/README.md` status row for 003 updated

## STOP conditions

Stop and report back if:

- The excerpted spawn block is not present (code drifted).
- `npm test` leaves stray `sleep` processes or the suite takes >30 s — report the
  timing rather than raising the test timeouts to hide it.
- `detached: true` causes an existing test to fail (e.g. output capture stops
  working) — report before trying alternative killing strategies.

## Maintenance notes

- Any future change to spawn options must keep the child in its own process
  group on POSIX, otherwise `process.kill(-pid, …)` throws `ESRCH` and escalation
  silently degrades to nothing.
- `GRACE_MS = 2000` is a deliberate constant: long enough for a cooperative
  process to flush, short enough to stay inside typical turn budgets. If it is
  exposed via config later, keep the 2 s default.
- Deferred: killing the group on process exit (SIGINT to the CLI), streaming
  output incrementally to the TUI, and byte-accurate truncation (current caps
  count UTF-16 characters, not bytes).
