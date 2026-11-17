---
name: atom-lite-docs
description: "Write and review Atom-lite documentation in the published house style. Use for any change to README.md, docs/, CHANGELOG.md, examples, or user-facing behavior; also use when adding a config field, command, flag, tool, persona field, or surface."
---

# Atom-lite docs

Docs are part of the change, not a follow-up. Write one topic per page, lead with a working example, and document shipped behavior only. Architecture decision records under `docs/adr/` are private and gitignored; never link to them from published docs.

## When to use

- A code change adds or changes a command, flag, config field, tool, provider, persona field, or surface.
- A bug fix changes documented behavior or a troubleshooting case.
- A new concept needs its own page, or an existing page has become a catch-all.

## Page map

| Page                      | Owns                                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| `README.md`               | Short landing: what it is, install, quick start, feature list, docs table.                   |
| `docs/README.md`          | Documentation index. Groups pages by Get started / Use / Customize / Reference / Contribute. |
| `docs/install.md`         | Package managers, standalone binaries, default provider.                                     |
| `docs/quickstart.md`      | First session, one-shot tasks, stdin, resume, first settings.                                |
| `docs/cli.md`             | Flags, terminal interface, keybindings, modes, shell mode, non-interactive use.              |
| `docs/commands.md`        | Every slash command, subcommands, arguments, palette.                                        |
| `docs/config.md`          | Every config field, default, scope, precedence, environment variables.                       |
| `docs/tools.md`           | Built-in tools, scheduling, background tasks, plan mode, hash guards, ledger.                |
| `docs/providers.md`       | Adapter types, profiles, credentials, model selection, context window.                       |
| `docs/agents.md`          | Persona files, locations, frontmatter, permissions, trust.                                   |
| `docs/sessions.md`        | Session lifecycle, resume, search, export, ownership, compaction, retention.                 |
| `docs/goals.md`           | Goal fields, lifecycle, pause, completion gate, panel, continuation.                         |
| `docs/extensions.md`      | Pi compatibility, discovery, trust, tool and UI tiers, diagnostics.                          |
| `docs/web.md`             | Localhost server, boundaries, controls, reconnects, share mode.                              |
| `docs/safety.md`          | Workspace boundary, modes, approvals, personas, trust, secrets.                              |
| `docs/troubleshooting.md` | Symptom → exact fix, with commands.                                                          |
| `docs/eval.md`            | Task format, suites, graders, commands, metrics, artifacts, transcript review.               |
| `docs/agents/`            | Internal agent workflow conventions. Not part of the public nav.                             |
| `CHANGELOG.md`            | Released changes only.                                                                       |

Add a page only when no existing page owns the topic. Update `docs/README.md` and the root README docs table in the same commit.

## House style

Model pages on `https://opencode.ai/docs`: short, task-oriented, one concept per page.

### Structure

1. `# Title` — one noun phrase.
2. One or two sentences saying what the thing does, then a copy-pasteable example when one exists.
3. `##` sections with short semantic headings: `Install`, `Quick start`, `Flags`, `Fields`, `Precedence`, `Recovery`, `Limits`, `Next`.
4. Use `###` only inside a longer `##` section. Do not skip levels.
5. End with `## Next` links to two or three related pages when useful.

### Voice

- Second person, present tense, active voice. "Set `runtime.mode` to `plan`", not "the mode may be set".
- No marketing claims, no "simply", no "powerful", no filler.
- State defaults, types, scope (user vs project), and failure behavior explicitly.
- Use the project's own vocabulary: workspace, session, goal, ledger, tool call, batch, persona, approval.

### Code and tables

- Fence with the language: `bash`, `jsonc`, `json`, `text`, `md`, `sh`.
- Annotate a file example with `title="path/to/file"` on the fence.
- Use `jsonc` when a comment helps; `json` when it does not.
- Keep examples copy-pasteable and verified against the code.
- Reference tables use short columns such as `Key | Type | Default | Description` or `Command | Behavior`.
- Put nullable values as `string \| null`, integers as `positive integer`, enums as `"a" \| "b"`.

### Links and callouts

- Link with the page title or a short description: `[Config](./config.md)`, not "click here".
- Use relative links between docs pages. Link to root files only for CONTRIBUTING, SECURITY, AGENTS, and CHANGELOG.
- Use `> **Note:**` and `> **Warning:**` blockquotes for caveats. Keep them one short paragraph.
- Never link to `docs/adr/`, `.scratch/`, or another private path from a published page.

## Workflow

1. Run `git diff --name-only` and map each changed code area to a page in the page map.
2. Read the source of truth before writing: `src/config/schema.ts` for fields, `src/cli/commands.ts` for commands, `src/cli/app.ts` for flags and keybindings, `src/tools/` for tools.
3. Edit the owning page. If the page drifted, fix the drift instead of adding a second page.
4. Add or update cross-links in `docs/README.md` and the root README docs table.
5. For a config field, add its row to `docs/config.md` with type, default, scope, and effect.
6. For a command, add its row to `docs/commands.md` including aliases and argument hints.
7. For a failure mode, add a symptom → fix entry to `docs/troubleshooting.md`.
8. Run the checks below and read the final diff for contradictions with code.

## Consistency checks

- Every config field in `src/config/schema.ts` appears in `docs/config.md`.
- Every command in `createCommandRegistry` appears in `docs/commands.md`.
- Every CLI flag in `src/cli/app.ts` appears in `docs/cli.md`.
- Names, defaults, file paths, and status strings match code and `package.json`.
- No published page links into `docs/adr/`, `.scratch/`, or `temp/`.
- The eval page exists, is linked from `docs/README.md`, and appears in this page map.
- No stale command, config, or keybinding entries remain.
- ADRs, if present locally, are not the only place a user-visible decision is recorded.

## Verification

```bash
npm run typecheck
npm test
npm run docs:check
```

`docs:check` validates internal links, config-field coverage, the private-path rule, and that the eval page is present and wired into the index and this page map. Fix every failure before committing.

## Commit checklist

- [ ] Owning page updated for the behavior change.
- [ ] Index and root docs table updated if pages or topics changed.
- [ ] Examples are copy-pasteable and match code.
- [ ] Tables state defaults, types, and scope.
- [ ] No link into private or scratch paths.
- [ ] `npm run docs:check` passes.
