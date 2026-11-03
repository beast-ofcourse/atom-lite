# Plan 004: Derive the context budget from provider model info

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise.
>
> **Drift check (run first)**:
> `git diff --stat d2d4d2b..HEAD -- src/context/manager.ts tests/context/manager.test.ts`
> If `manager.ts` changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch, treat
> it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW-MED
- **Depends on**: none
- **Category**: bug / perf
- **Planned at**: commit `d2d4d2b`, 2026-11-03

## Why this matters

The context manager exists to keep requests inside the model's window and to
compact history *before* the limit is hit. Today the budget is a hardcoded
128 000 tokens (`DEFAULT_MAX_INPUT`). The adapter interface already exposes
`getModelInfo(): Promise<ModelInfo | undefined>` with a `contextWindow` field,
and `OllamaAdapter` implements it against `/api/show` — but nothing ever calls
it (verified: the only references outside `ollama.ts` are the interface
declaration and exports).

Atom-lite is positioned as local-first, where 8k-32k context windows are normal.
With a 8k local model the manager will happily assemble a 100k-token request
until the provider rejects it or truncates the response, and compaction never
triggers. Deriving the budget makes the documented behavior ("determine the
available context budget from provider/model metadata when known") true and is
the prerequisite for the model-support warning work.

## Current state

- `src/context/manager.ts` — builds model input: system prompt + skill index +
  project instructions + history, estimates tokens, compacts when over
  threshold.

```ts
const DEFAULT_MAX_INPUT = 128000;

export class ContextManager {
  private opts: ContextManagerOptions;

  constructor(opts: ContextManagerOptions) { this.opts = opts; }

  private budget(): number {
    const max = this.opts.maxInputTokens ?? DEFAULT_MAX_INPUT;
    return Math.max(1000, max - this.opts.reserveOutputTokens);
  }

  private threshold(): number {
    return Math.floor(this.budget() * (this.opts.compactAtPercent / 100));
  }

  async build(workspace: string, history: Message[]): Promise<Message[]> {
    // …load instructions, skill index, prepend system messages, push history…
    const total = messages.reduce((s, m) => s + estimateMessageTokens(m), 0);
    if (total <= this.threshold()) return messages;
    // …summarize older history via this.opts.provider.generate(summaryReq)…
```

- `src/providers/types.ts:11-17` — `ProviderAdapter` with optional
  `getModelInfo?()`.
- `src/providers/ollama.ts` — implements `getModelInfo()` (network call to
  `/api/show`, caches `contextWindow` on the adapter). `OpenAICompatibleAdapter`
  and `GeminiAdapter` do **not** implement it; they must keep the default.
- `src/config/schema.ts` — `context.maxInputTokens` (`number | null`,
  default `null`) is the explicit override.
- `src/context/budget.ts` — `estimateMessageTokens` (JSON length / 4).

## Commands you will need

| Purpose   | Command                                  | Expected on success |
|-----------|------------------------------------------|---------------------|
| Install   | `npm install`                            | exit 0              |
| Typecheck | `npm run typecheck`                      | exit 0              |
| Tests     | `npm test`                               | exit 0, all pass    |
| One test  | `npm test 2>&1 \| grep -A2 "context"`    | new tests listed    |

`npm test` builds first; tests import from `dist/`.

## Scope

**In scope**:
- `src/context/manager.ts`
- `tests/context/manager.test.ts` (create)

**Out of scope**:
- `src/providers/*` — no adapter changes. `getModelInfo` already exists and is
  optional; do not add it to the OpenAI-compatible or Gemini adapters here.
- Wiring `ContextManager`'s model/provider after a `/model` switch (separate
  finding), and CLI display of the discovered window.
- Compaction strategy changes (what to keep/summarize), and the unused
  `src/context/compaction.ts` placeholder — plan 005 owns that area's edits.

## Git workflow

- Branch: `advisor/004-context-budget-from-model-info`
- Commit subject: `fix: derive context budget from provider model info`
- Do NOT push or open a PR.

## Steps

### Step 1: Add a cached budget resolution

In `src/context/manager.ts`:

1. Keep `const DEFAULT_MAX_INPUT = 128000;` as the fallback constant.
2. Replace `private budget()` / `private threshold()` with:

```ts
  private budgetPromise: Promise<number> | undefined;

  private resolveBudget(): Promise<number> {
    if (this.opts.maxInputTokens !== null) {
      return Promise.resolve(
        Math.max(1000, this.opts.maxInputTokens - this.opts.reserveOutputTokens),
      );
    }
    this.budgetPromise ??= this.discoverBudget();
    return this.budgetPromise;
  }

  private async discoverBudget(): Promise<number> {
    let window = DEFAULT_MAX_INPUT;
    const getInfo = this.opts.provider.getModelInfo;
    if (typeof getInfo === "function") {
      try {
        const info = await getInfo.call(this.opts.provider);
        const cw = info?.contextWindow;
        if (typeof cw === "number" && Number.isFinite(cw) && cw > 0) window = cw;
      } catch {
        // Discovery is best-effort; keep the conservative default.
      }
    }
    return Math.max(1000, window - this.opts.reserveOutputTokens);
  }

  private thresholdFor(budget: number): number {
    return Math.floor(budget * (this.opts.compactAtPercent / 100));
  }
```

Notes:

- Config override wins and is **not** re-discovered — same precedence the file
  documents today (`maxInputTokens` is treated as the total window; subtracting
  the output reserve keeps existing semantics).
- The promise cache means `getModelInfo()` (a network call for Ollama) runs at
  most once per `ContextManager` instance, and a failure is not retried in a
  tight loop.

**Verify**: `npm run typecheck` → exit 0.

### Step 2: Use it in `build()`

At the top of the `build()` body (before the history/token computation), add:

```ts
    const budget = await this.resolveBudget();
```

and change the threshold check to:

```ts
    if (total <= this.thresholdFor(budget)) return messages;
```

Leave the rest of `build()` untouched (summary request, fallback text, compacted
message array). Do not change `reserveOutputTokens` defaults.

**Verify**: `npm run typecheck` → exit 0.

### Step 3: Write the context budget tests

Create `tests/context/manager.test.ts`. Tests import compiled output, matching
the other test files (`../../dist/...`). Use a local stub provider — do not add
fixtures to `src/`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextManager } from "../../dist/context/manager.js";

class StubProvider {
  id = "stub";
  generateCalls = 0;
  infoCalls = 0;
  constructor(private window?: number) {}

  async getModelInfo() {
    this.infoCalls++;
    return this.window === undefined ? undefined : { id: "stub", contextWindow: this.window };
  }

  async generate() {
    this.generateCalls++;
    return {
      message: { role: "assistant", content: [{ type: "text", text: "SUMMARY" }] },
      toolCalls: [],
      finishReason: "stop",
    };
  }
}

function manager(provider: any, opts: Partial<{ maxInputTokens: number; reserveOutputTokens: number; compactAtPercent: number }> = {}) {
  return new ContextManager({
    systemPrompt: "sys",
    maxInputTokens: opts.maxInputTokens ?? null,
    reserveOutputTokens: opts.reserveOutputTokens ?? 1024,
    compactAtPercent: opts.compactAtPercent ?? 85,
    maxProjectInstructionBytes: 30000,
    provider: provider as any,
    model: "stub",
  });
}

function bigHistory(messages: number): any[] {
  return Array.from({ length: messages }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: [{ type: "text" as const, text: "x".repeat(2000) }],
  }));
}
```

Three tests:

1. `compacts when history exceeds a discovered small window`
   - `const p = new StubProvider(8000);`
   - `const out = await manager(p).build(dir, bigHistory(40));`
   - assert `p.generateCalls === 1` (a summary was requested)
   - assert `out[0].role === "system"`
   - assert some message matches `/Context summary: SUMMARY/`
2. `keeps history when it fits the window`
   - `const p = new StubProvider(128000);`
   - `const out = await manager(p).build(dir, bigHistory(2));`
   - assert `p.generateCalls === 0` and `out.length === 2 + history length`
     (system + instructions + history; a temp workspace has no `AGENTS.md`, and
     the skill index may add one line to the system message, not extra messages)
3. `model info is fetched once and failures fall back`
   - `const p = new StubProvider(8000);` call `build()` twice;
     assert `p.infoCalls === 1`.
   - `const q = new StubProvider(undefined);` build with `bigHistory(2)`, assert
     no throw and `q.generateCalls === 0`.

Use `const dir = mkdtempSync(join(tmpdir(), "ctx-"));` per test. Note the real
`~/.agents/skills` directory is scanned by the skill index (plan 005), so never
assert on total message count beyond system+history; assert on roles/content.

**Verify**: `npm test` → exit 0, three new tests listed and passing.

## Test plan

- New file `tests/context/manager.test.ts` with the three tests above.
- Structural pattern: `tests/config/load.test.ts` (plain constructors, temp
  dirs, no mocking framework).
- Regression intent: pre-fix, test 1 must fail because the 8000-token window is
  ignored and the 40×2000-char history (~20k tokens) is still under the 128k
  default threshold, so no summary is requested.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0, including the three new context tests
- [ ] `grep -n "getModelInfo" src/context/manager.ts` matches
- [ ] `grep -n "DEFAULT_MAX_INPUT" src/context/manager.ts` still matches (fallback preserved)
- [ ] `git status` shows only `src/context/manager.ts` and the new test file
- [ ] `plans/README.md` status row for 004 updated

## STOP conditions

Stop and report back if:

- `ProviderAdapter` in `src/providers/types.ts` no longer declares
  `getModelInfo?`.
- `ContextManagerOptions.maxInputTokens` is no longer `number | null` (the
  null-means-discover semantics depend on it).
- Existing tests in `tests/agent/*` fail because compaction now fires in the
  FakeProvider path — report; do not raise the fake window to silence it.

## Maintenance notes

- `/model` switching does not update the `ContextManager`'s provider today, so
  the discovered window is that of the provider the manager was constructed
  with. If model switching is fixed later, clear `budgetPromise` when the
  provider changes.
- `maxInputTokens` is semantically "total window" although it is named as an
  input cap. Renaming is deliberately deferred; keep the subtraction behavior
  consistent until a config migration is planned.
- A reviewer should confirm: no adapter changes, config override still wins, and
  the discovery call is cached (otherwise every turn adds a network round trip
  against Ollama).
