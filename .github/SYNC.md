# Upstream sync

This repo contains only `extensions/git` from [microsoft/vscode](https://github.com/microsoft/vscode),
with its history preserved.

## Branches

- `main` — my changes. Work here.
- `upstream` — clean copy of `extensions/git` from microsoft/vscode.
  Updated automatically by the `Sync from upstream` workflow. **Never commit to it manually.**

## Sync PRs

Every 3 days the workflow updates `upstream` and opens a PR `upstream → main`
if there are new changes.

- Merge only with **Create a merge commit**. Squash or rebase will break the sync.
- Do not delete the `upstream` branch after merging.

## Resolving conflicts

If the sync PR has conflicts, resolve them locally:

```bash
git fetch origin
git checkout main
git merge origin/upstream
# fix conflicts, then:
git add .
git commit
git push
```

The PR will close automatically.

## If the workflow fails on "Update upstream branch"

The filtered history no longer matches the `upstream` branch.
Do not force-push anything — investigate first.
