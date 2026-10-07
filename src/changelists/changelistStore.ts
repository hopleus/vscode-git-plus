/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'crypto';

export const DEFAULT_CHANGELIST_ID = 'default';

const SNAPSHOT_VERSION = 1;

export interface Changelist {
	readonly id: string;
	name: string;
}

export interface ChangeRef {
	readonly path: string;
	readonly origPath?: string;
}

export interface ChangelistSnapshot {
	readonly version: number;
	readonly lists: Changelist[];
	readonly assignments: Record<string, string>;
}

export class ChangelistError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ChangelistError';
	}
}

export function validateChangelistName(name: string, existing: readonly Changelist[], ignoreId?: string): string | undefined {
	const trimmed = name.trim();
	if (trimmed.length === 0) {
		return 'Name must not be empty';
	}

	const clash = existing.some(list => list.id !== ignoreId && list.name.toLowerCase() === trimmed.toLowerCase());
	return clash ? 'A changelist with this name already exists' : undefined;
}

export class ChangelistStore {

	private readonly lists = new Map<string, Changelist>();
	private readonly assignments = new Map<string, string>();
	private readonly listeners = new Set<() => void>();

	constructor(
		defaultName: string,
		snapshot?: unknown,
		private readonly newId: () => string = randomUUID
	) {
		this.lists.set(DEFAULT_CHANGELIST_ID, { id: DEFAULT_CHANGELIST_ID, name: defaultName });

		if (snapshot !== undefined) {
			this.restore(snapshot, defaultName);
		}
	}

	onDidChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	getLists(): Changelist[] {
		return [...this.lists.values()];
	}

	getList(id: string): Changelist | undefined {
		return this.lists.get(id);
	}

	listOf(path: string): string | undefined {
		return this.assignments.get(path);
	}

	create(name: string): Changelist {
		const error = validateChangelistName(name, this.getLists());
		if (error) {
			throw new ChangelistError(error);
		}

		const list: Changelist = { id: this.newId(), name: name.trim() };
		this.lists.set(list.id, list);
		this.emit();
		return list;
	}

	rename(id: string, name: string): void {
		const list = this.require(id);
		const error = validateChangelistName(name, this.getLists(), id);
		if (error) {
			throw new ChangelistError(error);
		}

		if (list.name === name.trim()) {
			return;
		}

		list.name = name.trim();
		this.emit();
	}

	setDefaultName(name: string): void {
		const list = this.require(DEFAULT_CHANGELIST_ID);
		const trimmed = name.trim();
		const clash = this.getLists().some(l => l.id !== DEFAULT_CHANGELIST_ID && l.name.toLowerCase() === trimmed.toLowerCase());

		if (trimmed.length === 0 || list.name === trimmed || clash) {
			return;
		}

		list.name = trimmed;
		this.emit();
	}

	delete(id: string): string[] {
		if (id === DEFAULT_CHANGELIST_ID) {
			throw new ChangelistError('The default changelist cannot be deleted');
		}

		this.require(id);

		const moved: string[] = [];
		for (const [path, listId] of this.assignments) {
			if (listId === id) {
				this.assignments.set(path, DEFAULT_CHANGELIST_ID);
				moved.push(path);
			}
		}

		this.lists.delete(id);
		this.emit();
		return moved;
	}

	move(paths: readonly string[], listId: string): number {
		this.require(listId);

		let moved = 0;
		for (const path of paths) {
			const current = this.assignments.get(path);
			if (current === undefined || current === listId) {
				continue;
			}

			this.assignments.set(path, listId);
			moved++;
		}

		if (moved > 0) {
			this.emit();
		}

		return moved;
	}

	moveTargets(sourceListIds: readonly string[]): Changelist[] {
		return this.getLists().filter(list => sourceListIds.length === 0 || sourceListIds.some(id => id !== list.id));
	}

	reconcile(changes: readonly ChangeRef[]): boolean {
		let changed = false;
		const present = new Set<string>();

		for (const change of changes) {
			present.add(change.path);

			if (this.assignments.has(change.path)) {
				continue;
			}

			const inherited = change.origPath ? this.assignments.get(change.origPath) : undefined;
			const target = inherited !== undefined && this.lists.has(inherited) ? inherited : DEFAULT_CHANGELIST_ID;
			this.assignments.set(change.path, target);
			changed = true;
		}

		for (const path of [...this.assignments.keys()]) {
			if (!present.has(path)) {
				this.assignments.delete(path);
				changed = true;
			}
		}

		if (changed) {
			this.emit();
		}

		return changed;
	}

	group<T extends ChangeRef>(changes: readonly T[]): Map<string, T[]> {
		const byList = new Map<string, T[]>();
		for (const list of this.lists.values()) {
			byList.set(list.id, []);
		}

		for (const change of changes) {
			byList.get(this.assignments.get(change.path) ?? DEFAULT_CHANGELIST_ID)!.push(change);
		}

		return byList;
	}

	toSnapshot(): ChangelistSnapshot {
		return {
			version: SNAPSHOT_VERSION,
			lists: this.getLists().map(list => ({ ...list })),
			assignments: Object.fromEntries(this.assignments)
		};
	}

	private restore(raw: unknown, defaultName: string): void {
		if (typeof raw !== 'object' || raw === null) {
			return;
		}

		const snapshot = raw as Partial<ChangelistSnapshot>;
		if (snapshot.version !== SNAPSHOT_VERSION) {
			return;
		}

		if (Array.isArray(snapshot.lists)) {
			for (const list of snapshot.lists) {
				if (typeof list?.id !== 'string' || typeof list.name !== 'string' || list.id === DEFAULT_CHANGELIST_ID) {
					continue;
				}

				this.lists.set(list.id, { id: list.id, name: list.name });
			}
		}

		this.lists.get(DEFAULT_CHANGELIST_ID)!.name = defaultName;

		if (snapshot.assignments && typeof snapshot.assignments === 'object') {
			for (const [path, listId] of Object.entries(snapshot.assignments)) {
				if (typeof listId === 'string' && this.lists.has(listId)) {
					this.assignments.set(path, listId);
				}
			}
		}
	}

	private require(id: string): Changelist {
		const list = this.lists.get(id);
		if (!list) {
			throw new ChangelistError(`Unknown changelist: ${id}`);
		}

		return list;
	}

	private emit(): void {
		for (const listener of [...this.listeners]) {
			listener();
		}
	}
}
