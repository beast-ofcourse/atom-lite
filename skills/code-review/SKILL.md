---
name: code-review
description: >
  Review code changes against repository standards and the originating spec.
  Use for "review this PR", "review the diff", "code review", or before merging.
---

# Code Review

Two-axis review of a change. Run both axes and report them separately.

## Axes

1. **Standards** — does the code follow this repo's documented conventions?
   Sources: `AGENTS.md`, `CONTRIBUTING.md`, `docs/adr/*`, TypeScript strict mode,
   NodeNext ESM, named exports, no new runtime deps without discussion.
   Also apply the smell baseline: mysterious name, duplicated code, feature envy,
   data clumps, primitive obsession, repeated switches, shotgun surgery,
   divergent change, speculative generality, message chains, middle man,
   refused bequest. A documented repo standard always overrides a smell.

2. **Spec** — does the code implement what the issue/spec asked for?
   Find the spec under `.scratch/<feature>/spec.md` or the referenced issue.

## Process

1. Pin the fixed point: `git diff <base>...HEAD` (three-dot). List commits.
2. Identify standards sources and the spec source.
3. For each file/hunk, report:
   - Standards: hard violations (cite file + rule) and judgement-call smells.
   - Spec: missing/partial requirements, scope creep, wrong-looking implementations.
   Quote the spec line for each spec finding.
4. Aggregate under `## Standards` and `## Spec` headings. Do not merge axes.

## Output format

- `## Standards` — findings per file/hunk, hard vs judgement.
- `## Spec` — findings keyed to spec lines.
- One-line summary per axis: count + worst issue.

## Rules

- Skip anything tooling enforces (tsc, tests, lint).
- Smells are judgement calls, never hard violations.
- Report facts, not opinions; cite paths and lines.
- Small, reviewable findings are preferred over exhaustive nitpicks.