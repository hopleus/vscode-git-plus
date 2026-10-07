# Installing Git Plus

Git Plus is a build of the Git extension that ships with VS Code, extended with changelists, hunk-level commits and history rewriting in the Source Control Graph. It uses proposed VS Code APIs, so it cannot be published to the Marketplace and is distributed as a `.vsix` file through [GitHub Releases](../../releases).

Requires VS Code 1.141 or newer and Git 2.25 or newer.

## Install

1. Download `vscode-git-plus-<version>.vsix` from the latest release.
2. Install it:
   ```bash
   code --install-extension vscode-git-plus-<version>.vsix
   ```
3. Allow the extension to use proposed APIs. Run **Preferences: Configure Runtime Arguments** from the Command Palette and add to `argv.json`:
   ```json
   "enable-proposed-api": ["hopleus.vscode-git-plus"]
   ```
4. Disable the built-in Git extension: open the Extensions view, search `@builtin git`, choose **Disable**. Running both would show every repository twice.
5. Restart VS Code.

## Update

Install the new `.vsix` over the old one with the same command and restart VS Code. Release builds check GitHub once a day and show a notification when a newer version is available. Turn the check off with the `gitPlus.checkForUpdates` setting. This is the only network request the extension makes besides your own git operations.

## Uninstall

Uninstall **Git Plus** from the Extensions view, remove the `enable-proposed-api` entry from `argv.json` and enable the built-in Git extension again.

## Build from source

```bash
npm ci && npm ci --prefix tools
npm run types --prefix tools
npm run typecheck --prefix tools
npm test --prefix tools
GIT_PLUS_VERSION=1.0.0 GIT_PLUS_REPOSITORY=<owner>/<repo> node tools/build.mjs --package --updater
```

The `.vsix` is written to `.build/`. Releases are built by `.github/workflows/release.yml` when a tag like `v1.0.0` is pushed; the update checker is added to the bundle at that step and is not part of `src/`.
