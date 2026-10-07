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
import { LogOutputChannel, window } from 'vscode';
import { buildPatch, parseHunks } from '../changelists/hunks';
import { findGit, Git, Repository } from '../git';

suite('git changelist primitives', () => {
	let git: Git;
	let logger: LogOutputChannel;
	const directories: string[] = [];

	suiteSetup(async () => {
		logger = window.createOutputChannel('git primitives test', { log: true });
		const found = await findGit(['git'], () => true, logger);
		git = new Git({ gitPath: found.path, userAgent: 'git-primitives-test', version: found.version });
	});

	suiteTeardown(() => {
		logger.dispose();
		for (const directory of directories.splice(0)) {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	const run = (cwd: string, ...args: string[]) => cp.execFileSync('git', args, { cwd, encoding: 'utf8' });
	const rows = (prefix: string) => Array.from({ length: 40 }, (_, index) => `${prefix}${index + 1}`);
	const content = (values: string[]) => `${values.join('\n')}\n`;

	function write(root: string, name: string, text: string): void {
		const file = path.join(root, name);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, text);
	}

	function createRepository(): { root: string; repository: Repository } {
		const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-primitives-')));
		directories.push(root);
		run(root, 'init', '-q', '-b', 'main');
		run(root, 'config', 'user.email', 'test@example.com');
		run(root, 'config', 'user.name', 'Test');
		run(root, 'config', 'commit.gpgsign', 'false');
		write(root, 'f.txt', content(rows('line')));
		write(root, 'other.txt', 'other\n');
		run(root, 'add', '.');
		run(root, 'commit', '-qm', 'init');
		const repository = new Repository(git, root, undefined, { path: path.join(root, '.git'), isBare: false }, logger);
		return { root, repository };
	}

	function editTwoHunks(root: string): string[] {
		const edited = rows('line');
		edited[2] = 'CHANGED3';
		edited[30] = 'CHANGED31';
		write(root, 'f.txt', content(edited));
		return edited;
	}

	suite('getHunksDiff', () => {
		test('lists zero-context hunks against HEAD', async () => {
			const { root, repository } = createRepository();
			editTwoHunks(root);

			const file = parseHunks('f.txt', await repository.getHunksDiff('f.txt'));
			assert.deepStrictEqual(file.hunks.map(h => h.id), ['3,1', '31,1']);
		});

		test('lists only staged hunks with cached', async () => {
			const { root, repository } = createRepository();
			editTwoHunks(root);
			const file = parseHunks('f.txt', await repository.getHunksDiff('f.txt'));
			await repository.applyPatchToIndex(buildPatch('f.txt', [file.hunks[1]]));

			const staged = parseHunks('f.txt', await repository.getHunksDiff('f.txt', { cached: true }));
			assert.deepStrictEqual(staged.hunks.map(h => h.id), ['31,1']);
		});

		test('reports binary files without hunks', async () => {
			const { root, repository } = createRepository();
			fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([0, 1, 2, 3]));
			run(root, 'add', 'bin.dat');
			run(root, 'commit', '-qm', 'binary');
			fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([0, 9, 9, 9]));

			const file = parseHunks('bin.dat', await repository.getHunksDiff('bin.dat'));
			assert.strictEqual(file.binary, true);
			assert.strictEqual(file.hunks.length, 0);
		});
	});

	suite('applyPatchToIndex', () => {
		test('stages one hunk and leaves the working tree untouched', async () => {
			const { root, repository } = createRepository();
			const edited = editTwoHunks(root);
			const file = parseHunks('f.txt', await repository.getHunksDiff('f.txt'));

			await repository.applyPatchToIndex(buildPatch('f.txt', [file.hunks[0]]));

			const staged = run(root, 'show', ':f.txt').split('\n');
			assert.strictEqual(staged[2], 'CHANGED3');
			assert.strictEqual(staged[30], 'line31');
			assert.strictEqual(fs.readFileSync(path.join(root, 'f.txt'), 'utf8'), content(edited));
		});

		test('rejects a patch that does not apply', async () => {
			const { root, repository } = createRepository();
			editTwoHunks(root);
			const file = parseHunks('f.txt', await repository.getHunksDiff('f.txt'));
			write(root, 'f.txt', content(rows('moved')));
			run(root, 'add', 'f.txt');

			await assert.rejects(repository.applyPatchToIndex(buildPatch('f.txt', [file.hunks[0]])));
		});
	});

	suite('showWithPatch', () => {
		test('shows HEAD content plus the given hunks without touching the index', async () => {
			const { root, repository } = createRepository();
			editTwoHunks(root);
			const file = parseHunks('f.txt', await repository.getHunksDiff('f.txt'));

			const shown = (await repository.showWithPatch('f.txt', buildPatch('f.txt', [file.hunks[1]]))).split('\n');
			assert.strictEqual(shown[30], 'CHANGED31');
			assert.strictEqual(shown[2], 'line3');
			assert.strictEqual(run(root, 'diff', '--cached', '--name-only').trim(), '');
		});

		test('shows plain HEAD content when there is no patch', async () => {
			const { repository } = createRepository();

			assert.strictEqual(await repository.showWithPatch('f.txt', undefined), content(rows('line')));
		});

		test('removes its temporary index', async () => {
			const { root, repository } = createRepository();
			editTwoHunks(root);
			const before = fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('git-index-'));
			const file = parseHunks('f.txt', await repository.getHunksDiff('f.txt'));

			await repository.showWithPatch('f.txt', buildPatch('f.txt', [file.hunks[0]]));
			await repository.showWithPatch('f.txt', 'garbage').catch(() => undefined);

			const after = fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('git-index-') && !before.includes(name));
			assert.deepStrictEqual(after, []);
		});
	});

	suite('intent to add and index reset', () => {
		test('marks new files as intent-to-add without staging their content', async () => {
			const { root, repository } = createRepository();
			write(root, 'new.txt', 'new\n');
			write(root, 'dir/inner.txt', 'inner\n');

			await repository.addIntentToAdd(['new.txt', 'dir/inner.txt']);

			assert.deepStrictEqual(run(root, 'status', '--short').split('\n').filter(Boolean).sort(), [' A dir/inner.txt', ' A new.txt']);
			assert.strictEqual(run(root, 'diff', '--cached', '--name-only').trim(), '');
		});

		test('resets only the given paths in the index', async () => {
			const { root, repository } = createRepository();
			write(root, 'f.txt', 'changed\n');
			write(root, 'other.txt', 'changed\n');
			run(root, 'add', '.');

			await repository.resetIndexPaths(['f.txt']);

			assert.strictEqual(run(root, 'diff', '--cached', '--name-only').trim(), 'other.txt');
		});
	});

	suite('createSelectionIndex', () => {
		test('combines whole files and hunks on top of HEAD', async () => {
			const { root, repository } = createRepository();
			editTwoHunks(root);
			write(root, 'other.txt', 'other changed\n');
			const file = parseHunks('f.txt', await repository.getHunksDiff('f.txt'));

			const index = await repository.createSelectionIndex({
				paths: ['other.txt'],
				patches: [{ path: 'f.txt', patch: buildPatch('f.txt', [file.hunks[1]]) }]
			});

			try {
				const env = { ...process.env, GIT_INDEX_FILE: index.file };
				const staged = cp.execFileSync('git', ['show', ':f.txt'], { cwd: root, env, encoding: 'utf8' }).split('\n');
				assert.strictEqual(staged[30], 'CHANGED31');
				assert.strictEqual(staged[2], 'line3');
				assert.strictEqual(cp.execFileSync('git', ['show', ':other.txt'], { cwd: root, env, encoding: 'utf8' }), 'other changed\n');
				assert.deepStrictEqual([...index.touched].sort(), ['f.txt', 'other.txt']);
				assert.strictEqual(run(root, 'diff', '--cached', '--name-only').trim(), '', 'the real index is untouched');
			} finally {
				await index.dispose();
			}

			assert.strictEqual(fs.existsSync(index.file), false);
		});

		test('records deleted files', async () => {
			const { root, repository } = createRepository();
			fs.rmSync(path.join(root, 'other.txt'));

			const index = await repository.createSelectionIndex({ paths: ['other.txt'], patches: [] });

			try {
				const env = { ...process.env, GIT_INDEX_FILE: index.file };
				assert.strictEqual(cp.execFileSync('git', ['ls-files', 'other.txt'], { cwd: root, env, encoding: 'utf8' }), '');
			} finally {
				await index.dispose();
			}
		});

		test('refuses while there are unmerged paths', async () => {
			const { root, repository } = createRepository();
			run(root, 'checkout', '-qb', 'side');
			write(root, 'other.txt', 'side\n');
			run(root, 'commit', '-qam', 'side');
			run(root, 'checkout', '-q', 'main');
			write(root, 'other.txt', 'main\n');
			run(root, 'commit', '-qam', 'main');
			try {
				run(root, 'merge', 'side');
			} catch {
				// conflict is expected
			}

			await assert.rejects(repository.createSelectionIndex({ paths: ['f.txt'], patches: [] }), /unmerged/);
		});

		test('cleans up when a patch does not apply', async () => {
			const { repository } = createRepository();
			const before = fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('git-index-'));

			await assert.rejects(repository.createSelectionIndex({ paths: [], patches: [{ path: 'f.txt', patch: 'not a patch' }] }));

			const after = fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('git-index-') && !before.includes(name));
			assert.deepStrictEqual(after, []);
		});
	});

	suite('commit with a selection index', () => {
		test('commits only the selection and keeps the real index and working tree', async () => {
			const { root, repository } = createRepository();
			const edited = editTwoHunks(root);
			write(root, 'other.txt', 'staged elsewhere\n');
			run(root, 'add', 'other.txt');
			const file = parseHunks('f.txt', await repository.getHunksDiff('f.txt'));

			const index = await repository.createSelectionIndex({ paths: [], patches: [{ path: 'f.txt', patch: buildPatch('f.txt', [file.hunks[1]]) }] });
			try {
				await repository.commit('only second hunk', { requireUserConfig: false }, index.file);
			} finally {
				await index.dispose();
			}

			assert.strictEqual(run(root, 'log', '-1', '--format=%s').trim(), 'only second hunk');
			assert.deepStrictEqual(run(root, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean), ['f.txt']);
			assert.strictEqual(run(root, 'show', 'HEAD:f.txt').split('\n')[2], 'line3');
			assert.strictEqual(run(root, 'show', ':f.txt').split('\n')[30], 'line31', 'the real index was not written');
			assert.strictEqual(fs.readFileSync(path.join(root, 'f.txt'), 'utf8'), content(edited));

			await repository.resetIndexPaths(['f.txt']);

			assert.strictEqual(run(root, 'diff', '--cached', '--name-only').trim(), 'other.txt');
			assert.strictEqual(run(root, 'diff', '--name-only').trim(), 'f.txt');
		});
	});
});
