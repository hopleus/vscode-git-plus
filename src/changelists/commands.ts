/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { commands, Disposable, l10n, SourceControl, SourceControlResourceGroup, window } from 'vscode';
import type { Model } from '../model';
import { Repository, Resource, ResourceGroupType } from '../repository';
import { DEFAULT_CHANGELIST_ID, validateChangelistName } from './changelistStore';
import { changelistIdOfGroup } from './changelistGroups';

const UNVERSIONED_GROUP_ID = 'untracked';

function isGroup(arg: unknown): arg is SourceControlResourceGroup {
	return typeof arg === 'object' && arg !== null && 'id' in arg && 'resourceStates' in arg;
}

function isSourceControl(arg: unknown): arg is SourceControl {
	return typeof arg === 'object' && arg !== null && 'rootUri' in arg && 'createResourceGroup' in arg;
}

function isResource(arg: unknown): arg is Resource {
	return typeof arg === 'object' && arg !== null && 'resourceUri' in arg && 'resourceGroupType' in arg;
}

function toResources(args: unknown[]): Resource[] {
	return args.flatMap(arg => Array.isArray(arg) ? arg : [arg]).filter(isResource);
}

export interface ChangelistPrompts {
	showInputBox: typeof window.showInputBox;
	showQuickPick: typeof window.showQuickPick;
	showWarningMessage: typeof window.showWarningMessage;
	showInformationMessage: typeof window.showInformationMessage;
}

export interface ChangelistCommandHandlers {
	createChangelist(arg?: unknown): Promise<string | undefined>;
	renameChangelist(arg?: unknown): Promise<void>;
	deleteChangelist(arg?: unknown): Promise<void>;
	stageChangelist(arg?: unknown): Promise<void>;
	commitChangelist(arg?: unknown, postCommitCommand?: string): Promise<void>;
	moveChangelistFiles(arg?: unknown): Promise<void>;
	moveToChangelist(...args: unknown[]): Promise<void>;
}

const windowPrompts: ChangelistPrompts = window;

interface ListChoice {
	readonly label: string;
	readonly id?: string;
	readonly create?: boolean;
}

export function createChangelistCommands(model: Model, prompts: ChangelistPrompts = windowPrompts): ChangelistCommandHandlers {

	async function pickRepository(): Promise<Repository | undefined> {
		const repositories = model.repositories;

		if (repositories.length <= 1) {
			return repositories[0];
		}

		const picked = await prompts.showQuickPick(
			repositories.map(repository => ({ label: repository.root.split(/[\\/]/).pop() ?? repository.root, description: repository.root, repository })),
			{ placeHolder: l10n.t('Select a repository') }
		);

		return picked?.repository;
	}

	async function repositoryOf(arg: unknown): Promise<Repository | undefined> {
		if (isGroup(arg)) {
			return model.repositories.find(r => r.changelists.owns(arg));
		}

		if (isSourceControl(arg)) {
			return model.getRepository(arg);
		}

		if (isResource(arg)) {
			return model.getRepository(arg.resourceUri);
		}

		return pickRepository();
	}

	function askName(repository: Repository, title: string, value: string, ignoreId?: string): Thenable<string | undefined> {
		return prompts.showInputBox({
			title,
			value,
			validateInput: input => validateChangelistName(input, repository.changelists.store.getLists(), ignoreId)
		});
	}

	async function pickList(repository: Repository, options: { placeHolder: string; excludeDefault?: boolean; allowNew?: boolean; sources?: readonly string[] }): Promise<string | undefined> {
		const { store } = repository.changelists;
		const offered = options.sources ? store.moveTargets(options.sources) : store.getLists();
		const items: ListChoice[] = offered
			.filter(list => !(options.excludeDefault && list.id === DEFAULT_CHANGELIST_ID))
			.map(list => ({ label: list.name, id: list.id }));

		if (options.allowNew) {
			items.push({ label: l10n.t('$(add) New Changelist…'), create: true });
		}

		const picked = await prompts.showQuickPick(items, { placeHolder: options.placeHolder });

		if (!picked) {
			return undefined;
		}

		if (!picked.create) {
			return picked.id;
		}

		const name = await askName(repository, l10n.t('New Changelist'), '');
		return name === undefined ? undefined : store.create(name).id;
	}

	async function targetList(arg: unknown, placeHolder: string): Promise<{ repository: Repository; listId: string } | undefined> {
		const repository = await repositoryOf(arg);

		if (!repository) {
			return undefined;
		}

		const listId = (isGroup(arg) ? changelistIdOfGroup(arg.id) : undefined) ?? await pickList(repository, { placeHolder, excludeDefault: true });
		return listId ? { repository, listId } : undefined;
	}

	async function commitChangelist(arg?: unknown, postCommitCommand?: string): Promise<void> {
		const repository = await repositoryOf(arg);

		if (!repository) {
			return;
		}

		repository.changelists.presetList = isGroup(arg) ? changelistIdOfGroup(arg.id) : undefined;

		try {
			await commands.executeCommand('git.commit', repository.sourceControl, postCommitCommand);
		} finally {
			repository.changelists.presetList = undefined;
		}
	}

	async function pickFilesToMove(repository: Repository, resources: readonly Resource[], title: string): Promise<Resource[]> {
		const relative = (resource: Resource) => repository.changelists.relativePath(resource.resourceUri.fsPath);
		const items = resources.map(resource => ({ label: relative(resource).split('/').pop() ?? relative(resource), description: relative(resource), picked: true, resource }));
		const picked = await prompts.showQuickPick(items, {
			canPickMany: true,
			title,
			placeHolder: l10n.t('Select the files to move, then choose the target changelist'),
			matchOnDescription: true
		});

		return (picked ?? []).map(item => item.resource);
	}

	async function createChangelist(arg?: unknown): Promise<string | undefined> {
		const repository = await repositoryOf(arg);

		if (!repository) {
			return undefined;
		}

		const name = await askName(repository, l10n.t('New Changelist'), '');
		return name === undefined ? undefined : repository.changelists.store.create(name).id;
	}

	async function renameChangelist(arg?: unknown): Promise<void> {
		const target = await targetList(arg, l10n.t('Changelist to rename'));

		if (!target || target.listId === DEFAULT_CHANGELIST_ID) {
			return;
		}

		const { store } = target.repository.changelists;
		const current = store.getList(target.listId);

		if (!current) {
			return;
		}

		const name = await askName(target.repository, l10n.t('Rename Changelist'), current.name, current.id);

		if (name !== undefined) {
			store.rename(target.listId, name);
		}
	}

	async function deleteChangelist(arg?: unknown): Promise<void> {
		const target = await targetList(arg, l10n.t('Changelist to delete'));

		if (!target || target.listId === DEFAULT_CHANGELIST_ID) {
			return;
		}

		const { changelists } = target.repository;
		const list = changelists.store.getList(target.listId);

		if (!list) {
			return;
		}

		const count = changelists.resourcesIn(target.listId).length;

		if (count > 0) {
			const defaultName = changelists.store.getList(DEFAULT_CHANGELIST_ID)?.name;
			const deleteLabel = l10n.t('Delete');
			const answer = await prompts.showWarningMessage(
				l10n.t('Delete changelist "{0}"? {1} file(s) will be moved to "{2}".', list.name, count, defaultName ?? ''),
				{ modal: true },
				deleteLabel
			);

			if (answer !== deleteLabel) {
				return;
			}
		}

		changelists.deleteList(target.listId);
	}

	async function stageChangelist(arg?: unknown): Promise<void> {
		const repository = await repositoryOf(arg);

		if (repository && isGroup(arg)) {
			await repository.changelists.stageResources(repository, arg.resourceStates as Resource[]);
		}
	}

	async function moveChangelistFiles(arg?: unknown): Promise<void> {
		const repository = await repositoryOf(arg);

		if (!repository || !isGroup(arg)) {
			return;
		}

		const { changelists } = repository;
		const fromUnversioned = arg.id === UNVERSIONED_GROUP_ID;
		const sourceId = fromUnversioned ? UNVERSIONED_GROUP_ID : changelistIdOfGroup(arg.id);

		if (!sourceId) {
			return;
		}

		const resources = fromUnversioned ? arg.resourceStates as Resource[] : [...changelists.resourcesIn(sourceId)];

		if (resources.length === 0) {
			prompts.showInformationMessage(l10n.t('There are no files to move.'));
			return;
		}

		const title = fromUnversioned ? l10n.t('Move files from Untracked Changes') : l10n.t('Move files from "{0}"', changelists.store.getList(sourceId)?.name ?? '');
		const chosen = await pickFilesToMove(repository, resources, title);

		if (chosen.length === 0) {
			return;
		}

		const targetId = await pickList(repository, {
			placeHolder: l10n.t('Move {0} file(s) to changelist', chosen.length),
			allowNew: true,
			sources: fromUnversioned ? [] : [sourceId]
		});

		if (!targetId) {
			return;
		}

		await (fromUnversioned ? changelists.moveFiles(changelists.pathsOf(chosen), targetId) : changelists.moveResources(chosen, targetId));
	}

	async function moveToChangelist(...args: unknown[]): Promise<void> {
		const all = toResources(args);
		const tracked = all.filter(r => r.resourceGroupType === ResourceGroupType.WorkingTree);
		const unversioned = all.filter(r => r.resourceGroupType === ResourceGroupType.Untracked);
		const first = tracked[0] ?? unversioned[0];

		if (!first) {
			prompts.showInformationMessage(l10n.t('Select changed files in a changelist first.'));
			return;
		}

		const repository = model.getRepository(first.resourceUri);

		if (!repository) {
			return;
		}

		const { changelists } = repository;
		const sources = tracked.map(r => changelists.sourceListOf(r));
		const listId = await pickList(repository, { placeHolder: l10n.t('Move to changelist'), allowNew: true, sources });

		if (!listId) {
			return;
		}

		await changelists.moveResources(tracked, listId);
		await changelists.moveFiles(changelists.pathsOf(unversioned), listId);
	}

	return { createChangelist, renameChangelist, deleteChangelist, stageChangelist, commitChangelist, moveChangelistFiles, moveToChangelist };
}

export function registerChangelistCommands(model: Model): Disposable[] {
	const handlers = createChangelistCommands(model);

	return [
		commands.registerCommand('git.createChangelist', handlers.createChangelist),
		commands.registerCommand('git.renameChangelist', handlers.renameChangelist),
		commands.registerCommand('git.deleteChangelist', handlers.deleteChangelist),
		commands.registerCommand('git.stageChangelist', handlers.stageChangelist),
		commands.registerCommand('git.commitChangelist', (arg?: unknown) => handlers.commitChangelist(arg)),
		commands.registerCommand('git.commitChangelistAndPush', (arg?: unknown) => handlers.commitChangelist(arg, 'git.push')),
		commands.registerCommand('git.moveChangelistFiles', handlers.moveChangelistFiles),
		commands.registerCommand('git.moveToChangelist', handlers.moveToChangelist)
	];
}
