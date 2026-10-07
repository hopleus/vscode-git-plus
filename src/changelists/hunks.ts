/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface Hunk {
	readonly id: string;
	readonly oldStart: number;
	readonly oldLines: number;
	readonly newStart: number;
	readonly newLines: number;
	readonly header: string;
	readonly lines: string[];
}

export interface FileHunks {
	readonly path: string;
	readonly binary: boolean;
	readonly hunks: Hunk[];
}

export interface ChangedLines {
	readonly modifiedStartLineNumber: number;
	readonly modifiedEndLineNumber: number;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function toCount(raw: string | undefined): number {
	return raw === undefined ? 1 : Number(raw);
}

export function parseHunks(path: string, diff: string): FileHunks {
	const hunks: Hunk[] = [];
	let current: Hunk | undefined;

	for (const row of diff.split('\n')) {
		const match = HUNK_HEADER.exec(row);

		if (match) {
			const oldStart = Number(match[1]);
			const oldLines = toCount(match[2]);

			current = {
				id: `${oldStart},${oldLines}`,
				oldStart,
				oldLines,
				newStart: Number(match[3]),
				newLines: toCount(match[4]),
				header: row,
				lines: []
			};
			hunks.push(current);
		} else if (current && (row.startsWith('+') || row.startsWith('-') || row.startsWith('\\'))) {
			current.lines.push(row);
		}
	}

	const binary = hunks.length === 0 && /^Binary files /m.test(diff);
	return { path, binary, hunks };
}

export function buildPatch(path: string, hunks: readonly Hunk[]): string {
	const body = hunks.map(hunk => [hunk.header, ...hunk.lines].join('\n')).join('\n');
	return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${body}\n`;
}

export function hunkAtLines<T extends Pick<Hunk, 'newStart' | 'newLines'>>(hunks: readonly T[], change: ChangedLines): T | undefined {
	const deletion = change.modifiedEndLineNumber === 0;

	return hunks.find(hunk => {
		if (deletion) {
			return hunk.newLines === 0 && hunk.newStart === change.modifiedStartLineNumber;
		}

		const last = hunk.newStart + Math.max(hunk.newLines, 1) - 1;
		return hunk.newLines > 0 && hunk.newStart <= change.modifiedEndLineNumber && last >= change.modifiedStartLineNumber;
	});
}

export function unstagedHunks(all: readonly Hunk[], staged: readonly Hunk[]): Hunk[] {
	return all.filter(hunk => !staged.some(candidate =>
		candidate.id === hunk.id
		&& candidate.lines.length === hunk.lines.length
		&& candidate.lines.every((line, index) => line === hunk.lines[index])));
}
