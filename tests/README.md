# Tests

How Atom-lite's test suite is organized, and the rules for keeping it
production-grade without growing it blindly.

## Layers

| Layer           | Where                             | What belongs here                                                                                                                                                                                           | Speed budget   |
| --------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| **Unit**        | `tests/<domain>/<module>.test.ts` | One module's observable behavior in isolation. Fake processes/network, real filesystem in `tmpdir()`.                                                                                                       | < 2s per file  |
| **Integration** | same layout as unit               | Several real modules collaborating (tool → executor → locks; bash → BackgroundTaskManager → task tool). Still no network beyond `127.0.0.1`.                                                                | < 5s per file  |
| **E2E**         | `tests/e2e/`                      | Spawn `dist/cli/main.js` as a subprocess with an isolated `HOME`/`XDG_CONFIG_HOME`/`PI_CODING_AGENT_DIR`. Proves a full feature flow: args → config → provider → agent loop → tools → session log → output. | < 30s per file |

One suite runs all of it: `npm test` (= build + `node --test`). There is no
opt-in layer; a test that can't run in CI is a test that doesn't exist. The
single exception is `tests/mcp/stdio-smoke.test.ts`, which self-skips unless
`ATOM_LITE_MCP_SMOKE=1` because it shells out to a fixture server with
platform-specific behavior.

## Conventions

- Import compiled modules from `../../dist/...`. `npm test` rebuilds first, so
  tests can never drift from src.
- Tests are TypeScript run directly by Node's type-stripping test runner
  (Node >= 22.19). No test framework beyond `node:test` + `node:assert/strict`.
- Every test creates its own `mkdtempSync(tmpdir())` workspace; never touch the
  repo or the user's real `~/.config`.
- E2E tests isolate all environment paths (see `tests/e2e/cli-basics.test.ts`)
  so a developer's real config is never read.
- Local HTTP stubs (`node:http`) stand in for providers and web content. The
  stub server must live in the _parent_ process with an async child spawn —
  `execFileSync` blocks the event loop and deadlocks the stub (see
  `tests/e2e/tool-loop-flow.test.ts` for the working pattern).
- Determinism: no sleeps for synchronization where a promise/exit event can be
  awaited; generous timeouts with `Promise.race` where a process must die.

## What NOT to add

Do not add a test when the reason is one of these — fix the design instead:

1. **Mirror of types.** If it only re-asserts what TypeScript enforces, delete it.
2. **Snapshot of internals.** Asserting private structure breaks on every
   refactor and catches nothing real.
3. **Coverage-driven tests.** A line covered by a meaningless assertion is
   worse than an uncovered line: it lies about safety.
4. **Duplicate safety.** If an integration test already proves the flow, a
   unit test of the same branch adds maintenance, not confidence.

## What a new test MUST have

A reason written in the test header comment: which bug it pins (regression),
which contract it holds (spec), or which flow it verifies (E2E). If you cannot
name the failure the test prevents, the test should not exist.

## Changing behavior

When you fix a bug: add the regression test first or together with the fix,
and reference the symptom in the test name. When you change a tool's output
format or a session event shape, update the tests that pin that contract in
the same commit — the suite must never be red on master.

## Maintenance loop (per iteration)

1. `npm run typecheck && npm test` — must be green.
2. `npx prettier --check .` — formatting is part of CI.
3. Skim for tests that now test dead code (module deleted → delete its tests,
   not leave them skipping).
4. Run `node --test --test-reporter=tap` and check for skipped tests: each
   permanent skip needs an inline justification.

## Known gaps (deliberate, revisit when touched)

- `cli/app.ts` interactive TUI paths: covered indirectly through command-level
  tests (`tests/cli/*`) and E2E; the 3000-line TUI is not unit-tested and
  should not be — it is the least stable surface and its logic lives in the
  modules it calls.
- Pi extension runtime (`extensions/ui.ts` widget plumbing) — covered via
  loader tests; no widget rendering assertions yet.
- Real-model evals live in `evals/` and `npm run eval`, deliberately outside
  the deterministic suite.
