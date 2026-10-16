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
import { commands, ConfigurationTarget, extensions, TabInputText, Uri, window, workspace } from 'vscode';
import type { GitExtension } from '../api/git';
import type { Model } from '../model';
import type { Repository } from '../repository';

suite('commit amend editor', function () {
	this.timeout(60000);

	let root: string;
	let model: Model;
	let repository: Repository;

	const git = (...args: string[]) => cp.execFileSync('git', args, { cwd: root, encoding: 'utf8' });
	const write = (name: string, text: string) => fs.writeFileSync(path.join(root, name), text);
	const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
	const subject = () => git('log', '-1', '--format=%s').trim();
	const headFiles = () => git('show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).sort();
	const commitCount = () => Number(git('rev-list', '--count', 'HEAD').trim());
	const config = () => workspace.getConfiguration('git');

	let round = 0;

	async function stageChange(): Promise<void> {
		round++;
		write('a.txt', `a${round}\n`);
		git('add', 'a.txt');

		for (let attempt = 0; attempt < 50 && repository.indexGroup.resourceStates.length === 0; attempt++) {
			await repository.status();
			await sleep(100);
		}
	}

	function isCommitEditor(uri: Uri): boolean {
		return path.basename(uri.fsPath) === 'COMMIT_EDITMSG';
	}

	async function commitEditorTab() {
		for (let attempt = 0; attempt < 300; attempt++) {
			const tab = window.tabGroups.all.flatMap(group => group.tabs).find(t => t.input instanceof TabInputText && isCommitEditor(t.input.uri));

			if (tab) {
				return tab;
			}

			await sleep(100);
		}

		throw new Error('the commit editor tab did not appear');
	}

	async function amendThroughEditor(boxText: string): Promise<string> {
		repository.inputBox.value = boxText;

		const amend = commands.executeCommand('git.commitAmend', repository.sourceControl);
		const tab = await commitEditorTab();
		const uri = (tab.input as TabInputText).uri;
		const text = (await workspace.openTextDocument(uri)).getText();

		await window.tabGroups.close(tab);
		await amend;

		return text;
	}

	suiteSetup(async function () {
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-amend-editor-')));
		cp.execSync('git init -b main', { cwd: root });
		cp.execSync('git config user.name testuser', { cwd: root });
		cp.execSync('git config user.email monacotools@example.com', { cwd: root });
		cp.execSync('git config commit.gpgsign false', { cwd: root });
		write('a.txt', 'a\n');
		git('add', '.');
		git('commit', '-qm', '(KNX-44) fix login');

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
		await config().update('amendAlwaysEdit', undefined, ConfigurationTarget.Global);
		model.close(repository);
		fs.rmSync(root, { recursive: true, force: true });
	});

	teardown(async function () {
		await config().update('amendAlwaysEdit', undefined, ConfigurationTarget.Global);
	});

	test('amend opens the editor with the previous message even when the commit box only holds a prefix', async function () {
		const before = commitCount();
		await stageChange();

		const editorText = await amendThroughEditor('(KNX-44) ');

		assert.ok(editorText.startsWith('(KNX-44) fix login'), `the editor shows the previous message, got: ${editorText}`);
		assert.strictEqual(subject(), '(KNX-44) fix login');
		assert.strictEqual(commitCount(), before);
		assert.deepStrictEqual(headFiles(), ['a.txt']);
		assert.strictEqual(repository.inputBox.value, '(KNX-44) ', 'the commit box is left as it was');
	});

	test('amend ignores a different text in the commit box', async function () {
		await stageChange();

		const editorText = await amendThroughEditor('something else entirely');

		assert.ok(editorText.startsWith('(KNX-44) fix login'), `the editor shows the previous message, got: ${editorText}`);
		assert.strictEqual(subject(), '(KNX-44) fix login');
		assert.strictEqual(repository.inputBox.value, 'something else entirely');
	});

	test('with git.amendAlwaysEdit off the text of the commit box is used without asking', async function () {
		await config().update('amendAlwaysEdit', false, ConfigurationTarget.Global);
		await stageChange();

		repository.inputBox.value = 'reworded from the box';
		await commands.executeCommand('git.commitAmend', repository.sourceControl);

		assert.strictEqual(subject(), 'reworded from the box');
	});
});
