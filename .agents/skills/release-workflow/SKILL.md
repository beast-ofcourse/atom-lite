---
name: release-workflow
description: Release a new version of Atom-lite to npm and GitHub. Use when asked to release, publish, ship, bump version, cut a release, or prepare a release note/changelog. Covers version bump, gate checks, diff-driven changelog and release notes, tagging, publishing, and verification.
---

# Release workflow

This skill is the canonical procedure for shipping a new Atom-lite version to npm and GitHub. Follow it exactly. Do not improvise ordering.

## When to use

- The user says "release", "publish", "ship", "cut a release", "bump version", "prepare release notes".
- A version bump or CHANGELOG edit is requested.
- After a batch of commits is ready to ship.

## Steps (follow in order)

### 1. Establish the diff between the last release and now

Do this before anything else. It is the source of truth for the changelog and release notes.

1. Find the last released tag: `git describe --tags --abbrev=0`.
2. List commits since that tag: `git log <tag>..HEAD --oneline`.
3. Get the full diff: `git diff <tag>..HEAD --stat` and `git diff <tag>..HEAD`.
4. Cross-check against the previous CHANGELOG entry to avoid duplicating or omitting items.
5. If a previous release note exists on GitHub, fetch it: `gh release view <tag> --json body -q .body` and compare tone/structure.

Never write a changelog or release note from memory. Derive every bullet from the diff and commit list.

### 2. Bump version

1. Read `package.json` `version`.
2. Choose the next version per semver:
   - patch: bug fixes, perf, docs, refactors with no API change.
   - minor: new features, new commands/tools, backward-compatible behavior changes.
   - major: breaking changes to CLI, config, session format, or public API.
3. Update `version` in `package.json`. No other field changes unless explicitly needed.

### 3. Write the CHANGELOG entry

Prepend a new section to `CHANGELOG.md` (create the file if absent) using this shape:

```markdown
## vX.Y.Z — YYYY-MM-DD

### Added
- ...

### Changed
- ...

### Fixed
- ...

### Performance
- ...

### Breaking
- (only if applicable; otherwise omit)
```

Rules:
- One bullet per user-visible or developer-visible change. Group by category.
- Each bullet starts with a capital, ends with a period, and names the affected surface (`cli`, `agent`, `tools`, `runtime`, ...).
- Include file paths only when they help a contributor locate the change; keep user-facing bullets path-free.
- Do not paste commit hashes or PR numbers unless the project convention requires them.
- Order bullets by impact: most user-visible first.
- Compare against the previous version's entry to keep voice, tense, and granularity consistent.

### 4. Gate checks (must all pass)

Run exactly:

```
npm run typecheck && npm test && npm run bench
```

- `npm run bench` is non-gating; record the result but do not block on it unless a regression is obvious.
- If typecheck or tests fail, stop. Fix or report; do not release.
- Record the pass/fail counts and any bench numbers for the release note.

### 5. Commit, tag, push

```
git add package.json CHANGELOG.md
git commit -m "chore(release): vX.Y.Z"
git tag vX.Y.Z
git push origin master --tags
```

- Commit message uses the `chore(release):` prefix.
- Tag is annotated-lightweight `vX.Y.Z` (with leading `v`).
- Push tags in the same command.

### 6. Publish to npm

```
npm publish --access public
```

- Do NOT use `npm stage approve` (returns 404; requires 2FA/CI token). Direct publish works with the configured npm token.
- If publish fails on auth, verify `npm whoami` and the token; do not retry blindly.

### 7. Create GitHub release

Write release notes derived from the CHANGELOG entry, expanded for GitHub readers:

```markdown
## What's new

- <user-facing highlights, 3-5 bullets max>

## Changes

### Added
...

### Changed
...

### Fixed
...

### Performance
...

## Install / upgrade

npm install -g atom-lite@X.Y.Z

## Full diff

https://github.com/<owner>/<repo>/compare/vPREV...vX.Y.Z
```

Rules:
- Lead with user-facing impact, not implementation details.
- Keep the "What's new" section to 3-5 bullets; details go under Changes.
- Include the install command and the compare link.
- Tone: professional, concise, no marketing fluff, no emoji.

Create with:

```
gh release create vX.Y.Z --title "vX.Y.Z" --notes "..."
```

### 8. Verify

1. `npm view atom-lite version` must equal `X.Y.Z`.
2. Open the GitHub release page and confirm notes render correctly.
3. `npm install -g atom-lite@X.Y.Z` in a clean shell (optional but recommended) and run `atom-lite --version`.

### 9. Report

Tell the user: version shipped, npm link, GitHub release link, and any bench deltas.

## Release note writing rules

- Prefer comparing the previous release to the current tree over summarizing commits.
- Every claim in the note must be traceable to a diff hunk or commit. If unsure, say "inferred".
- Never fabricate features, fixes, or performance numbers. Mark measured numbers as "measured" and unmeasured as "expected".
- Use the same section vocabulary as the CHANGELOG (Added/Changed/Fixed/Performance/Breaking) so the two stay in sync.
- Keep sentences short and declarative. One thought per sentence.

## Safety

- Never publish without passing typecheck + tests.
- Never force-push tags. If a tag is wrong, delete locally and remotely then re-tag, and announce it.
- Never include secrets, tokens, or internal paths in notes.
- If the working tree is dirty, stop and resolve before releasing.
---

## Notes

- The `.agents/` directory is gitignored except for the tracked `atom-lite-extensions` skill. If you want this skill committed, adjust `.gitignore` or track it explicitly.
- Re-running this skill updates the same procedure; keep it idempotent.
