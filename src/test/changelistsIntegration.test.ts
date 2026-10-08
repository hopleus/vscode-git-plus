/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import { commands, extensions, TabInputWebview, Uri, window, workspace } from 'vscode';
import { ChangelistGroups, PREVIEW_SCHEME } from '../changelists/changelistGroups';
import { ChangelistPrompts, createChangelistCommands } from '../changelists/commands';
import { HunkCodeLensProvider } from '../changelists/hunkUi';
import { editMessage } from '../messageEditor';
import type { GitExtension } from '../api/git';
import { DEFAULT_CHANGELIST_ID } from '../changelists/changelistStore';
import { dropCommit, editCommitMessage, resetBranchTo, squashCommits, undoCommitIntoChangelist } from '../historyActions';
import type { Model } from '../model';
import type { Repository } from '../repository';

suite('changelists integration', function () {
	this.timeout(60000);

	let root: string;
	let model: Model;
	let repository: Repository;

	const git = (...args: string[]) => cp.execFileSync('git', args, { cwd: root, encoding: 'utf8' });
	const write = (name: string, text: string) => {
		fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
		fs.writeFileSync(path.join(root, name), text);
	};
	const lines = (prefix: string, count = 40) => Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`);
	const text = (rows: string[]) => `${rows.join('\n')}\n`;
	const edited = (prefix: string, edits: Record<number, string>) => {
		const rows = lines(prefix);
		for (const [index, value] of Object.entries(edits)) {
			rows[Number(index)] = value;
		}
		return rows;
	};
	const committedFiles = (revision = 'HEAD') => git('show', '--name-only', '--format=', revision).split('\n').filter(Boolean).sort();
	const subject = () => git('log', '-1', '--format=%s').trim();
	const head = () => git('rev-parse', 'HEAD').trim();
	const commitCount = () => Number(git('rev-list', '--count', 'HEAD').trim());
	const pathsOf = (listId: string) => repository.changelists.resourcesIn(listId).map(r => repository.changelists.relativePath(r.resourceUri.fsPath)).sort();
	const unversioned = () => repository.untrackedGroup.resourceStates.map(r => repository.changelists.relativePath(r.resourceUri.fsPath)).sort();
	const lists = () => repository.changelists.store.getLists();
	const createList = (name: string) => repository.changelists.store.create(name).id;

	async function waitFor(predicate: () => boolean, description: string, timeoutMs = 20000): Promise<void> {
		const start = Date.now();

		for (; ;) {
			await repository.status();

			if (predicate()) {
				return;
			}

			if (Date.now() - start > timeoutMs) {
				throw new Error(`Timeout waiting for ${description}: default=[${pathsOf(DEFAULT_CHANGELIST_ID)}] lists=${JSON.stringify(lists())}`);
			}

			await new Promise(resolve => setTimeout(resolve, 200));
		}
	}

	async function hunksOf(rel: string, expected: number) {
		let hunks: string[] = [];

		await repository.status();

		for (let attempt = 0; attempt < 40; attempt++) {
			const file = await repository.changelists.fileHunks(rel);
			hunks = (file?.hunks ?? []).map(h => h.id);

			if (hunks.length === expected) {
				return hunks;
			}

			await new Promise(resolve => setTimeout(resolve, 200));
		}

		throw new Error(`Expected ${expected} hunks in ${rel}, got ${hunks.length}`);
	}

	async function commitList(listId: string, message: string): Promise<void> {
		repository.inputBox.value = message;
		await commands.executeCommand('git.commitChangelist', repository.changelists.groupOfList(listId));
	}

	async function commitStaged(message: string): Promise<void> {
		repository.inputBox.value = message;
		await commands.executeCommand('git.commit', repository.sourceControl);
	}

	suiteSetup(async function () {
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-changelists-')));
		cp.execSync('git init -b main', { cwd: root });
		cp.execSync('git config user.name testuser', { cwd: root });
		cp.execSync('git config user.email monacotools@example.com', { cwd: root });
		cp.execSync('git config commit.gpgsign false', { cwd: root });
		write('a.txt', 'a\n');
		write('b.txt', 'b\n');
		write('c.txt', 'c\n');
		git('add', '.');
		git('commit', '-qm', 'initial');

		const extension = extensions.getExtension<GitExtension>('vscode.git')!;
		await extension.activate();
		model = (extension.exports as unknown as { model: Model }).model;
		await commands.executeCommand('git.openRepository', root);

		for (let attempt = 0; attempt < 50 && !model.getRepository(Uri.file(root)); attempt++) {
			await new Promise(resolve => setTimeout(resolve, 200));
		}

		repository = model.getRepository(Uri.file(root))!;
		assert.ok(repository, 'the repository is opened');
	});

	suiteTeardown(function () {
		model.close(repository);
		fs.rmSync(root, { recursive: true, force: true });
	});

	teardown(() => sinon.restore());

	test('modified files land in the default changelist, untracked ones are unversioned', async function () {
		write('a.txt', 'a2\n');
		write('b.txt', 'b2\n');
		write('new.txt', 'n\n');

		await waitFor(() => pathsOf(DEFAULT_CHANGELIST_ID).length === 2, 'two files in the default list');
		assert.deepStrictEqual(pathsOf(DEFAULT_CHANGELIST_ID), ['a.txt', 'b.txt']);
		assert.deepStrictEqual(unversioned(), ['new.txt']);
		assert.strictEqual(repository.workingTreeGroup.label, 'Changes');
	});

	test('the extension API still reports untracked files as working tree changes', async function () {
		const api = (extensions.getExtension<GitExtension>('vscode.git')!.exports).getAPI(1);
		const apiRepository = api.repositories.find(r => r.rootUri.fsPath === root)!;

		assert.deepStrictEqual(apiRepository.state.workingTreeChanges.map(c => path.basename(c.uri.fsPath)).sort(), ['a.txt', 'b.txt', 'new.txt']);
	});

	test('create a changelist and move a file into it', async function () {
		const feature = { id: createList('Feature') };

		await repository.changelists.moveFiles(['b.txt'], feature.id);
		await waitFor(() => pathsOf(feature.id).length === 1, 'b.txt in Feature');

		assert.deepStrictEqual(pathsOf(feature.id), ['b.txt']);
		assert.deepStrictEqual(pathsOf(DEFAULT_CHANGELIST_ID), ['a.txt']);
		assert.strictEqual(repository.changelists.groupOfList(feature.id)!.label, 'Feature');
	});

	test('new changes always land in the default changelist', async function () {
		const feature = lists().find(l => l.name === 'Feature')!;
		write('c.txt', 'c2\n');

		await waitFor(() => pathsOf(DEFAULT_CHANGELIST_ID).length === 2, 'a.txt and c.txt in the default list');
		assert.deepStrictEqual(pathsOf(feature.id), ['b.txt']);
	});

	test('rename keeps the files, delete returns them to the default list', async function () {
		const feature = lists().find(l => l.name === 'Feature')!;

		repository.changelists.store.rename(feature.id, 'Renamed');
		await waitFor(() => repository.changelists.groupOfList(feature.id)?.label === 'Renamed', 'rename');
		assert.deepStrictEqual(pathsOf(feature.id), ['b.txt']);

		repository.changelists.deleteList(feature.id);
		await waitFor(() => lists().length === 1 && pathsOf(DEFAULT_CHANGELIST_ID).length === 3, 'delete');
	});

	test('the default changelist name follows the setting without a restart', async function () {
		const config = workspace.getConfiguration('git');

		await config.update('defaultChangelistName', 'Work in progress', 2);
		await waitFor(() => repository.workingTreeGroup.label === 'Work in progress', 'the default group to be renamed');
		assert.strictEqual(lists()[0].name, 'Work in progress');

		await config.update('defaultChangelistName', undefined, 2);
		await waitFor(() => repository.workingTreeGroup.label === 'Changes', 'the default group to get its name back');
	});

	test('files can be moved out of a changelist', async function () {
		const target = createList('Target');
		const resources = repository.changelists.resourcesIn(DEFAULT_CHANGELIST_ID).filter(r => r.resourceUri.fsPath.endsWith('a.txt'));

		await repository.changelists.moveResources(resources, target);
		await waitFor(() => pathsOf(target).includes('a.txt'), 'a.txt in Target');
		assert.ok(!pathsOf(DEFAULT_CHANGELIST_ID).includes('a.txt'));

		repository.changelists.deleteList(target);
		await waitFor(() => lists().length === 1, 'Target deleted');
	});

	test('an unversioned file or folder can be moved straight into a changelist', async function () {
		const target = createList('Fresh');
		write('fresh-one.txt', 'one\n');
		write('fresh-dir/inside.txt', 'inside\n');
		await waitFor(() => unversioned().includes('fresh-one.txt') && unversioned().includes('fresh-dir/inside.txt'), 'new paths are unversioned');

		await repository.changelists.moveFiles(['fresh-one.txt', 'fresh-dir/'], target);
		await waitFor(() => pathsOf(target).length === 2, 'both new paths in Fresh');

		assert.deepStrictEqual(pathsOf(target), ['fresh-dir/inside.txt', 'fresh-one.txt']);
		assert.strictEqual(git('diff', '--cached', '--name-only').trim(), '', 'their content is not staged');
		assert.ok(git('status', '--short').includes(' A fresh-one.txt'), 'the file is tracked as intent-to-add');

		git('rm', '-q', '--cached', '-r', 'fresh-one.txt', 'fresh-dir');
		fs.rmSync(path.join(root, 'fresh-one.txt'));
		fs.rmSync(path.join(root, 'fresh-dir'), { recursive: true });
		repository.changelists.deleteList(target);
		await waitFor(() => lists().length === 1, 'Fresh deleted');
	});

	test('opening a changed file shows HEAD against the working tree', async function () {
		write('a.txt', 'a-diff\n');
		git('add', 'a.txt');
		write('a.txt', 'a-diff2\n');
		await waitFor(() => pathsOf(DEFAULT_CHANGELIST_ID).includes('a.txt'), 'a.txt pending');

		const resource = repository.changelists.findResource('a.txt')!;
		const [left, right, title] = resource.command.arguments!;
		assert.strictEqual(resource.command.command, 'vscode.diff');
		assert.ok(left.toString().includes('HEAD'), `left side should be HEAD: ${left}`);
		assert.strictEqual(right.scheme, 'file');
		assert.strictEqual(title, 'a.txt (Working Tree)');

		git('reset', '-q', 'a.txt');
		write('a.txt', 'a2\n');
	});

	test('commit of one changelist leaves the others and the real index untouched', async function () {
		const feature = createList('Feature');
		await repository.changelists.moveFiles(['b.txt'], feature);
		git('add', 'c.txt');
		await waitFor(() => pathsOf(feature).length === 1, 'b.txt in Feature');

		await commitList(feature, 'feature work');
		await waitFor(() => pathsOf(feature).length === 0, 'Feature emptied after commit');

		assert.deepStrictEqual(committedFiles(), ['b.txt']);
		assert.strictEqual(subject(), 'feature work');
		assert.strictEqual(git('diff', '--cached', '--name-only').trim(), 'c.txt', 'the user index keeps c.txt staged');
		git('reset', '-q', 'c.txt');
		repository.changelists.deleteList(feature);
	});

	test('the plain Commit commits only what is staged', async function () {
		await waitFor(() => pathsOf(DEFAULT_CHANGELIST_ID).length === 2, 'a.txt and c.txt pending');

		git('add', 'a.txt');
		await waitFor(() => pathsOf(DEFAULT_CHANGELIST_ID).length === 1, 'a.txt staged');
		await commitStaged('staged only');
		await waitFor(() => pathsOf(DEFAULT_CHANGELIST_ID).length === 1, 'a.txt committed, c.txt pending');

		assert.deepStrictEqual(committedFiles(), ['a.txt']);
		assert.strictEqual(subject(), 'staged only');

		git('add', 'c.txt');
		await repository.status();
		await commitStaged('the rest');
		await waitFor(() => pathsOf(DEFAULT_CHANGELIST_ID).length === 0, 'everything committed');
		assert.deepStrictEqual(committedFiles(), ['c.txt']);
	});

	test('amend adds the staged files to the last commit without a new commit', async function () {
		const before = commitCount();
		write('a.txt', 'a3\n');
		git('add', 'a.txt');
		await waitFor(() => pathsOf(DEFAULT_CHANGELIST_ID).length === 0, 'a.txt staged');

		repository.inputBox.value = 'the rest, amended';
		await commands.executeCommand('git.commitAmend', repository.sourceControl);
		assert.strictEqual(commitCount(), before);
		assert.deepStrictEqual(committedFiles(), ['a.txt', 'c.txt']);
	});

	test('hunks of one file can live in different changelists and are committed separately', async function () {
		write('f.txt', text(lines('line')));
		git('add', 'f.txt');
		git('commit', '-qm', 'f');
		const content = text(edited('line', { 2: 'CHANGED3', 30: 'CHANGED31' }));
		write('f.txt', content);
		await waitFor(() => pathsOf(DEFAULT_CHANGELIST_ID).includes('f.txt'), 'f.txt pending');

		const feature = createList('HunkList');
		const hunks = await hunksOf('f.txt', 2);
		assert.deepStrictEqual(hunks.map(id => repository.changelists.hunkListOf('f.txt', id)), [DEFAULT_CHANGELIST_ID, DEFAULT_CHANGELIST_ID]);

		repository.changelists.moveHunk('f.txt', hunks[1], feature);
		await waitFor(() => pathsOf(feature).includes('f.txt') && pathsOf(DEFAULT_CHANGELIST_ID).includes('f.txt'), 'f.txt visible in both changelists');

		await commitList(feature, 'second hunk');
		await waitFor(() => pathsOf(feature).length === 0 && pathsOf(DEFAULT_CHANGELIST_ID).includes('f.txt'), 'only the first hunk remains pending');

		let committed = git('show', 'HEAD:f.txt').split('\n');
		assert.strictEqual(committed[30], 'CHANGED31');
		assert.strictEqual(committed[2], 'line3');
		assert.strictEqual(fs.readFileSync(path.join(root, 'f.txt'), 'utf8'), content);
		assert.strictEqual(git('diff', '--cached', '--name-only').trim(), '');

		await commitList(DEFAULT_CHANGELIST_ID, 'first hunk');
		await waitFor(() => pathsOf(DEFAULT_CHANGELIST_ID).length === 0, 'file fully committed');
		committed = git('show', 'HEAD:f.txt').split('\n');
		assert.strictEqual(committed[2], 'CHANGED3');
		repository.changelists.deleteList(feature);
	});

	test('moving every hunk of a file to another changelist moves the whole file', async function () {
		write('g.txt', text(lines('row')));
		git('add', 'g.txt');
		git('commit', '-qm', 'g');
		write('g.txt', text(edited('row', { 2: 'X3', 30: 'X31' })));
		await waitFor(() => pathsOf(DEFAULT_CHANGELIST_ID).includes('g.txt'), 'g.txt pending');

		const target = createList('Whole');
		for (const id of await hunksOf('g.txt', 2)) {
			repository.changelists.moveHunk('g.txt', id, target);
		}

		await waitFor(() => pathsOf(DEFAULT_CHANGELIST_ID).length === 0 && pathsOf(target).length === 1, 'g.txt entirely in Whole');
		await commitList(target, 'whole file');
		await waitFor(() => pathsOf(target).length === 0, 'Whole committed');
		repository.changelists.deleteList(target);
	});

	test('a split file opens a diff with only its own hunks, and + stages only that part', async function () {
		write('k.txt', text(lines('k')));
		git('add', 'k.txt');
		git('commit', '-qm', 'k');
		const content = text(edited('k', { 2: 'EDIT3', 30: 'EDIT31' }));
		write('k.txt', content);
		await waitFor(() => pathsOf(DEFAULT_CHANGELIST_ID).includes('k.txt'), 'k.txt pending');

		const part = createList('Part');
		const hunks = await hunksOf('k.txt', 2);
		repository.changelists.moveHunk('k.txt', hunks[1], part);
		await waitFor(() => pathsOf(part).includes('k.txt') && pathsOf(DEFAULT_CHANGELIST_ID).includes('k.txt'), 'k.txt in both changelists');

		const resource = repository.changelists.findResource('k.txt')!;
		const [right] = [resource.command.arguments![1] as Uri];
		assert.strictEqual(right.scheme, PREVIEW_SCHEME, `a split file must open the filtered diff: ${right}`);
		assert.ok(resource.command.arguments![0].toString().includes('HEAD'));

		const defaultView = (await workspace.openTextDocument(right)).getText().split('\n');
		assert.ok(defaultView[2] === 'EDIT3' || defaultView[30] === 'EDIT31', 'the filtered diff shows its own hunk');
		assert.ok(!(defaultView[2] === 'EDIT3' && defaultView[30] === 'EDIT31'), 'and not the other changelist hunk');

		const partResource = repository.changelists.resourcesIn(part).find(r => r.resourceUri.fsPath.endsWith('k.txt'))!;
		await commands.executeCommand('git.openChange', partResource);
		const input = window.tabGroups.activeTabGroup.activeTab?.input as { modified?: Uri; original?: Uri };
		assert.strictEqual(input?.modified?.scheme, PREVIEW_SCHEME, 'Open Changes shows only the hunks of the changelist');
		assert.ok(input.original!.toString().includes('HEAD'));

		await commands.executeCommand('git.stage', partResource);
		const staged = git('show', ':k.txt').split('\n');
		assert.strictEqual(staged[30], 'EDIT31');
		assert.strictEqual(staged[2], 'k3', 'the other changelist hunk is not staged');
		assert.strictEqual(fs.readFileSync(path.join(root, 'k.txt'), 'utf8'), content);

		await waitFor(() => pathsOf(part).length === 0 && pathsOf(DEFAULT_CHANGELIST_ID).includes('k.txt'), 'the staged hunk leaves its changelist');

		git('reset', '-q', 'k.txt');
		await waitFor(() => pathsOf(part).includes('k.txt'), 'unstaging returns the hunk to its changelist');

		await commands.executeCommand('git.stage', repository.changelists.resourcesIn(part)[0]);
		await waitFor(() => pathsOf(part).length === 0, 'staged again');
		await commitStaged('staged hunk');
		const committed = git('show', 'HEAD:k.txt').split('\n');
		assert.strictEqual(committed[30], 'EDIT31', 'the staged hunk was committed');
		assert.strictEqual(committed[2], 'k3', 'the unstaged hunk was not');

		git('checkout', '--', 'k.txt');
		await waitFor(() => pathsOf(DEFAULT_CHANGELIST_ID).length === 0 && pathsOf(part).length === 0, 'k.txt clean');
		repository.changelists.deleteList(part);
	});

	test('a rejecting pre-commit hook fails the commit and leaves no temporary index behind', async function () {
		const hook = path.join(root, '.git', 'hooks', 'pre-commit');
		fs.writeFileSync(hook, '#!/bin/sh\necho rejected >&2\nexit 1\n', { mode: 0o755 });
		write('b.txt', 'b3\n');
		await waitFor(() => pathsOf(DEFAULT_CHANGELIST_ID).length === 1, 'b.txt pending');
		sinon.stub(window, 'showErrorMessage').resolves(undefined);

		const before = commitCount();
		const temporaryIndexes = () => fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('git-index-'));
		const leftovers = new Set(temporaryIndexes());

		try {
			await commitList(DEFAULT_CHANGELIST_ID, 'blocked').then(undefined, () => undefined);
			assert.strictEqual(commitCount(), before);
			assert.deepStrictEqual(temporaryIndexes().filter(name => !leftovers.has(name)), []);
		} finally {
			fs.rmSync(hook, { force: true });
		}
	});

	test('an external commit from the terminal empties the changelists', async function () {
		git('commit', '-qam', 'external');
		await waitFor(() => pathsOf(DEFAULT_CHANGELIST_ID).length === 0 && lists().length === 1, 'status after external commit');
	});

	test('a new edit in a moved file lands in Changes, edits inside the moved hunk stay with it', async function () {
		write('h.txt', text(lines('h')));
		git('add', 'h.txt');
		git('commit', '-qm', 'h');
		write('h.txt', text(edited('h', { 2: 'first' })));
		await waitFor(() => pathsOf(DEFAULT_CHANGELIST_ID).includes('h.txt'), 'h.txt pending');

		const moved = createList('Moved');
		await repository.changelists.moveFiles(['h.txt'], moved);
		await waitFor(() => pathsOf(DEFAULT_CHANGELIST_ID).length === 0 && pathsOf(moved).includes('h.txt'), 'h.txt moved as a whole');

		write('h.txt', text(edited('h', { 2: 'first', 30: 'second' })));
		await waitFor(() => pathsOf(DEFAULT_CHANGELIST_ID).includes('h.txt') && pathsOf(moved).includes('h.txt'), 'the new edit shows up in Changes, the old one stays in Moved');

		write('h.txt', text(edited('h', { 2: 'first, edited again', 30: 'second' })));
		await new Promise(resolve => setTimeout(resolve, 1500));
		await waitFor(() => pathsOf(DEFAULT_CHANGELIST_ID).includes('h.txt') && pathsOf(moved).includes('h.txt'), 'the edited hunk stays in Moved');

		await commitList(moved, 'moved part');
		await waitFor(() => pathsOf(moved).length === 0 && pathsOf(DEFAULT_CHANGELIST_ID).length === 1, 'Moved committed, Changes still pending');
		const committed = git('show', 'HEAD:h.txt').split('\n');
		assert.strictEqual(committed[2], 'first, edited again');
		assert.strictEqual(committed[30], 'h31');

		await commitList(DEFAULT_CHANGELIST_ID, 'rest');
		await waitFor(() => pathsOf(DEFAULT_CHANGELIST_ID).length === 0, 'everything committed');
		repository.changelists.deleteList(moved);
	});

	test('history can be rewritten: reword, squash and drop', async function () {
		const hashes: string[] = [];

		for (const name of ['one.txt', 'two.txt', 'three.txt', 'four.txt']) {
			write(name, `${name}\n`);
			git('add', name);
			git('commit', '-qm', `commit ${name}`);
			hashes.push(head());
		}

		write('dirty.txt', 'uncommitted\n');
		const log = () => git('log', '--format=%s').trim().split('\n');
		const tree = git('rev-parse', 'HEAD^{tree}').trim();

		await repository.rewordCommit(hashes[1], 'renamed two\n\nwith a body');
		assert.deepStrictEqual(log().slice(0, 4), ['commit four.txt', 'commit three.txt', 'renamed two', 'commit one.txt']);
		assert.strictEqual(git('log', '-1', '--format=%b', 'HEAD~2').trim(), 'with a body');
		assert.strictEqual(git('rev-parse', 'HEAD^{tree}').trim(), tree, 'rewording never changes file contents');
		assert.strictEqual(fs.readFileSync(path.join(root, 'dirty.txt'), 'utf8'), 'uncommitted\n', 'uncommitted work is untouched');

		const before = commitCount();
		const chain = git('rev-list', '--reverse', 'HEAD~3..HEAD').trim().split('\n');
		await repository.squashCommits(chain[0], chain[1], 'squashed two and three');
		assert.strictEqual(commitCount(), before - 1);
		assert.deepStrictEqual(log().slice(0, 3), ['commit four.txt', 'squashed two and three', 'commit one.txt']);
		assert.strictEqual(git('rev-parse', 'HEAD^{tree}').trim(), tree, 'squashing never changes file contents');

		await repository.dropCommit(head());
		assert.deepStrictEqual(log().slice(0, 2), ['squashed two and three', 'commit one.txt']);
		assert.ok(!fs.existsSync(path.join(root, 'four.txt')));
		assert.strictEqual(fs.readFileSync(path.join(root, 'dirty.txt'), 'utf8'), 'uncommitted\n');
		fs.rmSync(path.join(root, 'dirty.txt'));
	});

	test('the history menu places Reset next to Cherry Pick and rewrites in their own group', function () {
		const contributes = extensions.getExtension('vscode.git')!.packageJSON.contributes;
		const menu: { command: string; group: string }[] = contributes.menus['scm/historyItem/context'];
		const entry = (command: string) => menu.find(e => e.command === command)!;
		const groupOf = (command: string) => entry(command).group.split('@')[0];
		const orderOf = (command: string) => Number(entry(command).group.split('@')[1]);

		assert.strictEqual(groupOf('git.graph.reset'), groupOf('git.graph.cherryPick'));
		assert.ok(orderOf('git.graph.reset') > orderOf('git.graph.cherryPick'));

		const rewrites = ['git.graph.editMessage', 'git.graph.squash', 'git.graph.drop'];
		for (const command of rewrites) {
			assert.strictEqual(groupOf(command), groupOf(rewrites[0]));
			assert.notStrictEqual(groupOf(command), groupOf('git.graph.cherryPick'));
		}
		assert.ok(groupOf(rewrites[0]) < groupOf('git.graph.compareWithRemote'));
	});

	test('Undo Commit returns the changes of the last commit into a changelist', async function () {
		write('undo-added.txt', 'brand new\n');
		write('undo-mod.txt', 'v1\n');
		git('add', 'undo-added.txt', 'undo-mod.txt');
		git('commit', '-qm', 'base for undo');
		write('undo-mod.txt', 'v2\n');
		write('undo-added2.txt', 'second new\n');
		git('add', 'undo-mod.txt', 'undo-added2.txt');
		git('commit', '-qm', 'KNX-45 work to undo');
		const parent = git('rev-parse', 'HEAD~1').trim();

		sinon.stub(window, 'showQuickPick').callsFake((async (items: readonly { create?: boolean }[]) => items.find(item => item.create)) as never);
		sinon.stub(window, 'showInputBox').resolves('KNX-45');
		sinon.stub(window, 'showWarningMessage').resolves('Continue' as never);

		await undoCommitIntoChangelist(repository, undefined);
		assert.strictEqual(head(), parent);

		const created = lists().find(l => l.name === 'KNX-45')!;
		await waitFor(() => pathsOf(created.id).length === 2, 'the undone files land in the new changelist');
		assert.deepStrictEqual(pathsOf(created.id), ['undo-added2.txt', 'undo-mod.txt']);
		assert.strictEqual(git('diff', '--cached', '--name-only').trim(), '', 'nothing is left staged');
		assert.strictEqual(repository.inputBox.value, 'KNX-45 work to undo');

		repository.changelists.deleteList(created.id);
		git('add', 'undo-mod.txt', 'undo-added2.txt');
		git('commit', '-qm', 'cleanup after undo');
	});

	test('Reset Current Branch to Here supports soft, mixed, hard and keep', async function () {
		const base = head();
		const commits: string[] = [];

		for (const name of ['r1.txt', 'r2.txt']) {
			write(name, `${name}\n`);
			git('add', name);
			git('commit', '-qm', `reset ${name}`);
			commits.push(head());
		}

		const status = () => git('status', '--short').split('\n').filter(line => line && line !== '?? new.txt').sort();

		await repository.resetTo(commits[0], 'soft');
		assert.strictEqual(head(), commits[0]);
		assert.deepStrictEqual(status(), ['A  r2.txt'], 'soft stages the differences');

		await repository.resetTo(base, 'mixed');
		assert.strictEqual(head(), base);
		assert.deepStrictEqual(status(), ['?? r1.txt', '?? r2.txt'], 'mixed leaves the files unstaged');

		write('keepme.txt', 'local\n');
		await repository.resetTo(base, 'keep');
		assert.ok(fs.existsSync(path.join(root, 'keepme.txt')), 'keep preserves local files');

		await repository.resetTo(base, 'hard');
		assert.strictEqual(head(), base);
		for (const name of ['r1.txt', 'r2.txt', 'keepme.txt']) {
			fs.rmSync(path.join(root, name), { force: true });
		}
	});

	test('Drop Commit asks for confirmation, warns about published commits and rewrites only when confirmed', async function () {
		write('drop-1.txt', '1\n');
		git('add', 'drop-1.txt');
		git('commit', '-qm', 'to drop');
		const target = head();
		write('drop-2.txt', '2\n');
		git('add', 'drop-2.txt');
		git('commit', '-qm', 'after drop');

		const warning = sinon.stub(window, 'showWarningMessage');
		warning.resolves(undefined);
		await dropCommit(repository, target);
		assert.strictEqual(subject(), 'after drop', 'declining keeps the history');
		assert.ok(git('log', '--format=%s').includes('to drop'));

		git('update-ref', 'refs/remotes/origin/main', target);
		warning.resetHistory();
		warning.resolves('Continue' as never);
		await dropCommit(repository, target);
		assert.ok(String(warning.firstCall.args[0]).includes('origin/main'), 'published commits are called out');
		assert.ok(!git('log', '--format=%s').includes('to drop'));
		assert.ok(!fs.existsSync(path.join(root, 'drop-1.txt')));
		git('update-ref', '-d', 'refs/remotes/origin/main');
		git('reset', '-q', '--hard', 'HEAD~1');
	});

	test('Reset Current Branch to Here picks a mode and asks before a hard reset', async function () {
		const base = head();
		write('reset-ui.txt', 'x\n');
		git('add', 'reset-ui.txt');
		git('commit', '-qm', 'to reset');
		const pickMode = (mode: string) => (async (items: readonly { mode: string }[]) => items.find(item => item.mode === mode)) as never;

		sinon.stub(window, 'showQuickPick').callsFake(pickMode('hard'));
		const warning = sinon.stub(window, 'showWarningMessage');
		warning.resolves(undefined);
		await resetBranchTo(repository, base);
		assert.notStrictEqual(head(), base, 'a declined hard reset changes nothing');

		warning.resolves('Reset' as never);
		await resetBranchTo(repository, base);
		assert.strictEqual(head(), base);
		assert.ok(!fs.existsSync(path.join(root, 'reset-ui.txt')));

		sinon.restore();
		write('reset-ui.txt', 'x\n');
		git('add', 'reset-ui.txt');
		git('commit', '-qm', 'to reset');
		sinon.stub(window, 'showQuickPick').callsFake(pickMode('soft'));
		const second = sinon.stub(window, 'showWarningMessage');
		await resetBranchTo(repository, base);
		assert.ok(second.notCalled, 'only hard asks for confirmation');
		assert.strictEqual(git('diff', '--cached', '--name-only').trim(), 'reset-ui.txt');
		git('reset', '-q', '--hard', 'HEAD');
	});

	test('history actions refuse to run while a merge is in progress', async function () {
		const base = head();
		git('checkout', '-qb', 'guard-side');
		write('guard.txt', 'side\n');
		git('add', 'guard.txt');
		git('commit', '-qm', 'side');
		git('checkout', '-q', 'main');
		write('guard.txt', 'main\n');
		git('add', 'guard.txt');
		git('commit', '-qm', 'main');
		try {
			git('merge', 'guard-side');
		} catch {
			// the conflict is expected
		}
		await waitFor(() => repository.mergeInProgress, 'merge in progress');

		const warning = sinon.stub(window, 'showWarningMessage').resolves(undefined);
		const before = head();
		await dropCommit(repository, before);
		await resetBranchTo(repository, base);

		assert.strictEqual(warning.callCount, 2);
		assert.ok(String(warning.firstCall.args[0]).includes('in progress'));
		assert.strictEqual(head(), before);

		git('merge', '--abort');
		git('reset', '-q', '--hard', base);
		git('branch', '-qD', 'guard-side');
		await waitFor(() => !repository.mergeInProgress, 'merge state cleared');
	});

	test('Edit Commit Message opens an editing panel instead of a file, and cancelling changes nothing', async function () {
		const before = head();
		const message = git('log', '-1', '--format=%B').trim();
		const pending = commands.executeCommand('git.graph.editMessage', repository.sourceControl, { id: before });

		let tab;
		for (let attempt = 0; attempt < 60 && !tab; attempt++) {
			tab = window.tabGroups.all.flatMap(g => g.tabs).find(t => t.label === 'Edit Commit Message' && t.input instanceof TabInputWebview);
			await new Promise(resolve => setTimeout(resolve, 250));
		}

		assert.ok(tab, 'a panel with the message editor is opened');
		assert.ok((tab.input as TabInputWebview).viewType.endsWith('git.editCommitMessage'));

		await window.tabGroups.close(tab);
		await pending;
		assert.strictEqual(head(), before);
		assert.strictEqual(git('log', '-1', '--format=%B').trim(), message);
	});

	suite('commands with prompts', function () {
		type Pick = { label: string; id?: string; create?: boolean };

		function prompts(overrides: Partial<Record<keyof ChangelistPrompts, unknown>>): ChangelistPrompts {
			const never = () => { throw new Error('unexpected prompt'); };
			return { showInputBox: never, showQuickPick: never, showWarningMessage: never, showInformationMessage: never, ...overrides } as unknown as ChangelistPrompts;
		}

		const pickById = (id: string) => async (items: readonly Pick[]) => items.find(item => item.id === id);

		setup(async () => {
			write('a.txt', 'a-cmd\n');
			write('b.txt', 'b-cmd\n');
			await waitFor(() => pathsOf(DEFAULT_CHANGELIST_ID).length === 2, 'two files pending');
		});

		teardown(async () => {
			for (const list of lists().filter(l => l.id !== DEFAULT_CHANGELIST_ID)) {
				repository.changelists.deleteList(list.id);
			}

			git('checkout', '--', '.');
			await waitFor(() => pathsOf(DEFAULT_CHANGELIST_ID).length === 0 && lists().length === 1, 'clean state');
		});

		test('create asks for a name and returns the new list id', async () => {
			const handlers = createChangelistCommands(model, prompts({ showInputBox: async () => 'CmdList' }));

			const id = await handlers.createChangelist(repository.sourceControl);

			assert.strictEqual(repository.changelists.store.getList(id!)?.name, 'CmdList');
		});

		test('create does nothing when the prompt is cancelled', async () => {
			const handlers = createChangelistCommands(model, prompts({ showInputBox: async () => undefined }));

			assert.strictEqual(await handlers.createChangelist(repository.sourceControl), undefined);
			assert.strictEqual(lists().length, 1);
		});

		test('the name prompt rejects duplicates and empty names', async () => {
			createList('Taken');
			let validate: ((value: string) => string | undefined | null) | undefined;
			const handlers = createChangelistCommands(model, prompts({
				showInputBox: async (options: { validateInput?: typeof validate }) => {
					validate = options.validateInput;
					return undefined;
				}
			}));

			await handlers.createChangelist(repository.sourceControl);

			assert.ok(validate!('taken'));
			assert.ok(validate!('   '));
			assert.strictEqual(validate!('Fresh name'), undefined);
		});

		test('rename works from a changelist group', async () => {
			const id = createList('Before');
			const handlers = createChangelistCommands(model, prompts({ showInputBox: async () => 'After' }));

			await handlers.renameChangelist(repository.changelists.groupOfList(id));

			assert.strictEqual(repository.changelists.store.getList(id)?.name, 'After');
		});

		test('the default changelist cannot be renamed or deleted from the command', async () => {
			const handlers = createChangelistCommands(model, prompts({}));

			await handlers.renameChangelist(repository.workingTreeGroup);
			await handlers.deleteChangelist(repository.workingTreeGroup);

			assert.strictEqual(lists()[0].name, 'Changes');
		});

		test('delete of a non-empty changelist needs confirmation', async () => {
			const id = createList('Doomed');
			await repository.changelists.moveFiles(['b.txt'], id);
			await waitFor(() => pathsOf(id).length === 1, 'b.txt moved');
			const group = repository.changelists.groupOfList(id);

			await createChangelistCommands(model, prompts({ showWarningMessage: async () => undefined })).deleteChangelist(group);
			assert.ok(repository.changelists.store.getList(id), 'declining keeps the list');

			await createChangelistCommands(model, prompts({ showWarningMessage: async () => 'Delete' })).deleteChangelist(group);
			await waitFor(() => !repository.changelists.store.getList(id), 'list deleted');
			assert.deepStrictEqual(pathsOf(DEFAULT_CHANGELIST_ID), ['a.txt', 'b.txt']);
		});

		test('delete of an empty changelist does not ask', async () => {
			const id = createList('Empty');

			await createChangelistCommands(model, prompts({})).deleteChangelist(repository.changelists.groupOfList(id));

			assert.ok(!repository.changelists.store.getList(id));
		});

		test('move files from a group header lets the user choose files and the target', async () => {
			const target = createList('Target');
			const handlers = createChangelistCommands(model, prompts({
				showQuickPick: async (items: readonly Pick[], options?: { canPickMany?: boolean }) =>
					options?.canPickMany ? items.filter(item => item.label === 'a.txt') : items.find(item => item.id === target)
			}));

			await handlers.moveChangelistFiles(repository.workingTreeGroup);
			await waitFor(() => pathsOf(target).length === 1, 'a.txt moved');

			assert.deepStrictEqual(pathsOf(target), ['a.txt']);
			assert.deepStrictEqual(pathsOf(DEFAULT_CHANGELIST_ID), ['b.txt']);
		});

		test('move files can create a new target changelist on the fly', async () => {
			const handlers = createChangelistCommands(model, prompts({
				showQuickPick: async (items: readonly Pick[], options?: { canPickMany?: boolean }) =>
					options?.canPickMany ? items : items.find(item => item.create),
				showInputBox: async () => 'Inline'
			}));

			await handlers.moveChangelistFiles(repository.workingTreeGroup);

			const created = lists().find(l => l.name === 'Inline')!;
			await waitFor(() => pathsOf(created.id).length === 2, 'both files moved');
		});

		test('move files with nothing selected changes nothing', async () => {
			const handlers = createChangelistCommands(model, prompts({ showQuickPick: async () => [] }));

			await handlers.moveChangelistFiles(repository.workingTreeGroup);

			assert.deepStrictEqual(pathsOf(DEFAULT_CHANGELIST_ID), ['a.txt', 'b.txt']);
		});

		test('move files from an empty group informs the user', async () => {
			const id = createList('Nothing');
			const informed: string[] = [];
			const handlers = createChangelistCommands(model, prompts({ showInformationMessage: async (message: string) => { informed.push(message); } }));

			await handlers.moveChangelistFiles(repository.changelists.groupOfList(id));

			assert.strictEqual(informed.length, 1);
		});

		test('move to changelist moves selected resources and does not offer their own list', async () => {
			const target = createList('Moved here');
			let offered: string[] = [];
			const handlers = createChangelistCommands(model, prompts({
				showQuickPick: async (items: readonly Pick[]) => {
					offered = items.map(item => item.label);
					return items.find(item => item.id === target);
				}
			}));
			const resource = repository.changelists.findResource('a.txt')!;

			await handlers.moveToChangelist(resource);
			await waitFor(() => pathsOf(target).length === 1, 'a.txt moved');

			assert.ok(!offered.includes('Changes'));
			assert.ok(offered.includes('Moved here'));
			assert.deepStrictEqual(pathsOf(DEFAULT_CHANGELIST_ID), ['b.txt']);
		});

		test('move to changelist adopts unversioned resources', async () => {
			const target = createList('Adopt');
			write('adopt-me.txt', 'x\n');
			await waitFor(() => unversioned().includes('adopt-me.txt'), 'unversioned file shown');
			const handlers = createChangelistCommands(model, prompts({ showQuickPick: pickById(target) }));

			await handlers.moveToChangelist(repository.untrackedGroup.resourceStates.find(r => r.resourceUri.fsPath.endsWith('adopt-me.txt')));
			await waitFor(() => pathsOf(target).includes('adopt-me.txt'), 'file adopted');

			git('rm', '-q', '--cached', 'adopt-me.txt');
			fs.rmSync(path.join(root, 'adopt-me.txt'));
		});

		test('move to changelist without a changed file selection informs the user', async () => {
			const informed: string[] = [];
			const handlers = createChangelistCommands(model, prompts({ showInformationMessage: async (message: string) => { informed.push(message); } }));

			await handlers.moveToChangelist();

			assert.strictEqual(informed.length, 1);
		});

		test('stage changelist stages every file of the group', async () => {
			const id = createList('Stage me');
			await repository.changelists.moveFiles(['b.txt'], id);
			await waitFor(() => pathsOf(id).length === 1, 'b.txt moved');

			await createChangelistCommands(model, prompts({})).stageChangelist(repository.changelists.groupOfList(id));

			assert.strictEqual(git('diff', '--cached', '--name-only').trim(), 'b.txt');
			git('reset', '-q');
		});
	});

	suite('history actions with an injected editor', function () {
		const commitFileAndGetHash = (name: string, message: string) => {
			write(name, `${name}\n`);
			git('add', name);
			git('commit', '-qm', message);
			return head();
		};

		test('edit message rewrites the commit with the edited text', async () => {
			const target = commitFileAndGetHash('edit-1.txt', 'before edit');
			commitFileAndGetHash('edit-2.txt', 'after edit');
			sinon.stub(window, 'showWarningMessage').resolves('Continue' as never);
			let received: { initial: string; title: string } | undefined;

			await editCommitMessage(repository, target, async (initial, title) => {
				received = { initial, title };
				return 'edited subject';
			});

			assert.deepStrictEqual(received, { initial: 'before edit', title: 'Edit Commit Message' });
			assert.deepStrictEqual(git('log', '--format=%s', '-2').trim().split('\n'), ['after edit', 'edited subject']);
		});

		test('edit message does nothing when the text is unchanged, empty or cancelled', async () => {
			const before = head();
			const warning = sinon.stub(window, 'showWarningMessage').resolves('Continue' as never);

			await editCommitMessage(repository, before, async initial => initial);
			await editCommitMessage(repository, before, async () => '');
			await editCommitMessage(repository, before, async () => undefined);

			assert.strictEqual(head(), before);
			assert.ok(warning.notCalled);
		});

		test('edit message is not applied when the user declines the rewrite warning', async () => {
			const before = head();
			sinon.stub(window, 'showWarningMessage').resolves(undefined);

			await editCommitMessage(repository, before, async () => 'declined');

			assert.strictEqual(head(), before);
		});

		test('squash merges the chosen range with the edited message', async () => {
			const first = commitFileAndGetHash('squash-1.txt', 'squash one');
			commitFileAndGetHash('squash-2.txt', 'squash two');
			const last = commitFileAndGetHash('squash-3.txt', 'squash three');
			const count = commitCount();
			sinon.stub(window, 'showWarningMessage').resolves('Continue' as never);
			sinon.stub(window, 'showQuickPick').callsFake((async (items: readonly { hash: string }[]) => items.find(item => item.hash === first)) as never);
			let proposed = '';

			await squashCommits(repository, last, async initial => {
				proposed = initial;
				return 'squashed';
			});

			assert.ok(proposed.includes('squash one') && proposed.includes('squash three'), 'the proposal joins the messages');
			assert.strictEqual(commitCount(), count - 2);
			assert.strictEqual(subject(), 'squashed');
			assert.ok(fs.existsSync(path.join(root, 'squash-1.txt')) && fs.existsSync(path.join(root, 'squash-3.txt')));
		});

		test('squash is cancelled when the editor returns nothing', async () => {
			commitFileAndGetHash('squash-4.txt', 'squash four');
			const last = commitFileAndGetHash('squash-5.txt', 'squash five');
			sinon.stub(window, 'showQuickPick').callsFake((async (items: readonly unknown[]) => items[0]) as never);

			await squashCommits(repository, last, async () => undefined);

			assert.strictEqual(head(), last);
		});

		test('squash of a root commit explains that there is nothing to squash with', async () => {
			const root0 = git('rev-list', '--max-parents=0', 'HEAD').trim();
			const info = sinon.stub(window, 'showInformationMessage').resolves(undefined);

			await squashCommits(repository, root0, async () => 'never');

			assert.ok(info.calledOnce);
		});

		test('undo commit refuses a commit that is not the last one', async () => {
			const older = commitFileAndGetHash('undo-old.txt', 'older');
			commitFileAndGetHash('undo-new.txt', 'newer');
			const warning = sinon.stub(window, 'showWarningMessage').resolves(undefined);
			const before = head();

			await undoCommitIntoChangelist(repository, older);

			assert.ok(warning.calledOnce);
			assert.strictEqual(head(), before);
		});
	});

	suite('hunk code lens', function () {
		const lensesOf = async (file: string, provider = new HunkCodeLensProvider(model)) => {
			const document = await workspace.openTextDocument(Uri.file(path.join(root, file)));
			return provider.provideCodeLenses(document);
		};

		suiteSetup(async () => {
			write('lens.txt', text(lines('lens')));
			git('add', 'lens.txt');
			git('commit', '-qm', 'lens');
		});

		teardown(async () => {
			git('checkout', '--', '.');
			for (const list of lists().filter(l => l.id !== DEFAULT_CHANGELIST_ID)) {
				repository.changelists.deleteList(list.id);
			}

			await waitFor(() => pathsOf(DEFAULT_CHANGELIST_ID).length === 0, 'clean state');
		});

		test('shows one lens per hunk with its changelist and position', async () => {
			write('lens.txt', text(edited('lens', { 2: 'A', 30: 'B' })));
			await waitFor(() => pathsOf(DEFAULT_CHANGELIST_ID).includes('lens.txt'), 'lens.txt pending');
			const hunks = await hunksOf('lens.txt', 2);
			const feature = createList('Lensed');
			repository.changelists.moveHunk('lens.txt', hunks[1], feature);

			const lenses = await lensesOf('lens.txt');

			assert.deepStrictEqual(lenses.map(l => l.command?.title), ['$(list-unordered) Changes (1/2)', '$(list-unordered) Lensed (2/2)']);
			assert.deepStrictEqual(lenses.map(l => l.range.start.line), [2, 30]);
			assert.ok(lenses.every(l => l.command?.command === 'git.moveHunkToChangelist'));
			assert.deepStrictEqual(lenses[1].command?.arguments?.[0], { root, path: 'lens.txt', hunkId: hunks[1] });
		});

		test('is empty for unchanged files, non-file documents and when disabled', async () => {
			assert.deepStrictEqual(await lensesOf('a.txt'), []);

			write('lens.txt', text(edited('lens', { 2: 'A' })));
			await waitFor(() => pathsOf(DEFAULT_CHANGELIST_ID).includes('lens.txt'), 'lens.txt pending');
			await hunksOf('lens.txt', 1);
			assert.strictEqual((await lensesOf('lens.txt')).length, 1);

			const untitled = await workspace.openTextDocument({ content: 'x' });
			assert.deepStrictEqual(await new HunkCodeLensProvider(model).provideCodeLenses(untitled), []);

			await workspace.getConfiguration('git').update('hunkCodeLens', false, 2);
			try {
				assert.deepStrictEqual(await lensesOf('lens.txt'), []);
			} finally {
				await workspace.getConfiguration('git').update('hunkCodeLens', undefined, 2);
			}
		});

		test('places the lens after the line for a pure deletion', async () => {
			const rows = lines('lens');
			rows.splice(9, 1);
			write('lens.txt', text(rows));
			await waitFor(() => pathsOf(DEFAULT_CHANGELIST_ID).includes('lens.txt'), 'lens.txt pending');
			await hunksOf('lens.txt', 1);

			const lenses = await lensesOf('lens.txt');

			assert.strictEqual(lenses.length, 1);
			assert.strictEqual(lenses[0].range.start.line, 9);
		});

		test('fires a change event on refresh', () => {
			const provider = new HunkCodeLensProvider(model);
			let fired = 0;
			provider.onDidChangeCodeLenses(() => fired++);

			provider.refresh();

			assert.strictEqual(fired, 1);
			provider.dispose();
		});
	});

	suite('persistence', function () {
		test('a new instance restores lists, file assignments and hunk assignments from the saved state', async () => {
			write('persist.txt', text(lines('p')));
			git('add', 'persist.txt');
			git('commit', '-qm', 'persist');
			write('persist.txt', text(edited('p', { 2: 'A', 30: 'B' })));
			write('b.txt', 'b-persist\n');
			await waitFor(() => pathsOf(DEFAULT_CHANGELIST_ID).length === 2, 'two files pending');
			const files = createList('Files');
			const hunkList = createList('Hunks');
			await repository.changelists.moveFiles(['b.txt'], files);
			const hunks = await hunksOf('persist.txt', 2);
			repository.changelists.moveHunk('persist.txt', hunks[0], hunkList);
			repository.changelists.flush();

			const restored = new ChangelistGroups({ root, workspaceState: model.workspaceState } as never);

			try {
				assert.deepStrictEqual(restored.store.getLists().map(l => l.name), ['Changes', 'Files', 'Hunks']);
				const bHunk = (await repository.changelists.fileHunks('b.txt'))!.hunks[0].id;
				assert.strictEqual(restored.hunkListOf('b.txt', bHunk), files);
				assert.strictEqual(restored.hunkListOf('persist.txt', hunks[0]), hunkList);
				assert.strictEqual(restored.hunkListOf('persist.txt', hunks[1]), DEFAULT_CHANGELIST_ID);
			} finally {
				restored.dispose();
			}

			git('checkout', '--', '.');
			for (const list of lists().filter(l => l.id !== DEFAULT_CHANGELIST_ID)) {
				repository.changelists.deleteList(list.id);
			}
			await waitFor(() => pathsOf(DEFAULT_CHANGELIST_ID).length === 0, 'clean state');
		});

		test('state of other repositories is kept apart', async () => {
			repository.changelists.flush();

			const stranger = new ChangelistGroups({ root: path.join(root, 'elsewhere'), workspaceState: model.workspaceState } as never);

			try {
				assert.deepStrictEqual(stranger.store.getLists().map(l => l.name), ['Changes']);
			} finally {
				stranger.dispose();
			}
		});
	});

	suite('message editor', function () {
		function fakePanel() {
			let onMessage: (message: unknown) => void = () => undefined;
			let onDispose: () => void = () => undefined;
			const panel = {
				webview: { html: '', cspSource: 'vscode-resource:', asWebviewUri: (uri: Uri) => uri, onDidReceiveMessage: (listener: (message: unknown) => void) => { onMessage = listener; } },
				onDidDispose: (listener: () => void) => { onDispose = listener; },
				dispose: sinon.spy(() => onDispose())
			};
			const create = sinon.stub(window, 'createWebviewPanel').returns(panel as never);
			return { panel, create, send: (message: unknown) => onMessage(message), close: () => onDispose() };
		}

		test('resolves with the trimmed text when applied and closes the panel', async () => {
			const fake = fakePanel();
			const result = editMessage('initial', 'Title');

			fake.send({ type: 'apply', text: '  new text \n' });

			assert.strictEqual(await result, 'new text');
			assert.ok(fake.panel.dispose.calledOnce);
		});

		test('resolves with undefined when cancelled or closed', async () => {
			let fake = fakePanel();
			let result = editMessage('initial', 'Title');
			fake.send({ type: 'cancel' });
			assert.strictEqual(await result, undefined);

			sinon.restore();
			fake = fakePanel();
			result = editMessage('initial', 'Title');
			fake.close();
			assert.strictEqual(await result, undefined);
		});

		test('settles only once', async () => {
			const fake = fakePanel();
			const result = editMessage('initial', 'Title');

			fake.send({ type: 'apply', text: 'first' });
			fake.send({ type: 'apply', text: 'second' });

			assert.strictEqual(await result, 'first');
		});

		test('renders the initial text and title escaped, with a nonce-protected policy', () => {
			const fake = fakePanel();
			void editMessage('<script>alert(1)</script> & more', '<b>Title</b>');

			const html = fake.panel.webview.html;
			assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; more'));
			assert.ok(html.includes('&lt;b&gt;Title&lt;/b&gt;'));
			assert.ok(!html.includes('<script>alert(1)'));
			const nonce = /script-src [^;]*'nonce-([^']+)'/.exec(html)![1];
			assert.ok(html.includes(`<script nonce="${nonce}">`));
			assert.ok(fake.create.calledOnce);
			fake.close();
		});
	});

	test('the manifest contributes the changelist entries to every changelist group and folders', function () {
		const contributes = extensions.getExtension('vscode.git')!.packageJSON.contributes;
		const entries = (menu: string): { command: string; when: string; group: string }[] => contributes.menus[menu];
		const groupHeader = entries('scm/resourceGroup/context');
		const inline = groupHeader.filter(e => e.group.startsWith('inline'));

		assert.ok(inline.some(e => e.command === 'git.stageChangelist'));
		assert.ok(!inline.some(e => /stageAll(Tracked)?$/.test(e.command) && /workingTree/.test(e.when)), 'Stage All plus is replaced on the Changes header');
		assert.ok(inline.some(e => e.command === 'git.stageAllUntracked'));
		assert.ok(groupHeader.some(e => e.command === 'git.moveChangelistFiles' && !e.group.startsWith('inline')));

		const files = entries('scm/resourceState/context');
		for (const command of ['git.clean', 'git.openFile', 'git.stage', 'git.openChange']) {
			const entry = files.find(e => e.command === command && /workingTree/.test(e.when));
			assert.ok(entry && entry.when.includes('changelist:'), `${command} applies to changelists`);
		}

		const folders = entries('scm/resourceFolder/context');
		assert.ok(folders.some(e => e.command === 'git.moveToChangelist' && e.when.includes('changelist:')));
		assert.ok(folders.some(e => e.command === 'git.moveToChangelist' && e.group.startsWith('inline') && /untracked/.test(e.when)));

		assert.ok(entries('scm/change/title').some(e => e.command === 'git.moveChangeToChangelist'));
		assert.ok(!entries('scm/change/title').some(e => e.command === 'git.stageChange'));
		assert.strictEqual(contributes.configurationDefaults['diffEditor.codeLens'], true);
	});
});
