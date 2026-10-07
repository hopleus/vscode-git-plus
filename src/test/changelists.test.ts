/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import { ChangelistError, ChangelistStore, ChangeRef, DEFAULT_CHANGELIST_ID } from '../changelists/changelistStore';
import { HunkAssignments } from '../changelists/hunkAssignments';
import { buildPatch, hunkAtLines, parseHunks, unstagedHunks } from '../changelists/hunks';

suite('changelists', () => {

	suite('ChangelistStore', () => {
		let counter = 0;
		const store = (snapshot?: unknown, name = 'Changes') => new ChangelistStore(name, snapshot, () => `id${++counter}`);
		const change = (path: string, origPath?: string): ChangeRef => ({ path, origPath });

		test('starts with the default list only', () => {
			assert.deepStrictEqual(store().getLists(), [{ id: DEFAULT_CHANGELIST_ID, name: 'Changes' }]);
		});

		test('assigns new changes to the default list and keeps existing assignments', () => {
			const s = store();
			s.reconcile([change('a'), change('b')]);
			const feature = s.create('Feature');
			s.move(['b'], feature.id);
			s.reconcile([change('a'), change('b'), change('c')]);

			assert.strictEqual(s.listOf('a'), DEFAULT_CHANGELIST_ID);
			assert.strictEqual(s.listOf('b'), feature.id);
			assert.strictEqual(s.listOf('c'), DEFAULT_CHANGELIST_ID);
		});

		test('drops assignments for files that left the status', () => {
			const s = store();
			s.reconcile([change('a'), change('b')]);

			assert.strictEqual(s.reconcile([change('b')]), true);
			assert.strictEqual(s.listOf('a'), undefined);
		});

		test('reports no change when nothing differs', () => {
			const s = store();
			s.reconcile([change('a')]);
			assert.strictEqual(s.reconcile([change('a')]), false);
		});

		test('moves files between lists and ignores unknown paths', () => {
			const s = store();
			s.reconcile([change('a'), change('b')]);
			const list = s.create('L');

			assert.strictEqual(s.move(['a', 'unknown'], list.id), 1);
			assert.strictEqual(s.listOf('a'), list.id);
			assert.strictEqual(s.move(['a'], list.id), 0);
			assert.throws(() => s.move(['a'], 'nope'), ChangelistError);
		});

		test('moves files of a deleted list to the default', () => {
			const s = store();
			const list = s.create('L');
			s.reconcile([change('a'), change('b')]);
			s.move(['a'], list.id);

			assert.deepStrictEqual(s.delete(list.id), ['a']);
			assert.strictEqual(s.listOf('a'), DEFAULT_CHANGELIST_ID);
			assert.strictEqual(s.getList(list.id), undefined);
		});

		test('refuses to delete the default list', () => {
			assert.throws(() => store().delete(DEFAULT_CHANGELIST_ID), /default/);
		});

		test('validates names on create and rename', () => {
			const s = store();
			s.create('Feature');
			assert.throws(() => s.create('  '), /empty/);
			assert.throws(() => s.create('feature'), /exists/);

			const other = s.create('Other');
			assert.throws(() => s.rename(other.id, 'FEATURE'), /exists/);
			s.rename(other.id, '  Renamed ');
			assert.strictEqual(s.getList(other.id)?.name, 'Renamed');
		});

		test('carries the assignment over a rename', () => {
			const s = store();
			const list = s.create('L');
			s.reconcile([change('old')]);
			s.move(['old'], list.id);
			s.reconcile([change('new', 'old')]);

			assert.strictEqual(s.listOf('new'), list.id);
			assert.strictEqual(s.listOf('old'), undefined);
		});

		test('offers every list except the one that already holds all of the sources', () => {
			const s = store();
			const feature = s.create('Feature');
			const other = s.create('Other');

			assert.deepStrictEqual(s.moveTargets([DEFAULT_CHANGELIST_ID]).map(l => l.id), [feature.id, other.id]);
			assert.deepStrictEqual(s.moveTargets([feature.id, feature.id]).map(l => l.id), [DEFAULT_CHANGELIST_ID, other.id]);
			assert.deepStrictEqual(s.moveTargets([DEFAULT_CHANGELIST_ID, feature.id]).map(l => l.id), [DEFAULT_CHANGELIST_ID, feature.id, other.id]);
			assert.strictEqual(s.moveTargets([]).length, 3);
		});

		test('round-trips through a snapshot', () => {
			const s = store();
			const list = s.create('L');
			s.reconcile([change('a')]);
			s.move(['a'], list.id);

			const restored = store(JSON.parse(JSON.stringify(s.toSnapshot())));
			assert.deepStrictEqual(restored.getLists(), s.getLists());
			assert.strictEqual(restored.listOf('a'), list.id);
		});

		test('survives corrupt snapshots', () => {
			for (const bad of [null, 5, 'x', {}, { version: 99 }, { version: 1, lists: 'x', assignments: { a: 'ghost' } }]) {
				const restored = store(bad);
				assert.strictEqual(restored.getLists().length, 1);
				assert.strictEqual(restored.listOf('a'), undefined);
			}
		});

		test('applies the configured default name and rejects clashing names', () => {
			const s = store(store().toSnapshot(), 'Work');
			assert.strictEqual(s.getList(DEFAULT_CHANGELIST_ID)?.name, 'Work');

			s.create('Taken');
			s.setDefaultName('taken');
			assert.strictEqual(s.getList(DEFAULT_CHANGELIST_ID)?.name, 'Work');
			s.setDefaultName('Main');
			assert.strictEqual(s.getList(DEFAULT_CHANGELIST_ID)?.name, 'Main');
		});

		test('notifies listeners only on real changes', () => {
			const s = store();
			let calls = 0;
			const off = s.onDidChange(() => calls++);

			s.reconcile([change('a')]);
			s.reconcile([change('a')]);
			assert.strictEqual(calls, 1);

			off();
			s.create('x');
			assert.strictEqual(calls, 1);
		});
	});

	suite('HunkAssignments', () => {
		const hunks = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
		const HOME = 'default';

		test('keeps hunks in the home list until one is assigned elsewhere', () => {
			const h = new HunkAssignments();
			assert.strictEqual(h.hasOverrides('f'), false);

			h.assign('f', 'b', 'feature', HOME);
			assert.strictEqual(h.hasOverrides('f'), true);
			assert.strictEqual(h.listOf('f', 'b', HOME), 'feature');
			assert.strictEqual(h.listOf('f', 'a', HOME), HOME);
		});

		test('assigning back to the home list drops the override', () => {
			const h = new HunkAssignments();
			h.assign('f', 'b', 'feature', HOME);
			h.assign('f', 'b', HOME, HOME);
			assert.strictEqual(h.hasOverrides('f'), false);
		});

		test('partitions the hunks of a file by list', () => {
			const h = new HunkAssignments();
			h.assign('f', 'b', 'feature', HOME);
			const parts = h.listsOf('f', hunks, HOME);

			assert.deepStrictEqual([...parts.keys()].sort(), ['default', 'feature']);
			assert.deepStrictEqual(parts.get('feature'), [{ id: 'b' }]);
			assert.deepStrictEqual(parts.get('default'), [{ id: 'a' }, { id: 'c' }]);
		});

		test('describes what a list gets from a file', () => {
			const h = new HunkAssignments();
			assert.strictEqual(h.selectionFor('f', hunks, HOME, HOME).mode, 'all');
			assert.strictEqual(h.selectionFor('f', hunks, HOME, 'feature').mode, 'none');

			h.assign('f', 'b', 'feature', HOME);
			assert.deepStrictEqual(h.selectionFor('f', hunks, HOME, HOME), { mode: 'partial', hunks: [{ id: 'a' }, { id: 'c' }] });
			assert.deepStrictEqual(h.selectionFor('f', hunks, HOME, 'feature'), { mode: 'partial', hunks: [{ id: 'b' }] });

			h.assign('f', 'a', 'feature', HOME);
			h.assign('f', 'c', 'feature', HOME);
			assert.strictEqual(h.selectionFor('f', hunks, HOME, 'feature').mode, 'all');
			assert.strictEqual(h.selectionFor('f', hunks, HOME, HOME).mode, 'none');
		});

		test('deleting a list returns its hunks to their home lists', () => {
			const h = new HunkAssignments();
			h.assign('f', 'a', 'feature', HOME);
			h.assign('f', 'b', 'other', HOME);
			h.removeList('feature');

			assert.strictEqual(h.listOf('f', 'a', HOME), HOME);
			assert.strictEqual(h.listOf('f', 'b', HOME), 'other');
		});

		test('forgets vanished files and hunks', () => {
			const h = new HunkAssignments();
			h.assign('f', 'a', 'feature', HOME);
			h.assign('f', 'b', 'feature', HOME);
			h.assign('g', 'a', 'feature', HOME);
			h.retainHunks('f', new Set(['b']));

			assert.strictEqual(h.listOf('f', 'a', HOME), HOME);
			assert.strictEqual(h.listOf('f', 'b', HOME), 'feature');

			h.retainPaths(new Set(['f']));
			assert.strictEqual(h.hasOverrides('g'), false);
		});

		test('round-trips through JSON and ignores garbage', () => {
			const h = new HunkAssignments();
			h.assign('f', 'a', 'feature', HOME);

			const restored = new HunkAssignments();
			restored.load(JSON.parse(JSON.stringify(h)));
			assert.strictEqual(restored.listOf('f', 'a', HOME), 'feature');

			const bad = new HunkAssignments();
			bad.load(null);
			bad.load({ f: 'x', g: { a: 1, b: 'ok' } });
			assert.deepStrictEqual(bad.toJSON(), { g: { b: 'ok' } });
		});

		test('notifies only on real changes', () => {
			const h = new HunkAssignments();
			let calls = 0;
			h.onDidChange(() => calls++);

			h.assign('f', 'a', HOME, HOME);
			h.removeList('none');
			assert.strictEqual(calls, 0);

			h.assign('f', 'a', 'feature', HOME);
			assert.strictEqual(calls, 1);
		});
	});

	suite('hunks', () => {
		test('parses headers with and without counts and identifies hunks by their range in the base version', () => {
			const diff = ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1 +1,2 @@', '-a', '+b', '+c', '@@ -10,0 +12 @@', '+d', '@@ -20,2 +22,3 @@', '-e', '-f', '+g', '+h', '+i', ''].join('\n');
			const file = parseHunks('x', diff);

			assert.deepStrictEqual(file.hunks.map(h => [h.oldStart, h.oldLines, h.newStart, h.newLines]), [[1, 1, 1, 2], [10, 0, 12, 1], [20, 2, 22, 3]]);
			assert.deepStrictEqual(file.hunks.map(h => h.id), ['1,1', '10,0', '20,2']);
			assert.deepStrictEqual(file.hunks[0].lines, ['-a', '+b', '+c']);
		});

		test('keeps the id of a hunk when only its new content changes', () => {
			const before = parseHunks('x', ['@@ -9,2 +10,3 @@', '-a', '-b', '+c', '+d', '+e', ''].join('\n'));
			const after = parseHunks('x', ['@@ -9,2 +10,1 @@', '-a', '-b', '+z', ''].join('\n'));
			assert.strictEqual(before.hunks[0].id, after.hunks[0].id);
		});

		test('flags binary files', () => {
			const file = parseHunks('b.bin', 'Binary files a/b.bin and b/b.bin differ\n');
			assert.strictEqual(file.binary, true);
			assert.deepStrictEqual(file.hunks, []);
		});

		test('builds a patch that git can apply', () => {
			const file = parseHunks('f.txt', ['@@ -3 +3 @@', '-old', '+new', '\\ No newline at end of file', ''].join('\n'));
			assert.strictEqual(buildPatch('f.txt', file.hunks), 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -3 +3 @@\n-old\n+new\n\\ No newline at end of file\n');
		});

		test('finds a hunk by overlapping lines and a deletion by the line before it', () => {
			const hunks = [{ newStart: 3, newLines: 1 }, { newStart: 10, newLines: 4 }, { newStart: 20, newLines: 0 }];

			assert.strictEqual(hunkAtLines(hunks, { modifiedStartLineNumber: 3, modifiedEndLineNumber: 3 }), hunks[0]);
			assert.strictEqual(hunkAtLines(hunks, { modifiedStartLineNumber: 12, modifiedEndLineNumber: 13 }), hunks[1]);
			assert.strictEqual(hunkAtLines(hunks, { modifiedStartLineNumber: 5, modifiedEndLineNumber: 6 }), undefined);
			assert.strictEqual(hunkAtLines(hunks, { modifiedStartLineNumber: 20, modifiedEndLineNumber: 0 }), hunks[2]);
			assert.strictEqual(hunkAtLines(hunks, { modifiedStartLineNumber: 21, modifiedEndLineNumber: 0 }), undefined);
		});

		test('tells which hunks are already staged', () => {
			const all = parseHunks('f', ['@@ -3 +3 @@', '-a', '+b', '@@ -30 +30 @@', '-c', '+d', ''].join('\n')).hunks;
			const staged = parseHunks('f', ['@@ -30 +30 @@', '-c', '+d', ''].join('\n')).hunks;
			const editedAfterStaging = parseHunks('f', ['@@ -30 +30 @@', '-c', '+d again', ''].join('\n')).hunks;

			assert.deepStrictEqual(unstagedHunks(all, staged).map(h => h.id), ['3,1']);
			assert.deepStrictEqual(unstagedHunks(all, editedAfterStaging).map(h => h.id), ['3,1', '30,1']);
		});
	});
});
