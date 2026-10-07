/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface HasId {
	readonly id: string;
}

export type ListSelectionMode = 'all' | 'partial' | 'none';

export interface ListSelection<T extends HasId> {
	readonly mode: ListSelectionMode;
	readonly hunks: T[];
}

export class HunkAssignments {

	private readonly byPath = new Map<string, Map<string, string>>();
	private readonly listeners = new Set<() => void>();

	hasOverrides(path: string): boolean {
		return (this.byPath.get(path)?.size ?? 0) > 0;
	}

	listOf(path: string, hunkId: string, homeListId: string): string {
		return this.byPath.get(path)?.get(hunkId) ?? homeListId;
	}

	assign(path: string, hunkId: string, listId: string, homeListId: string): void {
		const overrides = this.byPath.get(path) ?? new Map<string, string>();
		const current = overrides.get(hunkId) ?? homeListId;

		if (current === listId) {
			return;
		}

		if (listId === homeListId) {
			overrides.delete(hunkId);
		} else {
			overrides.set(hunkId, listId);
		}

		if (overrides.size === 0) {
			this.byPath.delete(path);
		} else {
			this.byPath.set(path, overrides);
		}

		this.emit();
	}

	removeList(listId: string): void {
		let changed = false;

		for (const [path, overrides] of [...this.byPath]) {
			for (const [hunkId, target] of [...overrides]) {
				if (target === listId) {
					overrides.delete(hunkId);
					changed = true;
				}
			}

			if (overrides.size === 0) {
				this.byPath.delete(path);
			}
		}

		if (changed) {
			this.emit();
		}
	}

	retainPaths(present: ReadonlySet<string>): void {
		let changed = false;

		for (const path of [...this.byPath.keys()]) {
			if (!present.has(path)) {
				this.byPath.delete(path);
				changed = true;
			}
		}

		if (changed) {
			this.emit();
		}
	}

	retainHunks(path: string, validIds: ReadonlySet<string>): void {
		const overrides = this.byPath.get(path);
		if (!overrides) {
			return;
		}

		let changed = false;
		for (const id of [...overrides.keys()]) {
			if (!validIds.has(id)) {
				overrides.delete(id);
				changed = true;
			}
		}

		if (overrides.size === 0) {
			this.byPath.delete(path);
		}

		if (changed) {
			this.emit();
		}
	}

	listsOf<T extends HasId>(path: string, hunks: readonly T[], homeListId: string): Map<string, T[]> {
		const result = new Map<string, T[]>();

		for (const hunk of hunks) {
			const list = this.listOf(path, hunk.id, homeListId);
			result.set(list, [...(result.get(list) ?? []), hunk]);
		}

		return result;
	}

	selectionFor<T extends HasId>(path: string, hunks: readonly T[], homeListId: string, listId: string): ListSelection<T> {
		const mine = hunks.filter(hunk => this.listOf(path, hunk.id, homeListId) === listId);

		if (mine.length === 0) {
			return { mode: 'none', hunks: [] };
		}

		return { mode: mine.length === hunks.length ? 'all' : 'partial', hunks: mine };
	}

	toJSON(): Record<string, Record<string, string>> {
		return Object.fromEntries([...this.byPath].map(([path, overrides]) => [path, Object.fromEntries(overrides)]));
	}

	load(raw: unknown): void {
		if (typeof raw !== 'object' || raw === null) {
			return;
		}

		for (const [path, value] of Object.entries(raw)) {
			if (typeof value !== 'object' || value === null) {
				continue;
			}

			const overrides = new Map<string, string>();
			for (const [hunkId, listId] of Object.entries(value)) {
				if (typeof listId === 'string') {
					overrides.set(hunkId, listId);
				}
			}

			if (overrides.size > 0) {
				this.byPath.set(path, overrides);
			}
		}
	}

	onDidChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(): void {
		for (const listener of [...this.listeners]) {
			listener();
		}
	}
}
