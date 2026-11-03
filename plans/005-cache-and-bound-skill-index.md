# Plan 005: Cache and bound the skill index

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise.
>
> **Drift check (run first)**:
> `git diff --stat 37e692e..HEAD -- src/context/manager.ts src/skills/registry.ts`
> If either file changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch, treat
> it as a STOP condition. Plan 004 also edits `manager.ts` — apply 004 first and
> expect that diff.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/004-context-budget-from-model-info.md
- **Category**: perf
- **Planned at**: commit `d2d4d2b`, 2026-11-03
- **Verified at**: commit `37e692e` (excerpts unchanged)

## Why this matters

`ContextManager.build()` runs on every agent iteration — before every model
request. It constructs a fresh `DefaultSkillRegistry`, which scans
`~/.agents/skills/` and `<workspace>/.agents/skills/`, `stat`s every entry, and
reads **every** `SKILL.md` in full. On the development machine used for this
audit that is ~60 global skills, i.e. ~60 file reads and JSON-free markdown
parsing per model call, on the critical path of the agent loop.

Two related correctness issues in the same code:

1. The index is unbounded. `.scratch/new-features/spec.md` explicitly requires
   "Skills index size should be bounded (truncate if too large)" — with long skill
   descriptions the index can eat thousands of tokens from every request.
2. The compaction branch rebuilds the system prompt from
   `this.opts.systemPrompt`, **dropping** the skill index, so after the first
   compaction the model silently loses the list of available skills.

## Current state

- `src/context/manager.ts:45-52` — per-build registry construction:

```ts
    const registry = new DefaultSkillRegistry(workspace);
    const skillIndex = registry.indexText();
    const systemPrompt = skillIndex
      ? `${this.opts.systemPrompt}\n\n${skillIndex}`
      : this.opts.systemPrompt;
```

- `src/context/manager.ts:96-104` — compaction path that drops the index:

```ts
    const compacted: Message[] = [
      { role: "system", content: this.opts.systemPrompt },
      ...instructions.map((i) => ({ role: "system" as const, content: i })),
      …
    ];
```

- `src/skills/registry.ts:28-53` — `scanDir()` does `readdirSync`, `statSync`,
  and `readFileSync(skillFile)` for each skill directory.
- `src/skills/registry.ts:95-101` — unbounded `indexText()`:

```ts
  indexText(): string {
    if (this.skills.length === 0) return "";
    const lines = this.skills.map((s) => `- ${s.name}: ${s.description} (${s.path})`);
    return `Available skills:\n${lines.join("\n")}\n\nRead a skill's SKILL.md with the read tool when relevant.`;
  }
```

No caching exists anywhere: `grep -rn "DefaultSkillRegistry" src` shows
`manager.ts` (per build) and `cli/main.ts` (per `/skills` command).

## Commands you will need

| Purpose   | Command             | Expected on success |
|-----------|---------------------|---------------------|
| Install   | `npm install`       | exit 0              |
| Typecheck | `npm run typecheck` | exit 0              |
| Tests     | `npm test`          | exit 0, all pass    |

## Scope

**In scope**:
- `src/context/manager.ts`
- `src/skills/registry.ts`
- `tests/context/skill-index.test.ts` (create)

**Out of scope**:
- `src/cli/main.ts` — the `/skills` command and skill-injection UX are handled by
  plan 007. Do not touch the CLI here.
- Adding a skill-invalidation watcher, a skills cache on disk, or a new tool.
- `src/context/compaction.ts` (unused placeholder) — dead-code removal is not in
  this plan.
- Changing frontmatter parsing or scope precedence (global → project override).

## Git workflow

- Branch: `advisor/005-cache-and-bound-skill-index`
- Commit subject: `perf: cache and bound the skill index`
- Do NOT push or open a PR.

## Steps

### Step 1: Memoize the index per workspace in `ContextManager`

Add a field to the class next to `budgetPromise`:

```ts
  private skillIndexByWorkspace = new Map<string, string>();

  private skillIndexFor(workspace: string): string {
    let index = this.skillIndexByWorkspace.get(workspace);
    if (index === undefined) {
      index = new DefaultSkillRegistry(workspace).indexText();
      this.skillIndexByWorkspace.set(workspace, index);
    }
    return index;
  }
```

Replace the construction block in `build()` with:

```ts
    const skillIndex = this.skillIndexFor(workspace);
    const systemPrompt = skillIndex
      ? `${this.opts.systemPrompt}\n\n${skillIndex}`
      : this.opts.systemPrompt;
```

**Verify**: `npm run typecheck` → exit 0.

### Step 2: Keep the index in the compaction branch

In the `compacted` array, replace `content: this.opts.systemPrompt` with
`content: systemPrompt` (the already-composed value from Step 1). Leave the
instruction messages and the summary message untouched.

**Verify**: `npm run typecheck` → exit 0.

### Step 3: Bound `indexText()`

Rewrite `indexText()` in `src/skills/registry.ts`:

```ts
  indexText(): string {
    if (this.skills.length === 0) return "";
    const MAX_CHARS = 4000;
    const header = "Available skills:\n";
    const footer = "\n\nRead a skill's SKILL.md with the read tool when relevant.";
    const budget = MAX_CHARS - header.length - footer.length;
    const lines: string[] = [];
    let used = 0;
    let omitted = 0;
    for (const s of this.skills) {
      const line = `- ${s.name}: ${s.description} (${s.path})`;
      if (used + line.length + 1 > budget) {
        omitted++;
        continue;
      }
      lines.push(line);
      used += line.length + 1;
    }
    const note = omitted ? `\n- … ${omitted} more skills (see /skills)` : "";
    return header + lines.join("\n") + note + footer;
  }
```

Keep the property order and the `this.skills` ordering intact so project skills
still win on collision (the constructor already dedupes).

**Verify**: `npm run typecheck` → exit 0.

### Step 4: Write the tests

Create `tests/context/skill-index.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextManager } from "../../dist/context/manager.js";
import { DefaultSkillRegistry } from "../../dist/skills/registry.js";

function writeSkill(workspace: string, name: string, description: string) {
  const dir = join(workspace, ".agents", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nBody for ${name}.\n`,
  );
}

const provider = {
  id: "stub",
  async generate() {
    return {
      message: { role: "assistant", content: [{ type: "text", text: "S" }] },
      toolCalls: [],
      finishReason: "stop",
    };
  },
};

function manager() {
  return new ContextManager({
    systemPrompt: "sys",
    maxInputTokens: 128000,
    reserveOutputTokens: 1024,
    compactAtPercent: 85,
    maxProjectInstructionBytes: 30000,
    provider: provider as any,
    model: "stub",
  });
}
```

Three tests:

1. `project skill appears in the system prompt`
   - temp workspace + `writeSkill(ws, "alpha", "test skill")`
   - `const out = await manager().build(ws, [{ role: "user", content: [{ type: "text", text: "hi" }] }])`
   - assert `String(out[0].content).includes("alpha")`
2. `index is cached for the session`
   - same setup, one manager instance; `build()` once, then
     `rmSync(join(ws, ".agents", "skills", "alpha"), { recursive: true })`,
     `build()` again; assert the marker skill is **still** in the system prompt
     (proves the index was not re-scanned).
3. `index is bounded`
   - temp workspace; write 80 skills named `s00..s79` with
     `description: "d".repeat(120)`
   - `const text = new DefaultSkillRegistry(ws).indexText()`
   - assert `text.length <= 4100`
   - assert `text.includes("more skills")`

**Verify**: `npm test` → exit 0, three new tests pass.

## Test plan

- New file `tests/context/skill-index.test.ts` with the three tests above.
- Pattern: `tests/config/load.test.ts` for temp-dir + plain-object style.
- Regression intent: test 2 fails pre-fix (a freshly scanned registry no longer
  sees the deleted skill). Test 3 fails pre-fix (unbounded string).
- The real `~/.agents/skills` directory is also scanned on machines that have it;
  therefore assert on the `alpha` marker and on the length bound, never on the
  total number of lines.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0, including the three new tests
- [ ] `grep -c "new DefaultSkillRegistry" src/context/manager.ts` returns 1
- [ ] `grep -n "MAX_CHARS" src/skills/registry.ts` matches
- [ ] `grep -n "content: this.opts.systemPrompt" src/context/manager.ts` returns no matches
- [ ] `git status` shows only the three in-scope files
- [ ] `plans/README.md` status row for 005 updated

## STOP conditions

Stop and report back if:

- Plan 004's `resolveBudget`/`thresholdFor` refactor is not present (apply 004
  first; this plan assumes the post-004 file shape).
- `DefaultSkillRegistry.indexText()` is called from a hot path the plan did not
  account for (e.g. the loop itself) — report instead of adding caching there.
- The test for caching passes on pre-fix code — that means something else is
  already caching and this plan's premise is wrong; report.

## Maintenance notes

- The index is cached for the lifetime of the `ContextManager`, which the CLI
  creates once per process. Installing a skill mid-session therefore requires a
  restart (or the `/skills` command, which constructs its own registry). If live
  reload is wanted later, clear `skillIndexByWorkspace` on a filesystem event or a
  TTL — do not re-scan per request.
- `MAX_CHARS = 4000` is a prompt-budget decision. If skills grow descriptions,
  the truncation note is what tells the model other skills exist; keep it.
- A reviewer should confirm the compaction branch now carries the same system
  prompt (with index) as the normal path.
