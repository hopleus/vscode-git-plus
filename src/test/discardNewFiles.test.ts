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
import { Status } from '../api/git.constants';
import { DEFAULT_CHANGELIST_ID } from '../changelists/changelistStore';
import type { Model } from '../model';
import type { Repository } from '../repository';

suite('discarding new files', function () {
	this.timeout(60000);

	let root: string;
	let model: Model;
	let repository: Repository;

	const git = (...args: string[]) => cp.execFileSync('git', args, { cwd: root, encoding: 'utf8' });
	const write = (name: string, text: string) => fs.writeFileSync(path.join(root, name), text);
	const exists = (name: string) => fs.existsSync(path.join(root, name));
	const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
	const pathsOf = (listId: string) => repository.changelists.resourcesIn(listId).map(r => repository.changelists.relativePath(r.resourceUri.fsPath)).sort();
	const uri = (name: string) => Uri.file(path.join(root, name));
	const tracked = () => git('ls-files').split('\n').filter(Boolean).sort();
	const isUntracked = (name: string) => repository.untrackedGroup.resourceStates.some(r => r.resourceUri.fsPath.endsWith(name));

	async function waitFor(predicate: () => boolean, description: string): Promise<void> {
		for (let attempt = 0; attempt < 100; attempt++) {
			await repository.status();

			if (predicate()) {
				return;
			}

			await sleep(200);
		}

		throw new Error(`Timeout waiting for ${description}: changes=[${pathsOf(DEFAULT_CHANGELIST_ID)}]`);
	}

	async function addNewFileToChanges(name: string): Promise<void> {
		write(name, `${name}\n`);
		await waitFor(() => isUntracked(name), `${name} untracked`);
		await repository.changelists.moveFiles([name], DEFAULT_CHANGELIST_ID);
		await waitFor(() => pathsOf(DEFAULT_CHANGELIST_ID).includes(name), `${name} in Changes`);
	}

	suiteSetup(async function () {
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-discard-new-')));
		cp.execSync('git init -b main', { cwd: root });
		cp.execSync('git config user.name testuser', { cwd: root });
		cp.execSync('git config user.email monacotools@example.com', { cwd: root });
		cp.execSync('git config commit.gpgsign false', { cwd: root });
		write('a.txt', 'a\n');
		git('add', '.');
		git('commit', '-qm', 'initial');

		await workspace.getConfiguration('git').update('discardUntrackedChangesToTrash', false, ConfigurationTarget.Global);

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
		await workspace.getConfiguration('git').update('discardUntrackedChangesToTrash', undefined, ConfigurationTarget.Global);
		model.close(repository);
		fs.rmSync(root, { recursive: true, force: true });
	});

	test('a new file that was added to Changes is intent-to-add', async function () {
		await addNewFileToChanges('new.txt');
		const resource = repository.changelists.resourcesIn(DEFAULT_CHANGELIST_ID).find(r => r.resourceUri.fsPath.endsWith('new.txt'))!;
		assert.strictEqual(resource.type, Status.INTENT_TO_ADD);

		await repository.clean([uri('new.txt')]);
		await waitFor(() => !pathsOf(DEFAULT_CHANGELIST_ID).includes('new.txt'), 'new.txt discarded');
	});

	test('discarding it deletes the file and forgets it in the index', async function () {
		await addNewFileToChanges('gone.txt');

		await repository.clean([uri('gone.txt')]);
		await waitFor(() => !pathsOf(DEFAULT_CHANGELIST_ID).includes('gone.txt'), 'gone.txt discarded');

		assert.strictEqual(exists('gone.txt'), false, 'the file is deleted, not emptied');
		assert.deepStrictEqual(tracked(), ['a.txt'], 'nothing is left in the index');
		assert.strictEqual(git('status', '--porcelain').trim(), '');
	});

	test('restore treats a new file the same way', async function () {
		await addNewFileToChanges('restored.txt');

		await repository.restore([uri('restored.txt')]);
		await waitFor(() => !pathsOf(DEFAULT_CHANGELIST_ID).includes('restored.txt'), 'restored.txt discarded');

		assert.strictEqual(exists('restored.txt'), false);
		assert.deepStrictEqual(tracked(), ['a.txt']);
	});

	test('a new file and a modified file are discarded together', async function () {
		write('a.txt', 'changed\n');
		await addNewFileToChanges('mixed.txt');
		await waitFor(() => pathsOf(DEFAULT_CHANGELIST_ID).includes('a.txt'), 'a.txt modified');

		await repository.clean([uri('mixed.txt'), uri('a.txt')]);
		await waitFor(() => pathsOf(DEFAULT_CHANGELIST_ID).length === 0, 'everything discarded');

		assert.strictEqual(exists('mixed.txt'), false);
		assert.strictEqual(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'a\n', 'the modified file is restored');
	});

	test('a plain untracked file is still deleted', async function () {
		write('plain.txt', 'plain\n');
		await waitFor(() => isUntracked('plain.txt'), 'plain.txt untracked');

		await repository.clean([uri('plain.txt')]);
		await waitFor(() => !isUntracked('plain.txt'), 'plain.txt discarded');

		assert.strictEqual(exists('plain.txt'), false);
	});
});
