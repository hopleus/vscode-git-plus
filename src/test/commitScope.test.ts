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
import { commands, ConfigurationTarget, extensions, Uri, workspace } from 'vscode';
import type { GitExtension } from '../api/git';
import { DEFAULT_CHANGELIST_ID } from '../changelists/changelistStore';
import type { Model } from '../model';
import type { Repository } from '../repository';

suite('commit scope with smart commit enabled', function () {
	this.timeout(60000);

	let root: string;
	let model: Model;
	let repository: Repository;
	let dontPush: string;

	const git = (...args: string[]) => cp.execFileSync('git', args, { cwd: root, encoding: 'utf8' });
	const write = (name: string, text: string) => fs.writeFileSync(path.join(root, name), text);
	const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
	const head = () => git('rev-parse', 'HEAD').trim();
	const committedFiles = () => git('show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).sort();
	const modified = () => git('diff', '--name-only').split('\n').filter(Boolean).sort();
	const pathsOf = (listId: string) => repository.changelists.resourcesIn(listId).map(r => repository.changelists.relativePath(r.resourceUri.fsPath)).sort();

	async function waitFor(predicate: () => boolean, description: string): Promise<void> {
		for (let attempt = 0; attempt < 100; attempt++) {
			await repository.status();

			if (predicate()) {
				return;
			}

			await sleep(200);
		}

		throw new Error(`Timeout waiting for ${description}: default=[${pathsOf(DEFAULT_CHANGELIST_ID)}] dontPush=[${pathsOf(dontPush)}]`);
	}

	suiteSetup(async function () {
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-commit-scope-')));
		cp.execSync('git init -b main', { cwd: root });
		cp.execSync('git config user.name testuser', { cwd: root });
		cp.execSync('git config user.email monacotools@example.com', { cwd: root });
		cp.execSync('git config commit.gpgsign false', { cwd: root });

		for (const name of ['a.txt', 'b.txt', 'c.txt']) {
			write(name, `${name}\n`);
		}

		git('add', '.');
		git('commit', '-qm', 'initial');

		await workspace.getConfiguration('git').update('enableSmartCommit', true, ConfigurationTarget.Global);

		const extension = extensions.getExtension<GitExtension>('vscode.git')!;
		await extension.activate();
		model = (extension.exports as unknown as { model: Model }).model;
		await commands.executeCommand('git.openRepository', root);

		for (let attempt = 0; attempt < 50 && !model.getRepository(Uri.file(root)); attempt++) {
			await sleep(200);
		}

		repository = model.getRepository(Uri.file(root))!;
		assert.ok(repository, 'the repository is opened');
	});

	suiteTeardown(async function () {
		await workspace.getConfiguration('git').update('enableSmartCommit', undefined, ConfigurationTarget.Global);
		model.close(repository);
		fs.rmSync(root, { recursive: true, force: true });
	});

	let round = 0;

	setup(async function () {
		round++;
		write('a.txt', `a${round}\n`);
		write('b.txt', `b${round}\n`);
		write('c.txt', `c${round}\n`);

		dontPush = repository.changelists.store.create("Don't push").id;
		await waitFor(() => pathsOf(DEFAULT_CHANGELIST_ID).length === 3, 'three pending files');
		await repository.changelists.moveFiles(['b.txt'], dontPush);
		await waitFor(() => pathsOf(dontPush).length === 1, 'b.txt in Don\'t push');
	});

	teardown(async function () {
		git('reset', '-q');
		git('checkout', '-q', '--', '.');
		repository.changelists.deleteList(dontPush);
		await waitFor(() => pathsOf(DEFAULT_CHANGELIST_ID).length === 0, 'clean tree');
	});

	async function plainCommit(message: string): Promise<void> {
		repository.inputBox.value = message;
		await commands.executeCommand('git.commit', repository.sourceControl);
	}

	test('a plain Commit with nothing staged commits nothing', async function () {
		const before = head();

		await plainCommit('should not happen');

		assert.strictEqual(head(), before);
		assert.deepStrictEqual(modified(), ['a.txt', 'b.txt', 'c.txt']);
		assert.deepStrictEqual(pathsOf(dontPush), ['b.txt']);
	});

	test('a plain Commit commits only the staged files', async function () {
		git('add', 'c.txt');
		await waitFor(() => pathsOf(DEFAULT_CHANGELIST_ID).length === 1, 'c.txt staged');

		await plainCommit('staged only');

		assert.deepStrictEqual(committedFiles(), ['c.txt']);
		assert.deepStrictEqual(modified(), ['a.txt', 'b.txt']);
		assert.deepStrictEqual(pathsOf(dontPush), ['b.txt']);
	});

	test('Commit All takes the Changes list and leaves other changelists alone', async function () {
		repository.inputBox.value = 'all of Changes';
		await commands.executeCommand('git.commitAll', repository.sourceControl);

		assert.deepStrictEqual(committedFiles(), ['a.txt', 'c.txt']);
		assert.deepStrictEqual(modified(), ['b.txt']);
		assert.deepStrictEqual(pathsOf(dontPush), ['b.txt']);
	});

	test('a changelist cannot be committed while a merge is in progress', async function () {
		const before = head();
		Object.defineProperty(repository, 'mergeInProgress', { value: true, writable: true, configurable: true });

		try {
			repository.inputBox.value = 'during merge';
			await commands.executeCommand('git.commitChangelist', repository.changelists.groupOfList(dontPush));
		} finally {
			Object.defineProperty(repository, 'mergeInProgress', { value: false, writable: true, configurable: true });
		}

		assert.strictEqual(head(), before);
		assert.deepStrictEqual(modified(), ['a.txt', 'b.txt', 'c.txt']);
	});
});
