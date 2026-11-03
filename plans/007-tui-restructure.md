# Plan 007: Restructure the TUI — one dispatch path, legible rendering, cancellable turns

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise.
>
> **Drift check (run first)**:
> `git diff --stat 37e692e..HEAD -- src/cli/main.ts src/cli/commands.ts src/cli/renderer.ts src/cli/approvals.ts src/context/manager.ts src/sessions/store.ts tests/cli`
> The excerpts below reflect commit `37e692e`, which includes the thinking
> display (`d46091d`), the `/model` model list (`12cbba4`) and reverse-video
> selection (`37e692e`). If plan 004/005 changed `src/context/manager.ts` or plan
> 006 changed `src/sessions/store.ts` / the session block of `main.ts`, that is
> **expected** — keep those changes and restructure around them. Any other
> mismatch is a STOP condition.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED
- **Depends on**: plans/005-cache-and-bound-skill-index.md (manager shape),
  plans/006-session-durability-hardening.md (session/store shape)
- **Category**: tech-debt / dx
- **Planned at**: commit `d2d4d2b`, 2026-11-03
- **Verified at**: commit `37e692e` (anchors below re-checked: `onSubmit` 345, approval handlers 225 and 574, `runtime["onEvent"]` 279, `dim` 174, 595 lines)

## Why this matters

`src/cli/main.ts` is 595 lines that parse args, build the runtime, own the TUI,
format every event inline, and implement eleven slash commands in one 230-line
`onSubmit` closure. Consequences the user feels today:

- **Output is a wall of text.** Every tool call prints `[tool] read {"path":"x"}`
  (raw JSON), every result prints only `  -> <first line>`, and long results,
  errors, and successes are indistinguishable. There is no way to see *what the
  agent is doing* without reading JSON fragments.
- **Turns are neither cancellable nor exclusive.** No SIGINT/Esc handling exists
  in the TUI path and each submit creates an `AbortController` that is never
  aborted. Pressing Enter during a running turn starts a second concurrent
  `runAgentTurn` on the same session, interleaving messages and JSONL events.
- **Duplicated, partially dead code.** `approvals.handler` is assigned three
  times (lines 225 and 574); `/skill` is implemented
  twice; `src/cli/commands.ts`, `src/cli/renderer.ts`, and `src/cli/approvals.ts`
  exist but are imported by nothing.

The goal is a small, legible surface: pure formatting functions that can be unit
tested, one command dispatcher that constructs no TUI state, and a thin `main.ts`
that wires them together. No new product features — everything the TUI shows
today must still be reachable (`/model`, `/effort`, `/skills`, `/skill`,
`/thinking`, approvals, token usage).

## Current state

- `src/cli/main.ts` (595 lines) — arg parsing → config/provider/tools/session →
  one-shot path → TUI setup → approvals → render helpers → `runtime["onEvent"]`
  → `runDoctor` → `input.onSubmit` (all slash commands) → duplicate approval
  handler → `tui.start()`.
- `src/cli/commands.ts` — placeholder: `SLASH_COMMANDS` array and a
  `handleSlashCommand` that is never imported and says model switching "is not
  implemented in this skeleton".
- `src/cli/renderer.ts` — placeholder: only `print(text)`.
- `src/cli/approvals.ts` — placeholder: `export {}`.
- `src/agent/types.ts` — `AgentEvent` union, including `thinking_delta`
  (added in `d2d4d2b`), `tool_call`, `tool_result`, `usage`, `final`,
  `model_switched`, `error`.
- `src/context/manager.ts` — compaction happens inside `build()` with no
  notification; the TUI cannot show that it happened.
- `src/sessions/store.ts` — `JsonlSession` has convenience recorders
  (`recordToolCallStarted`, `recordToolResult`, `recordCompaction`,
  `recordProviderError`) but no `model_switched` recorder.

Excerpts to confirm before editing (`src/cli/main.ts`):

```ts
// ~219-223 — TUI-only state living next to event handling
  let currentText: any = null;
  let currentBuffer = "";
  let thinkingText: any = null;
  let thinkingBuffer = "";
  let showThinking = true;

// 225-236 — approvals.handler assignment #1
  approvals.handler = interactive ? async (req: any) => { /* "box: approval" */ } : undefined;

// 279-320 — the event handler, including thinking rendering with build-inline
// ANSI strings such as:
      thinkingText.setText(`\\x1b[2mThinking...\\x1b[0m\\n${prefixed}`);

// 345 — input.onSubmit: every slash command inline
  input.onSubmit = async (value: string) => { … }

// 574 — approvals.handler assignment #3 (duplicate implementation)
```

Repo conventions: strict TypeScript, NodeNext ESM (`import … from "./x.js"`),
Prettier defaults (2 spaces, double quotes, semicolons), no lint beyond `tsc`.
TUI components come from `@earendil-works/pi-tui`; the approved set already in
use is `ProcessTerminal, TuiMainScreen, Text, Container, Spacer, ScrollView,
HStack, Editor, SelectList, CombinedAutocompleteProvider`. Read the package's
`.d.ts` files under `node_modules/@earendil-works/pi-tui/dist/` before using a
component you have not seen in this file.

**Confirmed defect to fix while refactoring**: the thinking renderer emits
doubled escapes. `sed -n '292p' src/cli/main.ts | od -c` shows the bytes
`\ \ x 1 b` (two backslashes), while the working `dim` helper at line 174 shows
a single `\ x 1 b`. In a template literal `\\x1b` becomes the literal text
`\x1b`, and `\\n` becomes the literal text `\n` — so the thinking block
currently prints raw escape sequences and does not wrap onto separate lines.
Re-emit both through single-escape helpers (`ESC = "\u001b"`, real `\n`) in
`renderer.ts`; do not copy the doubled form.

## Commands you will need

| Purpose     | Command              | Expected on success |
|-------------|----------------------|---------------------|
| Install     | `npm install`        | exit 0              |
| Typecheck   | `npm run typecheck`  | exit 0              |
| Tests       | `npm test`           | exit 0, all pass    |
| Format check| `npm run format:check` | exit 0 (or run `npm run format`) |
| Manual run  | `npm run dev`        | TUI renders (TTY required) |

`npm test` builds first; tests import from `dist/`.

## Scope

**In scope**:
- `src/cli/renderer.ts` — replace the placeholder with pure formatters.
- `src/cli/commands.ts` — replace the placeholder with the real dispatcher.
- `src/cli/main.ts` — restructure: single approval handler, event rendering via
  renderer, command dispatch via commands, busy state + cancellation, `/clear`
  starts a real new session, session event recording for model switch and
  compaction.
- `src/cli/approvals.ts` — **delete** (unused placeholder). Use `git rm`-equivalent
  (`rm`) and commit the deletion.
- `src/context/manager.ts` — add an optional `onCompact` callback to
  `ContextManagerOptions` and invoke it when compaction happens.
- `src/sessions/store.ts` — add `recordModelSwitched` to `JsonlSession`.
- `tests/cli/renderer.test.ts` (create), `tests/context/compaction-notice.test.ts`
  (create).

**Out of scope** (do NOT touch):
- Agent loop, scheduler, tools, providers. `src/agent/loop.ts` must not change.
- `src/context/compaction.ts` (unused placeholder) — leave it; removal is a
  separate cleanup.
- `src/cli/main.ts`'s argument parsing, config loading, one-shot (non-interactive)
  path, and the `store`/`session` construction block as changed by plan 006.
  Copy them through unchanged.
- Wiring `runtime.*` limits into `AgentRuntime`, provider capability warnings,
  `finishReason` surfacing — separate findings.
- No new slash commands, no new keybindings beyond Esc/Ctrl+C to cancel, no
  markdown rendering, no themes.

## Git workflow

- Branch: `advisor/007-tui-restructure`
- Commit in logical steps (renderer+tests, commands+dispatch, main wiring,
  session events). Subjects in the repo style, e.g.
  `refactor: extract TUI rendering and command dispatch` and
  `feat: cancellable turns and session event recording`.
- Do NOT push or open a PR.

## Target design

`renderer.ts` is pure (no pi-tui import, no I/O) and returns strings; `main.ts`
turns each returned line into a `new Text(line)` child (one `Text` per line — the
existing `appendLine` does this).

```ts
// src/cli/renderer.ts
export interface StatusInfo {
  provider: string; model: string; effort: string;
  inputTokens: number; outputTokens: number;
  busy: boolean; elapsedMs: number;
}
export interface ApprovalInfo {
  command: string; cwd: string; timeoutMs: number; sandboxed: boolean;
}
export const MAX_RESULT_LINES = 12;
export const MAX_THINKING_LINES = 16;

export function formatUserInput(text: string): string;                       // "> text"
export function formatToolCall(name: string, args: Record<string, unknown>): string;
export function formatToolResult(content: string, isError: boolean | undefined, maxLines?: number): string;
export function formatThinking(text: string, maxLines?: number): string;
export function formatApproval(info: ApprovalInfo): string;
export function formatApprovalOutcome(decision: "approve" | "deny" | "trust-session"): string;
export function formatStatus(info: StatusInfo): string;
export function formatCompactNotice(summarized: number, by: "model" | "fallback"): string;
export function formatCancelled(): string;
```

Formatting rules (exact, so this is checkable):

| Function | Output shape |
|---|---|
| `formatToolCall` | `▸ read src/a.ts`, `▸ edit src/a.ts`, `▸ write src/a.ts`, `▸ bash $ npm test`, `▸ webfetch https://x`, `▸ websearch "query"`, else `▸ <name> <json>` — single line, arguments summarized, never raw JSON for the five known tools |
| `formatToolResult` | first line `✓ <first line>` or `✗ <first line>`; remaining lines indented two spaces; cap at `maxLines` (default `MAX_RESULT_LINES`, never more than 40 — reject caller values above 40) then append `  … +N lines` |
| `formatThinking` | each line prefixed `│ ` and wrapped in the dim escape via one shared `dim()` helper; lines are joined with a real newline (not the literal text `\n`); cap at `MAX_THINKING_LINES` then append `│ …` |
| `formatApproval` | box with `approval required`, the command, `cwd:`, `timeout:`, `sandboxed:`, and `[y]es / [n]o / [t]rust session` |
| `formatApprovalOutcome` | `✓ approved`, `✓ trusted for session`, `✗ denied` |
| `formatStatus` | `provider/model · effort · tokens in/out · ● running 1.4s` or `○ idle` |
| `formatCompactNotice` | `[compact] summarized 24 older messages (model)` / `(fallback)` |

Use real escapes written once: `const ESC = "\u001b";` and helpers
`dim`, `green`, `red`. Do not build escape strings with double backslashes.

```ts
// src/cli/commands.ts
export interface CommandContext {
  append(text: string): void;
  sessionInfo(): { id: string; workspace: string; provider: string; messages: number };
  approvalInfo(): { mode: string; trusted: boolean };
  effort(): string;
  setEffort(level: "low" | "medium" | "high"): void;
  thinkingShown(): boolean;
  toggleThinking(): void;
  switchProfile(name: string): void;
  listProfiles(): string[];
  switchModel(model: string): void;
  listModels(): Promise<string[]>;
  openSelect(items: { value: string; label: string; description?: string }[], onSelect: (value: string) => void): void;
  runDoctor(): Promise<string>;
  newSession(): void;
  listSkills(): { name: string; description: string }[];
  loadSkill(name: string, task: string): Promise<void>;
  requestExit(): void;
}
export interface CommandResult { handled: boolean }
export async function handleSlashCommand(input: string, ctx: CommandContext): Promise<CommandResult>;
```

`handleSlashCommand` owns: `/help`, `/session`, `/approval`, `/doctor`, `/clear`,
`/compact`, `/model [profile|model]`, `/skills`, `/skill <name> [task]`,
`/thinking`, `/effort [level]`, `/exit`. Unknown input returns
`{ handled: false }`. It must not import pi-tui, `AgentRuntime`, or config — all
effects go through `ctx`.

## Steps

### Step 1: Write `src/cli/renderer.ts` (pure) and its tests

Replace the file entirely with the API above. No imports from `node:fs`, no
pi-tui, no `process`.

Add `tests/cli/renderer.test.ts` importing from `../../dist/cli/renderer.js`,
covering:

1. `formatToolCall` for read/bash/edit/write/webfetch/websearch and an unknown
   tool (no raw JSON for the known six).
2. `formatToolResult` (a) success marker `✓`, (b) error marker `✗`,
   (c) a 30-line content string yields exactly `maxLines + 1` lines and ends with
   `+20 lines`, (d) `maxLines: 500` is clamped (assert output line count ≤ 41).
3. `formatThinking` caps at `MAX_THINKING_LINES + 1` lines and starts each line
   with `│`.
4. `formatStatus` includes provider/model, effort, `tokens 10/20`, and either
   `● running` or `○ idle`; assert no literal `\x1b` text (i.e. the string does
   not contain the two characters `\` followed by `x`).
5. `formatApproval` contains the command and the `[y]es` hint;
   `formatApprovalOutcome` returns distinct strings for the three decisions.

**Verify**: `npm test` → exit 0, the new renderer tests pass.

### Step 2: Write `src/cli/commands.ts` (real dispatcher)

Implement `handleSlashCommand` with the context above. Rules:

- `/clear` calls `ctx.newSession()` and appends `started new session`.
- `/compact` appends `compaction is automatic` (unchanged behavior).
- `/model` with an argument: if the argument matches `listProfiles()`, call
  `switchProfile(arg)`; otherwise call `switchModel(arg)` and append
  `switched to <provider?>/<arg>` using `ctx.sessionInfo().provider`. With no
  argument, call `listModels()` and pass the results to `openSelect`.
- `/effort` with a valid level calls `setEffort`; with no argument opens
  `openSelect` over `low|medium|high`; invalid level appends the usage line.
- `/skill <name> [task]` calls `loadSkill(name, task)`; unknown name is handled
  inside `loadSkill` (it appends the "skill not found" line) — do not re-check
  the registry here.
- `/thinking` toggles and appends `thinking display: shown|hidden`.
- `/exit` calls `requestExit()`.
- Preserve today's exact user-facing strings where they exist (`session: …`,
  `approval mode: …`, `no skills available`, `usage: /effort low|medium|high`).

**Verify**: `npm run typecheck` → exit 0.

### Step 3: Add the compaction notice hook

In `src/context/manager.ts` add to `ContextManagerOptions`:

```ts
  onCompact?: (info: { summarizedMessages: number; by: "model" | "fallback" }) => void;
```

In `build()`, after `summaryText` is finalized and before returning `compacted`,
invoke it inside a `try { … } catch {}`:

```ts
    try {
      this.opts.onCompact?.({
        summarizedMessages: older.length,
        by: summaryText === FALLBACK_SUMMARY ? "fallback" : "model",
      });
    } catch {
      // A UI callback must never break context building.
    }
```

Introduce `const FALLBACK_SUMMARY = "[Earlier conversation truncated to fit context budget.]";`
and use it as the existing fallback text (replace the inline literal) so the
comparison is exact. Do not change when compaction triggers.

**Verify**: `npm run typecheck` → exit 0.

### Step 4: Add `recordModelSwitched` to the session

In `src/sessions/store.ts`, next to `recordCompaction`:

```ts
  recordModelSwitched(details: { provider: string; model: string }): SessionEvent {
    return this.appendEvent({ type: "model_switched", ...details });
  }
```

**Verify**: `npm run typecheck` → exit 0.

### Step 5: Restructure `src/cli/main.ts`

Work top-to-bottom; keep the non-interactive/one-shot path and the plan-006
`store`/`session` block byte-identical.

1. **Imports**: add `formatUserInput, formatToolCall, formatToolResult,
   formatThinking, formatApproval, formatApprovalOutcome, formatStatus,
   formatCompactNotice, formatCancelled` from `./renderer.js`;
   `handleSlashCommand` from `./commands.js`. Delete the placeholder
   `src/cli/approvals.ts` (it is not imported anywhere).
2. **Session becomes reassignable**: `let session = …` (needed by `/clear`), and
   keep the type as the union of the JSONL and in-memory sessions.
3. **One approval handler**, defined once after `appendLine` exists:
   ```ts
   approvals.handler = interactive
     ? async (req) => {
         for (const line of formatApproval(req).split("\n")) appendLine(line);
         const decision = await new Promise<"approve" | "deny" | "trust-session">((resolve) => {
           pendingApproval = (d) => { pendingApproval = null; resolve(d); };
         });
         appendLine(formatApprovalOutcome(decision));
         return decision;
       }
     : undefined;
   ```
   Remove the other two assignments entirely.
4. **Late-bound hooks** (same pattern as the existing `appendLineFn`):
   `let onCompactFn: (info: { summarizedMessages: number; by: "model" | "fallback" }) => void = () => {};`
   and pass `onCompact: (info) => onCompactFn(info)` when constructing
   `ContextManager`; assign `onCompactFn` after `appendLine` exists:
   ```ts
   onCompactFn = (info) => {
     appendLine(formatCompactNotice(info.summarizedMessages, info.by));
     if (typeof session.appendEvent === "function") {
       session.appendEvent({ type: "context_compacted", ...info });
     }
   };
   ```
5. **Event rendering** via a normal constructor option instead of mutating a
   private field: capture `let renderEvent: (e: AgentEvent) => void = () => {};`
   during TUI setup and pass `onEvent: (e) => renderEvent(e)` to
   `new AgentRuntime({...})`. Then assign `renderEvent = (e) => { … }` after the
   TUI helpers exist. Delete the `runtime["onEvent"] = …` line.
   The handler maps:
   - `thinking_delta` → append to `formatThinking(thinkingBuffer)` (replace the
     in-place `Text`; finalize on the next text/tool/final event)
   - `assistant_delta` / `assistant_text` → `appendDelta`
   - `usage` → update token counters + status
   - `tool_call` → `appendLine(formatToolCall(e.name, e.args))`
   - `tool_result` → `formatToolResult(e.content, e.isError)` lines
   - `model_switched` → status update
   - `final` → `finalizeText()`
6. **Busy state + cancellation**:
   ```ts
   let activeTurn: { controller: AbortController; startedAt: number } | null = null;
   let statusTicker: NodeJS.Timeout | undefined;
   ```
   A helper `runTurn(text)` sets `activeTurn`, starts a 250 ms interval that
   refreshes the status line with elapsed time, awaits `runAgentTurn`, catches
   `USER_CANCELLED` and appends `formatCancelled()`, and clears both in a
   `finally`.
   Register **one** input listener once, before `tui.start()`:
   ```ts
   tui.addInputListener((data: string) => {
     if (!activeTurn) return { consume: false };
     if (data === "\u001b" || data === "\u0003") {
       activeTurn.controller.abort();
       return { consume: true };
     }
     return { consume: false };
   });
   ```
   (The existing dropdowns register their own `addInputListener`; that stays as
   is.)
7. **`onSubmit`**: keep the approval-answer branch first (`y/n/t` when
   `pendingApproval` is set), then:
   ```ts
   if (!trimmed) { tui.requestRender(); return; }
   if (activeTurn) { appendLine("turn in progress — esc to cancel"); return; }
   const dispatched = await handleSlashCommand(trimmed, commandContext);
   if (dispatched.handled) return;
   await runTurn(trimmed);
   ```
   Build `commandContext` from the TUI: `append: appendLine`, `openSelect`
   creates the existing `SelectList` inside `dropdownContainer`, registers a
   temporary input listener, and restores focus on select/cancel (reuse today's
   code for `/model` and `/effort` — move it, do not rewrite it).
8. **Skill handling**: one path only. `loadSkill(name, task)` loads via
   `DefaultSkillRegistry`, appends the skill as a system message, records the
   `skill_loaded` event, appends `Loaded skill: <name>`, and if `task` is
   non-empty submits the task through `runTurn`. The old "first token is a skill
   name" auto-detection is removed — `/skills` lists, `/skill <name>` invokes.
9. **`/clear`** → `newSession()`: create a fresh session (`store.create(...)` or
   `new InMemorySession(randomUUID(), process.cwd(), provider.id)` when sessions
   are disabled), clear `content`, reset token counters, update status. Do not
   just truncate `messages`.
10. **Status line**: `updateStatus()` uses `formatStatus({...})`; call it on
    usage, model switch, effort change, and per ticker interval.
11. **Model switch recording**: after `runtime.switchModel(...)` in both
    `switchProfile` and `switchModel`, call
    `if (typeof session.appendEvent === "function") session.appendEvent({ type: "model_switched", provider: <id>, model: <model> });`.
    (Either the new recorder from Step 4 or the generic `appendEvent` is fine;
    use one form consistently.)

**Verify**: `npm run typecheck` → exit 0.

### Step 6: Test the compaction notice

Create `tests/context/compaction-notice.test.ts` with a stub provider (same shape
as `tests/context/manager.test.ts` from plan 004): small `contextWindow`
(e.g. 8000), a history of ~40 messages of 2000 chars, and an `onCompact` spy.
Assert the spy is called once with `{ summarizedMessages: <n>, by: "model" }`
when `generate` returns text, and `by: "fallback"` when `generate` throws.
Assert a throwing `onCompact` does not make `build()` reject.

**Verify**: `npm test` → exit 0.

### Step 7: Structural cleanup checks

**Verify**:

```
grep -c "approvals.handler = " src/cli/main.ts     # expect 1
grep -n 'runtime\["onEvent"\]' src/cli/main.ts     # expect no matches
grep -c "DefaultSkillRegistry" src/cli/main.ts     # expect ≤ 2 (import/use in loadSkill only)
test ! -f src/cli/approvals.ts && echo "approvals.ts removed"
npm run typecheck && npm test
```

### Step 8: Manual TUI smoke test (operator, not automated)

Run `npm run dev` in a real terminal and confirm, in order:

1. Header shows `~/…:branch`; status bar shows provider/model, effort, tokens,
   `○ idle`.
2. Sending a task streams text; while it runs the status shows `● running Ns`,
   and a second Enter prints `turn in progress — esc to cancel`.
3. A tool call renders as one `▸` line; its result is indented, capped with
   `… +N lines` when long, and errors show `✗`.
4. Esc during a turn stops it with a `cancelled` line and the status returns to
   `○ idle`.
5. A `bash` command needing approval shows the box, accepts `y`/`n`/`t`, and the
   outcome line appears; `t` makes later commands skip the prompt.
6. `/model` opens the dropdown; selecting one prints the switch line and updates
   the status bar. `/effort high` and `/thinking` behave as before.
7. `/clear` starts a new session: `/session` shows a new id and message count 0.
8. Long sessions: after compaction, a `[compact] summarized N older messages`
   line appears in the transcript.

If a step cannot be exercised without a TTY, say so in the completion report —
do not claim it passed.

## Test plan

- `tests/cli/renderer.test.ts` — pure formatting, no TTY (5 test cases above).
- `tests/context/compaction-notice.test.ts` — callback contract, including the
  throwing-callback guard.
- Existing suites must stay green: 17 tests at plan time, plus plans 001-006's
  additions.
- No automated test for key handling or dropdown wiring; that is the Step 8
  manual checklist. State explicitly in the report what was and was not run.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0, including the new renderer and compaction tests
- [ ] `grep -c "approvals.handler = " src/cli/main.ts` prints `1`
- [ ] `grep -n 'runtime\["onEvent"\]' src/cli/main.ts` prints nothing
- [ ] `src/cli/approvals.ts` no longer exists
- [ ] `src/cli/renderer.ts` has no imports from `@earendil-works/pi-tui`,
  `node:fs`, or `../agent` (`grep -n "^import" src/cli/renderer.ts` shows none of them)
- [ ] `handleSlashCommand` from `src/cli/commands.ts` is imported and called by
  `src/cli/main.ts`
- [ ] `git status` shows only the in-scope files (plus the deleted placeholder)
- [ ] `plans/README.md` status row for 007 updated

## STOP conditions

Stop and report back if:

- `src/cli/main.ts` no longer contains the excerpted regions (someone
  concurrently edited the TUI).
- `@earendil-works/pi-tui` lacks `addInputListener` on the TUI object, or its
  listener contract differs from
  `(data: string) => { consume: boolean }` — report the actual signature instead
  of inventing one.
- `handleSlashCommand` cannot be expressed without importing `AgentRuntime` or
  pi-tui (e.g. a command needs a provider type) — report the specific command and
  its dependency rather than widening the context interface ad hoc.
- The 250 ms status ticker prevents the process from exiting after `/exit`
  (`clearInterval` must run on exit); if it does, report the exit path rather
  than leaving a leaked timer.
- Any plan 001-006 check regresses (e.g. a tool test starts failing) — stop, do
  not paper over it.

## Maintenance notes

- New slash commands belong in `src/cli/commands.ts`; new event formatting belongs
  in `src/cli/renderer.ts`. Anything that constructs TUI components belongs in
  `main.ts`. Keep that split — it is what makes the CLI unit-testable.
- `openSelect` is the single dropdown entry point; if another multi-choice
  surface is added, extend it rather than registering a second global input
  listener (listeners compose in registration order and are easy to leak).
- `activeTurn` guarantees one running turn per session, which the agent loop
  assumes (sequential rounds). Do not add a queue without revisiting the loop's
  invariants.
- `/clear` creating a new file per invocation means sessions accumulate faster;
  plan 006's `retentionDays` is the mitigation. If `/clear` is used as a
  reset-in-place by users, revisit this decision.
- Deferred deliberately: markdown rendering, collapsing tool results on demand,
  diff previews for `edit`/`write`, wiring `runtime.*` limits, and surfacing
  `finishReason === "length"` in the status line.
