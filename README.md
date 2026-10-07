# Git+
**Git+** is a build of the Git extension that ships with VS Code, extended with:

- changelists: named groups of changes in Source Control, with hunk-level assignment
- commit of a single changelist without touching the index
- history rewriting in the Source Control Graph: edit message, squash, drop, reset, undo commit

It uses proposed VS Code APIs and is distributed as a `.vsix` through [GitHub Releases](../../releases). See [INSTALL.md](INSTALL.md) for installation and updates.

---

# Git integration for Visual Studio Code

**Notice:** This extension is bundled with Visual Studio Code. It can be disabled but not uninstalled.

## Features

See [Git support in VS Code](https://code.visualstudio.com/docs/editor/versioncontrol#_git-support) to learn about the features of this extension.

## API

The Git extension exposes an API, reachable by any other extension.

1. Copy `src/api/git.d.ts` to your extension's sources;
2. Include `git.d.ts` in your extension's compilation.
3. Get a hold of the API with the following snippet:

	```ts
	const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git').exports;
	const git = gitExtension.getAPI(1);
	```
	**Note:** To ensure that the `vscode.git` extension is activated before your extension, add `extensionDependencies` ([docs](https://code.visualstudio.com/api/references/extension-manifest)) into the `package.json` of your extension:
	```json
	"extensionDependencies": [
		"vscode.git"
	]
	```
