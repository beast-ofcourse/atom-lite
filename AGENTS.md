# Atom-lite

Local-first, model-agnostic coding agent. See `docs/README.md` for the published documentation map. ADRs under `docs/adr/` are private and gitignored.

## Release workflow (follow exactly)

1. Bump `version` in `package.json` and add a `CHANGELOG.md` entry.
2. Run `npm run typecheck && npm test && npm run bench` (bench is non-gating).
3. Commit, tag, push: `git commit ... && git tag vX.Y.Z && git push origin master --tags`.
4. Publish to npm directly (do not rely on staged approval; local `npm stage approve` returns 404):
   `npm publish --access public`
5. Create GitHub release: `gh release create vX.Y.Z --title "vX.Y.Z" --notes "..."`.
6. Verify: `npm view atom-lite version` and the GitHub release page.

Do not use `npm stage approve` (requires 2FA/CI token). Direct publish works with the configured npm token.

## Agent skills

- Always use caveman skill , always on.

### Issue tracker

Issues and specs live as markdown files under `.scratch/`. See `docs/agents/issue-tracker.md`.

### Release workflow skill

Use the `release-workflow` skill (`.agents/skills/release-workflow/SKILL.md`) when releasing, publishing, shipping, bumping a version, or preparing release notes/changelog. It supersedes the short checklist above; follow it exactly.

### Documentation skill

Use the `atom-lite-docs` skill (`.agents/skills/atom-lite-docs/SKILL.md`) for any change to `README.md`, `docs/`, or the changelog. It owns the page map and the house style.

### Eval maintainer skill

Use the `eval-maintainer` skill (`.agents/skills/eval-maintainer/SKILL.md`) for eval work: running a suite or repeated trials, triaging a failure, reviewing a failed transcript, adding or strengthening a task or grader, or fixing harness drift. It owns the diagnose → fix → add regression task → re-run loop and points to the public eval documentation as the source of truth.

### Git skill

Use the `git-skill` skill (`.agents/skills/git-skill/SKILL.md`) for repository housekeeping: audit local/remote state, find unmerged or unpushed commits, fast-forward master, push, verify GitHub, or recover from drift. It never rewrites history. Releases go to `release-workflow`.

### Domain docs

Single-context repo: published docs in `docs/`, private gitignored ADRs in `docs/adr/`. See `docs/agents/domain.md`.
