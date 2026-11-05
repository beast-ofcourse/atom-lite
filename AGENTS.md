# Atom-lite

Local-first, model-agnostic coding agent. See `docs/README.md` for documentation and `docs/adr/` for architectural decisions.

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

### Issue tracker

Issues and specs live as markdown files under `.scratch/`. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context repo: docs in `docs/`, ADRs in `docs/adr/`. See `docs/agents/domain.md`.
