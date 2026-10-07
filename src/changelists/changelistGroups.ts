/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { commands, EventEmitter, l10n, Memento, SourceControlResourceGroup, Uri, window, workspace } from 'vscode';
import { Status } from '../api/git.constants';
import { CommitSelection, Repository as BaseRepository, SelectionIndex, SelectionPatch } from '../git';
import type { Repository, Resource } from '../repository';
import { toGitUri } from '../uri';
import { ChangelistStore, ChangeRef, DEFAULT_CHANGELIST_ID } from './changelistStore';
import { HunkAssignments } from './hunkAssignments';
import { buildPatch, FileHunks, parseHunks, unstagedHunks } from './hunks';

const CUSTOM_GROUP_PREFIX = 'changelist:';
const SAVE_DEBOUNCE_MS = 400;
const STATE_KEY = 'git.changelists.v1';

export const PREVIEW_SCHEME = 'git-changelist';

export interface ChangelistGroupsHost {
	readonly root: string;
	readonly git: BaseRepository;
	readonly workspaceState: Memento;
	defaultGroup(): SourceControlResourceGroup;
	untrackedGroup(): SourceControlResourceGroup;
	createGroup(id: string, label: string): SourceControlResourceGroup;
	recreateUntrackedGroup(): void;
	asUntracked(resource: Resource): Resource;
	applyDistribution(): void;
	operationInProgress(): boolean;
	refreshStatus(): Promise<void>;
}

export interface Distribution {
	readonly workingTree: Resource[];
	readonly untracked: Resource[];
}

export type CommitMode = 'cancel' | 'upstream' | 'changelist';

interface ListedResource extends Resource {
	changelistId?: string;
}

interface ResolvedHunks {
	readonly revision: number;
	readonly file: FileHunks;
}

export function customGroupId(listId: string): string {
	return `${CUSTOM_GROUP_PREFIX}${listId}`;
}

export function changelistIdOfGroup(groupId: string): string | undefined {
	if (groupId === 'workingTree') {
		return DEFAULT_CHANGELIST_ID;
	}

	return groupId.startsWith(CUSTOM_GROUP_PREFIX) ? groupId.slice(CUSTOM_GROUP_PREFIX.length) : undefined;
}

function trimTrailingSlash(value: string): string {
	return value.endsWith('/') ? value.slice(0, -1) : value;
}

export class ChangelistGroups {

	readonly store: ChangelistStore;
	readonly assignments = new HunkAssignments();
	presetList: string | undefined;

	private workingTree: Resource[] = [];
	private untracked: Resource[] = [];
	private readonly groups = new Map<string, SourceControlResourceGroup>();
	private layout = '';
	private saveTimer: NodeJS.Timeout | undefined;
	private plan: CommitSelection | undefined;
	private revision = 0;
	private readonly inFlight = new Map<string, { revision: number; promise: Promise<FileHunks> }>();
	private readonly resolved = new Map<string, ResolvedHunks>();
	private readonly emitter = new EventEmitter<void>();
	private readonly cleanups: (() => void)[];

	readonly onDidChange = this.emitter.event;

	constructor(private readonly host: ChangelistGroupsHost) {
		const snapshot = host.workspaceState.get<Record<string, unknown>>(STATE_KEY, {})[host.root];
		this.store = new ChangelistStore(this.configuredDefaultName(), snapshot);

		if (typeof snapshot === 'object' && snapshot !== null && 'hunks' in snapshot) {
			this.assignments.load(snapshot.hunks);
		}

		const onChange = () => {
			this.scheduleSave();
			this.host.applyDistribution();
		};
		const onSetting = workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('git.defaultChangelistName')) {
				this.store.setDefaultName(this.configuredDefaultName());
			}
		});

		this.cleanups = [this.store.onDidChange(onChange), this.assignments.onDidChange(onChange), () => onSetting.dispose()];
	}

	get workingTreeResources(): readonly Resource[] {
		return this.workingTree;
	}

	get untrackedResources(): readonly Resource[] {
		return this.untracked;
	}

	get hasPlan(): boolean {
		return this.plan !== undefined;
	}

	private configuredDefaultName(): string {
		return workspace.getConfiguration('git').get<string>('defaultChangelistName', l10n.t('Changes'));
	}

	input(workingTree: Resource[] | undefined, untracked: Resource[] | undefined): void {
		if (workingTree) {
			this.workingTree = workingTree;
			this.revision++;
		}

		if (untracked) {
			this.untracked = untracked;
		}
	}

	distribute(): Distribution {
		const tracked = this.workingTree.filter(r => r.type !== Status.UNTRACKED);
		const movedToUntracked = this.workingTree
			.filter(r => r.type === Status.UNTRACKED)
			.map(r => this.host.asUntracked(r));

		this.store.reconcile(tracked.map(r => this.refOf(r)));
		this.assignments.retainPaths(new Set(tracked.map(r => this.relative(r.resourceUri.fsPath))));
		this.syncLayout();

		const perList = new Map<string, Resource[]>(this.store.getLists().map(l => [l.id, []]));

		for (const resource of tracked) {
			const listIds = this.listsOfResource(resource);

			for (const listId of listIds) {
				const copy: ListedResource = listIds.length === 1 ? resource : resource.clone();
				copy.changelistId = listId;

				if (listIds.length > 1) {
					this.openFilteredDiffOnClick(copy, listId);
				}

				perList.get(listId)!.push(copy);
			}
		}

		for (const list of this.store.getLists()) {
			if (list.id === DEFAULT_CHANGELIST_ID) {
				this.host.defaultGroup().label = list.name;
				continue;
			}

			const group = this.groups.get(list.id)!;
			group.label = list.name;
			group.resourceStates = perList.get(list.id) ?? [];
		}

		this.emitter.fire();

		const untrackedKeys = new Set(movedToUntracked.map(r => r.resourceUri.toString()));
		const untrackedOthers = this.untracked.filter(r => !untrackedKeys.has(r.resourceUri.toString()));

		return { workingTree: perList.get(DEFAULT_CHANGELIST_ID) ?? [], untracked: [...untrackedOthers, ...movedToUntracked] };
	}

	private openFilteredDiffOnClick(resource: Resource, listId: string): void {
		const rel = this.relative(resource.resourceUri.fsPath);
		const listName = this.store.getList(listId)?.name ?? '';
		const command = {
			command: 'vscode.diff',
			title: l10n.t('Open'),
			arguments: [toGitUri(resource.resourceUri, 'HEAD'), this.previewUri(rel, listId), `${path.basename(rel)} (${listName})`, { preview: true }]
		};

		Object.defineProperty(resource, 'command', { configurable: true, get: () => command });
		Object.defineProperty(resource, 'openChange', {
			configurable: true,
			value: () => commands.executeCommand(command.command, ...command.arguments)
		});
	}

	previewUri(rel: string, listId: string): Uri {
		return Uri.from({ scheme: PREVIEW_SCHEME, path: `/${rel}`, query: JSON.stringify({ root: this.host.root, listId }) });
	}

	async previewContent(rel: string, listId: string): Promise<string> {
		const file = await this.fileHunks(rel);

		if (!file) {
			return '';
		}

		const part = this.assignments.selectionFor(rel, file.hunks, DEFAULT_CHANGELIST_ID, listId);
		return this.host.git.showWithPatch(rel, part.hunks.length > 0 ? buildPatch(rel, part.hunks) : undefined);
	}

	isSplit(rel: string): boolean {
		return this.assignments.hasOverrides(rel);
	}

	private listsOfResource(resource: Resource): string[] {
		const rel = this.relative(resource.resourceUri.fsPath);
		const home = this.homeOf(resource, rel);

		if (resource.type !== Status.MODIFIED || !this.assignments.hasOverrides(rel)) {
			return [home];
		}

		const file = this.knownHunks(rel);

		if (!file) {
			return [home];
		}

		const existing = new Set(this.store.getLists().map(l => l.id));
		const lists = [...this.assignments.listsOf(rel, file.hunks, home).keys()].filter(id => existing.has(id));

		return lists.length > 0 ? lists : [home];
	}

	private homeOf(resource: Resource, rel: string): string {
		return resource.type === Status.MODIFIED ? DEFAULT_CHANGELIST_ID : (this.store.listOf(rel) ?? DEFAULT_CHANGELIST_ID);
	}

	private knownHunks(rel: string): FileHunks | undefined {
		const known = this.resolved.get(rel);

		if (!known || known.revision !== this.revision) {
			this.fileHunks(rel).then(() => this.host.applyDistribution(), () => undefined);
		}

		return known?.file;
	}

	resourcesIn(listId: string): readonly Resource[] {
		if (listId === DEFAULT_CHANGELIST_ID) {
			return this.host.defaultGroup().resourceStates as Resource[];
		}

		return (this.groups.get(listId)?.resourceStates as Resource[] | undefined) ?? [];
	}

	groupOfList(listId: string): SourceControlResourceGroup | undefined {
		return listId === DEFAULT_CHANGELIST_ID ? this.host.defaultGroup() : this.groups.get(listId);
	}

	sourceListOf(resource: Resource): string {
		return (resource as ListedResource).changelistId ?? this.homeOf(resource, this.relative(resource.resourceUri.fsPath));
	}

	async moveResources(resources: readonly Resource[], targetId: string): Promise<void> {
		const wholeFiles: string[] = [];

		for (const resource of resources) {
			const rel = this.relative(resource.resourceUri.fsPath);
			const source = this.sourceListOf(resource);
			const file = resource.type === Status.MODIFIED ? await this.fileHunks(rel).catch(() => undefined) : undefined;

			if (!file || file.binary || file.hunks.length === 0) {
				wholeFiles.push(rel);
				continue;
			}

			for (const hunk of file.hunks.filter(h => this.assignments.listOf(rel, h.id, DEFAULT_CHANGELIST_ID) === source)) {
				this.assignments.assign(rel, hunk.id, targetId, DEFAULT_CHANGELIST_ID);
			}
		}

		this.store.move(wholeFiles, targetId);
	}

	async moveFiles(paths: readonly string[], targetId: string): Promise<void> {
		const unversioned = new Set(this.unversionedResources().map(r => this.relative(r.resourceUri.fsPath)));
		const isUnversioned = (p: string) => unversioned.has(trimTrailingSlash(p)) || [...unversioned].some(u => u.startsWith(`${trimTrailingSlash(p)}/`));
		const untracked = paths.filter(isUnversioned);

		if (untracked.length > 0) {
			await this.host.git.addIntentToAdd(untracked);
			await this.host.refreshStatus();
		}

		await this.moveResources(paths.flatMap(p => this.resourcesAt(trimTrailingSlash(p))), targetId);
	}

	private unversionedResources(): Resource[] {
		return [...this.untracked, ...this.workingTree.filter(r => r.type === Status.UNTRACKED)];
	}

	private resourcesAt(rel: string): Resource[] {
		const exact = this.findResource(rel);

		if (exact) {
			return [exact];
		}

		return this.listedResources().filter(r => this.relative(r.resourceUri.fsPath).startsWith(`${rel}/`));
	}

	private listedResources(): Resource[] {
		return [this.host.defaultGroup().resourceStates as Resource[], ...[...this.groups.values()].map(g => g.resourceStates as Resource[])].flat();
	}

	moveHunk(rel: string, hunkId: string, targetId: string): void {
		this.assignments.assign(rel, hunkId, targetId, DEFAULT_CHANGELIST_ID);
	}

	hunkListOf(rel: string, hunkId: string): string {
		return this.assignments.listOf(rel, hunkId, DEFAULT_CHANGELIST_ID);
	}

	deleteList(listId: string): void {
		this.assignments.removeList(listId);
		this.store.delete(listId);
	}

	async stageResources(repository: Repository, resources: readonly Resource[]): Promise<void> {
		const wholeFiles: Resource[] = [];

		for (const resource of resources) {
			const rel = this.relative(resource.resourceUri.fsPath);
			const file = resource.type === Status.MODIFIED && this.assignments.hasOverrides(rel)
				? await this.fileHunks(rel).catch(() => undefined)
				: undefined;

			if (!file || file.binary || file.hunks.length === 0) {
				wholeFiles.push(resource);
				continue;
			}

			const part = this.assignments.selectionFor(rel, file.hunks, DEFAULT_CHANGELIST_ID, this.sourceListOf(resource));

			if (part.mode === 'all') {
				wholeFiles.push(resource);
			} else if (part.mode === 'partial') {
				await this.host.git.applyPatchToIndex(buildPatch(rel, part.hunks));
			}
		}

		if (wholeFiles.length > 0) {
			await repository.add(wholeFiles.map(r => r.resourceUri));
		}

		await repository.status();
	}

	async beginCommit(opts: { amend?: boolean }): Promise<CommitMode> {
		const listId = this.presetList;
		this.presetList = undefined;
		this.plan = undefined;

		if (listId === undefined || this.host.operationInProgress()) {
			return 'upstream';
		}

		const selection = await this.selectionOf(listId);

		if (selection.paths.length === 0 && selection.patches.length === 0 && !opts.amend) {
			window.showInformationMessage(l10n.t('There is nothing to commit in this changelist.'));
			return 'cancel';
		}

		this.plan = selection;
		return 'changelist';
	}

	async prepareIndex(): Promise<SelectionIndex | undefined> {
		const plan = this.plan;
		this.plan = undefined;

		return plan ? this.host.git.createSelectionIndex(plan) : undefined;
	}

	async afterCommit(index: SelectionIndex | undefined): Promise<void> {
		if (index && index.touched.length > 0) {
			await this.host.git.resetIndexPaths([...index.touched]).catch(() => undefined);
		}
	}

	private async selectionOf(listId: string): Promise<CommitSelection> {
		const paths = new Set<string>();
		const patches: SelectionPatch[] = [];

		for (const resource of this.resourcesIn(listId)) {
			const rel = this.relative(resource.resourceUri.fsPath);
			const home = this.homeOf(resource, rel);
			const file = this.assignments.hasOverrides(rel) && resource.type === Status.MODIFIED
				? await this.fileHunks(rel).catch(() => undefined)
				: undefined;

			if (file && !file.binary && file.hunks.length > 0) {
				const part = this.assignments.selectionFor(rel, file.hunks, home, listId);

				if (part.mode === 'all') {
					paths.add(rel);
				} else if (part.mode === 'partial') {
					patches.push({ path: rel, patch: buildPatch(rel, part.hunks) });
				}

				continue;
			}

			paths.add(rel);

			if (resource.renameResourceUri) {
				paths.add(this.relative(resource.original.fsPath));
			}
		}

		return { paths: [...paths], patches };
	}

	relativePath(fsPath: string): string {
		return this.relative(fsPath);
	}

	pathsOf(resources: readonly Resource[]): string[] {
		return resources.map(r => this.relative(r.resourceUri.fsPath));
	}

	fileHunks(rel: string): Promise<FileHunks | undefined> {
		const resource = this.findResource(rel);

		if (!resource || resource.type !== Status.MODIFIED) {
			return Promise.resolve(undefined);
		}

		const pending = this.inFlight.get(rel);

		if (pending && pending.revision === this.revision) {
			return pending.promise;
		}

		const revision = this.revision;
		const promise = Promise.all([this.host.git.getHunksDiff(rel), this.host.git.getHunksDiff(rel, { cached: true })]).then(([all, staged]) => {
			const parsed = parseHunks(rel, all);
			this.assignments.retainHunks(rel, new Set(parsed.hunks.map(h => h.id)));

			const file: FileHunks = { ...parsed, hunks: unstagedHunks(parsed.hunks, parseHunks(rel, staged).hunks) };
			this.resolved.set(rel, { revision, file });
			return file;
		});

		this.inFlight.set(rel, { revision, promise });
		promise.catch(() => this.inFlight.delete(rel));

		return promise;
	}

	findResource(rel: string): Resource | undefined {
		return this.listedResources().find(r => this.relative(r.resourceUri.fsPath) === rel);
	}

	owns(group: SourceControlResourceGroup): boolean {
		return this.host.defaultGroup() === group || this.host.untrackedGroup() === group || [...this.groups.values()].includes(group);
	}

	customResourceCount(): number {
		let count = 0;

		for (const group of this.groups.values()) {
			count += group.resourceStates.length;
		}

		return count;
	}

	private syncLayout(): void {
		const customIds = this.store.getLists().filter(l => l.id !== DEFAULT_CHANGELIST_ID).map(l => l.id);
		const layout = customIds.join('|');

		if (layout === this.layout) {
			return;
		}

		this.layout = layout;

		for (const group of this.groups.values()) {
			group.dispose();
		}

		this.groups.clear();

		for (const id of customIds) {
			const group = this.host.createGroup(customGroupId(id), id);
			group.hideWhenEmpty = false;
			this.groups.set(id, group);
		}

		this.host.recreateUntrackedGroup();
	}

	private refOf(resource: Resource): ChangeRef {
		const current = this.relative(resource.resourceUri.fsPath);
		const origin = resource.renameResourceUri ? this.relative(resource.original.fsPath) : undefined;

		return { path: current, origPath: origin !== current ? origin : undefined };
	}

	private relative(fsPath: string): string {
		return path.relative(this.host.root, fsPath).split(path.sep).join('/');
	}

	private scheduleSave(): void {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
		}

		this.saveTimer = setTimeout(() => this.flush(), SAVE_DEBOUNCE_MS);
	}

	flush(): void {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = undefined;
		}

		const stored = { ...this.host.workspaceState.get<Record<string, unknown>>(STATE_KEY, {}) };
		stored[this.host.root] = { ...this.store.toSnapshot(), hunks: this.assignments.toJSON() };
		this.host.workspaceState.update(STATE_KEY, stored);
	}

	dispose(): void {
		this.flush();
		this.cleanups.forEach(cleanup => cleanup());
		this.emitter.dispose();

		for (const group of this.groups.values()) {
			group.dispose();
		}

		this.groups.clear();
	}
}
