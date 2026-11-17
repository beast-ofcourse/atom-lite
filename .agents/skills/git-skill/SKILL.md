---
name: git-skill
description: "Keep the Atom-lite repository consistent locally and on GitHub. Use for git housekeeping: audit branch state, find unmerged or unpushed commits, sync master, land integration work, push, verify GitHub, or recover from drift. Releases go to release-workflow."
---

# Git skill

`origin/master` is the single source of truth. Local commits do not exist for users until they are on `origin/master`. Every action starts with an audit and ends with a verification against GitHub.

## Absolute safety rules

- Never use `push --force`, `reset --hard`, `rebase` on pushed commits, `filter-branch`, or any history rewrite.
- Never merge into a branch you do not intend to push.
- If a merge cannot fast-forward, stop and report. Do not invent a conflict resolution.
- Never push without running the gates on the exact tree being pushed.
- Never amend or rename historical commits to satisfy style rules. Record the deviation instead.

## 1. Audit (run first, every time)

```bash
git fetch --all --prune
git status -sb
git rev-parse --short HEAD master origin/master
git branch -vv
git for-each-ref --format='%(refname:short)' refs/heads refs/remotes
```

Find local commits after the release that are not on any remote:

```bash
git log --oneline v0.16.2.. --all --not \
  $(git for-each-ref --format='%(refname:short)' refs/remotes | tr '\n' ' ')
```

Verify against GitHub itself, not just the local remote-tracking ref:

```bash
gh api repos/beast-ofcourse/atom-lite/commits/master --jq '.sha'
gh api "repos/beast-ofcourse/atom-lite/compare/v0.16.2...master" --jq '.total_commits'
gh pr list --state open
```

State the result plainly: how many commits are ahead, which branches hold them, and whether GitHub agrees.

## 2. Decision table

| Observed state                                               | Action                                                                  |
| ------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `master == origin/master` and no local commits after release | Nothing to land. Report clean.                                          |
| Integration branch is a descendant of `master` and ahead     | Go to §3 (land by fast-forward).                                        |
| `master` is ahead of `origin/master`                         | Push `master` after gates (§3 step 4).                                  |
| A branch cannot fast-forward onto `master`                   | Stop. Report the divergence and ask; do not merge.                      |
| Work exists only on a stale ticket branch                    | Verify it is already in the integration branch before merging anything. |
| GitHub and `origin/master` disagree                          | Re-fetch, re-audit; if still different, stop and report.                |
| A release is requested (version, tag, npm, GitHub release)   | Hand off to the `release-workflow` skill. Do not improvise.             |

## 3. Land integration work on master

1. Confirm fast-forward is possible:
   ```bash
   git merge-base --is-ancestor master <integration-branch> && echo FF-OK
   ```
   If it fails, stop.
2. Confirm the working tree is clean: `git status --short` must be empty.
3. Merge and push:
   ```bash
   git checkout master
   git merge --ff-only <integration-branch>
   npm run typecheck && npm test && npm run docs:check && npm run eval:smoke
   git push origin master
   ```
4. Verify (§4). Report the exact push line and commit counts.

## 4. Verify GitHub

```bash
git status -sb                         # must show master...origin/master, clean
for r in master origin/master; do printf "%s %s\n" "$r" "$(git rev-parse --short $r)"; done
gh api repos/beast-ofcourse/atom-lite/commits/master --jq '.sha'
gh api "repos/beast-ofcourse/atom-lite/compare/v0.16.2...master" --jq '.total_commits'
```

Success means: local `master`, `origin/master`, and GitHub master are the same SHA; commit count matches the audit; working tree clean.

## 5. Drift recovery

- **Local `origin/master` stale:** `git fetch origin`. Do not re-clone.
- **Local commits lost from a branch:** check every local branch with `git rev-list --count <branch>..<integration-branch>` and the reverse before declaring loss. A ticket branch missing later integration commits is normal; commits missing _from_ integration are not.
- **Accidental push to wrong branch:** stop, report the exact refs, and ask. Do not rewrite.
- **Dependabot PRs:** leave them untouched unless explicitly asked; they are not part of the code line.

## 6. Cleanup

After all commits are merged and pushed:

```bash
git worktree list
git worktree remove --force <worktree-path>   # only exhausted, merged worktrees
git worktree prune
```

Never remove a worktree with unmerged commits. Verify with `git rev-list --count integration..<branch> == 0` first.

## 7. Handoffs

- Version bump, CHANGELOG, tag, npm publish, GitHub release → `release-workflow` skill.
- Docs changes pulled in by a merge → `atom-lite-docs` skill; run `npm run docs:check`.
- Eval harness changes → `eval-maintainer` skill; run `npm run eval:smoke`.

## Completion report

Always end with: the audit result, the commands run, the final SHAs (local / origin / GitHub), gate results, and anything deliberately left undone (for example version, tag, npm, or open PRs). Use evidence, not claims.
