/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CodeLens, CodeLensProvider, commands, Disposable, EventEmitter, l10n, languages, Range, TextDocument, Uri, window, workspace } from 'vscode';
import type { Model } from '../model';
import type { Repository } from '../repository';
import { DEFAULT_CHANGELIST_ID, validateChangelistName } from './changelistStore';
import { PREVIEW_SCHEME } from './changelistGroups';
import { ChangedLines, Hunk, hunkAtLines } from './hunks';

const HUNK_CODE_LENS_SETTING = 'hunkCodeLens';

interface HunkArgs {
	readonly root: string;
	readonly path: string;
	readonly hunkId: string;
}

function lensLine(hunk: Hunk, lineCount: number): number {
	const line = hunk.newLines > 0 ? hunk.newStart - 1 : hunk.newStart;
	return Math.max(0, Math.min(line, lineCount - 1));
}

async function hunksOf(model: Model, document: TextDocument) {
	if (document.uri.scheme !== 'file') {
		return undefined;
	}

	const repository = model.getRepository(document.uri);

	if (!repository) {
		return undefined;
	}

	const rel = repository.changelists.relativePath(document.uri.fsPath);
	const file = await repository.changelists.fileHunks(rel).catch(() => undefined);

	if (!file || file.binary || file.hunks.length === 0) {
		return undefined;
	}

	return { repository, rel, file };
}

export class HunkCodeLensProvider implements CodeLensProvider, Disposable {

	private readonly emitter = new EventEmitter<void>();
	readonly onDidChangeCodeLenses = this.emitter.event;

	constructor(private readonly model: Model) { }

	refresh(): void {
		this.emitter.fire();
	}

	async provideCodeLenses(document: TextDocument): Promise<CodeLens[]> {
		if (!workspace.getConfiguration('git').get<boolean>(HUNK_CODE_LENS_SETTING, true)) {
			return [];
		}

		const found = await hunksOf(this.model, document);

		if (!found) {
			return [];
		}

		const { repository, rel, file } = found;
		const { store } = repository.changelists;

		return file.hunks.map((hunk, index) => {
			const listId = repository.changelists.hunkListOf(rel, hunk.id);
			const name = store.getList(listId)?.name ?? store.getList(DEFAULT_CHANGELIST_ID)?.name;
			const line = lensLine(hunk, document.lineCount);
			const args: HunkArgs = { root: repository.root, path: rel, hunkId: hunk.id };

			return new CodeLens(new Range(line, 0, line, 0), {
				title: `$(list-unordered) ${name} (${index + 1}/${file.hunks.length})`,
				tooltip: l10n.t('Changelist of this change. Click to move it to another changelist'),
				command: 'git.moveHunkToChangelist',
				arguments: [args]
			});
		});
	}

	dispose(): void {
		this.emitter.dispose();
	}
}

async function pickTargetList(repository: Repository, currentId: string): Promise<string | undefined> {
	const { store } = repository.changelists;
	const items: { label: string; id?: string; create?: boolean }[] = store.getLists()
		.filter(list => list.id !== currentId)
		.map(list => ({ label: list.name, id: list.id }));

	items.push({ label: l10n.t('$(add) New Changelist…'), create: true });

	const picked = await window.showQuickPick(items, { placeHolder: l10n.t('Move change to changelist') });

	if (!picked) {
		return undefined;
	}

	if (!picked.create) {
		return picked.id;
	}

	const name = await window.showInputBox({
		title: l10n.t('New Changelist'),
		validateInput: input => validateChangelistName(input, store.getLists())
	});

	return name === undefined ? undefined : store.create(name).id;
}

export function registerHunkUi(model: Model): Disposable[] {
	const lens = new HunkCodeLensProvider(model);
	const previewChanged = new EventEmitter<Uri>();
	const previewed = new Set<string>();
	const watched = new Set<Repository>();

	const watch = (repository: Repository) => {
		if (watched.has(repository)) {
			return;
		}

		watched.add(repository);
		repository.changelists.onDidChange(() => {
			lens.refresh();

			for (const uri of previewed) {
				previewChanged.fire(Uri.parse(uri));
			}
		});
	};

	model.repositories.forEach(watch);
	const opened = model.onDidOpenRepository(watch);

	async function moveHunk(repository: Repository, rel: string, hunkId: string): Promise<void> {
		const target = await pickTargetList(repository, repository.changelists.hunkListOf(rel, hunkId));

		if (target) {
			repository.changelists.moveHunk(rel, hunkId, target);
		}
	}

	async function moveHunkToChangelist(args?: HunkArgs): Promise<void> {
		const repository = model.repositories.find(r => r.root === args?.root);

		if (args && repository) {
			await moveHunk(repository, args.path, args.hunkId);
		}
	}

	async function moveChangeToChangelist(uri?: Uri, changes?: ChangedLines[], index?: number): Promise<void> {
		const change = changes?.[index ?? 0];
		const repository = uri && model.getRepository(uri);

		if (!uri || !change || !repository) {
			return;
		}

		const rel = repository.changelists.relativePath(uri.fsPath);
		const hunk = hunkAtLines((await repository.changelists.fileHunks(rel))?.hunks ?? [], change);

		if (!hunk) {
			window.showInformationMessage(l10n.t('This change is not part of a tracked hunk yet. Save the file and try again.'));
			return;
		}

		await moveHunk(repository, rel, hunk.id);
	}

	async function moveHunkAtCursorToChangelist(): Promise<void> {
		const editor = window.activeTextEditor;
		const found = editor && await hunksOf(model, editor.document);

		if (!editor || !found) {
			window.showInformationMessage(l10n.t('There is no changed hunk in this file.'));
			return;
		}

		const line = editor.selection.active.line + 1;
		const hunk = found.file.hunks.find(h => line >= h.newStart && line <= Math.max(h.newStart, h.newStart + h.newLines - 1));

		if (!hunk) {
			window.showInformationMessage(l10n.t('There is no changed hunk at the cursor.'));
			return;
		}

		await moveHunk(found.repository, found.rel, hunk.id);
	}

	return [
		lens,
		previewChanged,
		opened,
		workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, {
			onDidChange: previewChanged.event,
			provideTextDocumentContent: async uri => {
				previewed.add(uri.toString());
				const { root, listId } = JSON.parse(uri.query) as { root: string; listId: string };
				const repository = model.repositories.find(r => r.root === root);
				return repository ? repository.changelists.previewContent(uri.path.slice(1), listId) : '';
			}
		}),
		languages.registerCodeLensProvider({ scheme: 'file' }, lens),
		commands.registerCommand('git.moveHunkToChangelist', moveHunkToChangelist),
		commands.registerCommand('git.moveChangeToChangelist', moveChangeToChangelist),
		commands.registerCommand('git.moveHunkAtCursorToChangelist', moveHunkAtCursorToChangelist)
	];
}
