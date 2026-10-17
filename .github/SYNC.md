# Upstream sync

This repo contains only `extensions/git` from [microsoft/vscode](https://github.com/microsoft/vscode),
with its history preserved.

## Branches

- `main` — my changes. Work here.
- `upstream` — clean copy of `extensions/git` from microsoft/vscode as of the latest VS Code **release**
  (the commit of `main` where that release branched off), not of the tip of `main`.
  Updated automatically by the `Sync from upstream` workflow. **Never commit to it manually.**

## Sync PRs

Every 3 days the workflow updates `upstream` and opens a PR `upstream → main`
if there are new changes.

The sync follows the latest VS Code release instead of `main`, so the code always matches the
released API types and the stable VS Code. `upstream` only moves forward: when the latest
release is older than the current `upstream`, the workflow does nothing until the next release.

The `Bump VS Code` workflow opens a PR that pins the latest release in `tools/config.json`
(`vscode`: API types and the VS Code used by the tests). The oldest VS Code the extension installs on is
`minVscode` in the same file; raise it by hand only when the code needs a newer API. Merge it before the sync PR of the same release.

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
