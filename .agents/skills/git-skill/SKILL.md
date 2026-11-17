---
name: git-skill
description: "Keep the Atom-lite repository clean locally and on GitHub. Use for git housekeeping: audit state, find unmerged or unpushed commits, create branches, commit, run gates, merge to master, verify GitHub, clean worktrees, or recover from drift. Push always pauses for an explicit yes. Releases go to release-workflow."
---

# Git skill

`origin/master` is the source of truth. A local commit is not shipped until it
is on `origin/master`.

## Operating contract

Automate the audit, branch, commit, gates, merge, verification, and cleanup. Run
those steps without asking. Keep every step small and named: one branch per
change, one commit per intent, explicit paths staged, and no branch, worktree, or
remote left half-finished.

Push is the only manual gate. Stop before `git push`, show the exact refs and
commit range, and ask. Push only when the user's current message is an explicit
approval (`yes`, `push`, `push master`). An earlier approval never carries
forward.

Preserve user work. Never rewrite history, force-push, `reset --hard`,
`clean -fd`, or discard uncommitted changes. Move work to its own branch or a
named stash before switching context.

## 1. Audit

Run first and read-only. Note every dirty path before touching a branch.

```bash
git fetch --all --prune
git status -sb
git rev-parse --short HEAD
git rev-parse --short master
git rev-parse --short origin/master
git branch -vv
git worktree list
```

Find the last release and any local work not on a remote:

```bash
tag=$(git describe --tags --abbrev=0)
git log --oneline "$tag.." --all --not \
  $(git for-each-ref --format='%(refname:short)' refs/remotes | tr '\n' ' ')
```

Verify GitHub itself, not only the local remote-tracking ref:

```bash
gh api repos/beast-ofcourse/atom-lite/commits/master --jq '.sha'
gh api "repos/beast-ofcourse/atom-lite/compare/$tag...master" --jq '.total_commits'
gh pr list --state open
```

Report in one line: dirty or clean, ahead/behind counts, which branches hold
unique commits, and whether local `master`, `origin/master`, and GitHub agree.

Completion criterion: every dirty path, unpushed commit, worktree, and open PR
is accounted for.

## 2. Decide

| State                               | Action                                                                                                    |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Nothing ahead, clean tree           | Report clean. Stop.                                                                                       |
| Dirty tree, one coherent change     | Create a named branch, commit explicit paths, continue.                                                   |
| Dirty tree, unrelated changes       | Split into separate branches and commits. Never stage the whole tree blindly.                             |
| Branch descends from `master`       | Fast-forward merge.                                                                                       |
| Only local `master` is ahead        | Run gates, then the push gate.                                                                            |
| Branch diverged from `master`       | Inspect both sides. Merge only if the branch has live work master lacks; otherwise report stale and stop. |
| GitHub and `origin/master` disagree | Re-fetch and re-audit. If still different, stop.                                                          |
| Release requested                   | Hand off to `release-workflow`.                                                                           |

## 3. Branch and commit

```bash
git switch -c feature/<slug>
git add <explicit paths>
git diff --cached
git commit
```

- Prefix types: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`.
- Stage explicit paths. Use `git add -A` only when every path is reviewed and
  belongs to this change.
- Read `git diff --cached` before every commit. One intent per commit.
- If unrelated work must wait, `git stash push -u -m "<label>"`; restore it with
  `git stash pop` before finishing.
- Never commit directly to `master`; `master` receives merges.

Completion criterion: `git status --short` is clean and the branch contains only
the intended commits.

## 4. Gates

Run on the exact tree being merged:

```bash
npm run typecheck
npm test
npm run docs:check
npm run eval:smoke
```

Fix failures and rerun. Do not merge a red tree.

Completion criterion: all four commands exit 0; record the test counts.

## 5. Merge to master

```bash
git switch master
git merge --ff-only <branch>
```

If fast-forward fails:

1. Compare both sides before merging:
   ```bash
   git log --oneline master..<branch>
   git log --oneline <branch>..master
   git diff --stat master...<branch>
   ```
2. If the branch is stale, duplicated by newer master work, or has no live
   change, stop and report it. Do not merge.
3. If it has live work, merge without fast-forward and resolve each conflict by
   intent. Preserve both sides; never use `-Xours`, `-Xtheirs`, or delete a
   change just to silence the conflict.
4. Rerun every gate from §4 after resolving.

Delete a merged local branch with `git branch -d <branch>`; never use `-D` on
an unmerged branch.

Completion criterion: `master` contains the intended commits, conflicts are
resolved deliberately, and gates are green on the merged tree.

## 6. Push gate

Show the pending work and ask:

```bash
git status -sb
git log --oneline origin/master..master
git diff --stat origin/master..master
```

> Push `master` to `origin/master`? (yes/no)

Only after an explicit yes:

```bash
git push origin master
```

Push tags only through `release-workflow`.

Verify the result:

```bash
git rev-parse --short master
git rev-parse --short origin/master
gh api repos/beast-ofcourse/atom-lite/commits/master --jq '.sha'
```

Completion criterion: local `master`, `origin/master`, and GitHub point at the
same commit; the working tree is clean; the push line is reported exactly.

## 7. Cleanup

- `git worktree list`; remove only clean, merged worktrees with
  `git worktree remove <path>`, then `git worktree prune`.
- If removal refuses, report it. Use `--force` only with explicit approval.
- Delete merged local branches with `git branch -d`. Keep unmerged branches and
  report them.
- Never leave a detached HEAD.

Completion criterion: no merged branch, stale worktree, or dirty path remains.

## Drift recovery

- Local `origin/master` stale: `git fetch origin`. Do not re-clone.
- Origin moved while working: merge `origin/master` into your branch, resolve,
  and rerun gates. Do not rewrite pushed commits.
- Suspected lost commits: compare counts in both directions before declaring
  loss.
- Accidental push to the wrong branch: stop, report the exact refs, and ask.
  Never rewrite.
- Dependabot PRs: leave untouched unless explicitly asked.

## Handoffs

- Version, changelog, tag, npm, GitHub release → `release-workflow`.
- Published docs or changelog edits → `atom-lite-docs`; run `docs:check`.
- Eval harness or grader changes → `eval-maintainer`; run `eval:smoke`.

## Completion report

End with the audit result, commands run, branch and commit SHAs, gate results,
push state, and anything deliberately left undone. Use command output as
evidence, not memory.
