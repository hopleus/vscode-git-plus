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
import { findGit, Git, Repository } from '../git';
import { dropCommit, getSegment, replaceSegment, rewordCommit, undoLastCommit } from '../historyRewrite';

suite('history rewrite', () => {
	let git: Git;
	let logger: LogOutputChannel;
	const directories: string[] = [];
	const originalGitConfigCount = process.env.GIT_CONFIG_COUNT;

	suiteSetup(async () => {
		process.env.GIT_CONFIG_COUNT = '0';
		logger = window.createOutputChannel('history rewrite test', { log: true });
		const found = await findGit(['git'], () => true, logger);
		git = new Git({ gitPath: found.path, userAgent: 'history-rewrite-test', version: found.version });
	});

	suiteTeardown(() => {
		if (originalGitConfigCount === undefined) {
			delete process.env.GIT_CONFIG_COUNT;
		} else {
			process.env.GIT_CONFIG_COUNT = originalGitConfigCount;
		}

		logger.dispose();
		for (const directory of directories.splice(0)) {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	function run(cwd: string, ...args: string[]): string {
		return cp.execFileSync('git', args, { cwd, encoding: 'utf8' });
	}

	function createRepository(): string {
		const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-rewrite-')));
		directories.push(root);
		run(root, 'init', '-q', '-b', 'main');
		run(root, 'config', 'user.email', 'test@example.com');
		run(root, 'config', 'user.name', 'Test');
		run(root, 'config', 'commit.gpgsign', 'false');
		run(root, 'config', 'core.autocrlf', 'false');
		write(root, 'a.txt', 'a1\n');
		write(root, 'b.txt', 'b1\n');
		run(root, 'add', '.');
		run(root, 'commit', '-qm', 'init');
		return root;
	}

	function open(root: string): Repository {
		return new Repository(git, root, undefined, { path: path.join(root, '.git'), isBare: false }, logger);
	}

	function write(root: string, name: string, content: string): void {
		const file = path.join(root, name);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, content);
	}

	function commitFile(root: string, name: string, content: string, message: string, env: Record<string, string> = {}): string {
		write(root, name, content);
		run(root, 'add', name);
		cp.execFileSync('git', ['commit', '-qm', message], { cwd: root, env: { ...process.env, ...env } });
		return run(root, 'rev-parse', 'HEAD').trim();
	}

	const subjects = (root: string) => run(root, 'log', '--format=%s').trim().split('\n');
	const status = (root: string) => run(root, 'status', '--short').split('\n').filter(Boolean).sort();

	suite('rewordCommit', () => {
		test('rewrites the message of HEAD and leaves the index and the working tree alone', async () => {
			const root = createRepository();
			const head = commitFile(root, 'f.txt', '1\n', 'old message');
			write(root, 'a.txt', 'dirty\n');
			write(root, 'b.txt', 'staged\n');
			run(root, 'add', 'b.txt');

			const result = await rewordCommit(open(root), head, 'new message\n\nwith a body');

			assert.strictEqual(result.oldHead, head);
			assert.strictEqual(run(root, 'log', '-1', '--format=%B').trim(), 'new message\n\nwith a body');
			assert.strictEqual(run(root, 'rev-list', '--count', 'HEAD').trim(), '2');
			assert.deepStrictEqual(status(root), [' M a.txt', 'M  b.txt']);
			assert.strictEqual(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'dirty\n');
		});

		test('rewrites a middle commit and rebuilds later commits with identical trees, authors and committers', async () => {
			const root = createRepository();
			const middle = commitFile(root, 'f.txt', '1\n', 'middle', { GIT_AUTHOR_NAME: 'Alice', GIT_AUTHOR_EMAIL: 'alice@example.com', GIT_AUTHOR_DATE: '2020-01-01T10:00:00Z' });
			commitFile(root, 'g.txt', '2\n', 'after one', { GIT_AUTHOR_NAME: 'Bob', GIT_AUTHOR_EMAIL: 'bob@example.com', GIT_AUTHOR_DATE: '2020-02-02T10:00:00Z', GIT_COMMITTER_DATE: '2020-02-03T10:00:00Z' });
			commitFile(root, 'h.txt', '3\n', 'after two');
			const headBefore = run(root, 'rev-parse', 'HEAD').trim();
			const treeBefore = run(root, 'rev-parse', 'HEAD^{tree}').trim();
			const metaBefore = run(root, 'log', '--format=%an|%ae|%aI|%cn|%cI', '-2').trim();

			await rewordCommit(open(root), middle, 'renamed middle');

			assert.deepStrictEqual(subjects(root), ['after two', 'after one', 'renamed middle', 'init']);
			assert.strictEqual(run(root, 'rev-parse', 'HEAD^{tree}').trim(), treeBefore);
			assert.notStrictEqual(run(root, 'rev-parse', 'HEAD').trim(), headBefore);
			assert.strictEqual(run(root, 'log', '--format=%an|%ae|%aI|%cn|%cI', '-2').trim(), metaBefore);
			assert.strictEqual(run(root, 'log', '--format=%an|%aI', '-1', 'HEAD~2').trim(), 'Alice|2020-01-01T10:00:00Z');
			assert.deepStrictEqual(status(root), []);
		});

		test('keeps merge commits after the rewritten commit intact', async () => {
			const root = createRepository();
			const base = commitFile(root, 'f.txt', '1\n', 'base');
			run(root, 'checkout', '-qb', 'side');
			commitFile(root, 's.txt', 's\n', 'side work');
			run(root, 'checkout', '-q', 'main');
			commitFile(root, 'm.txt', 'm\n', 'main work');
			run(root, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side');
			const treeBefore = run(root, 'rev-parse', 'HEAD^{tree}').trim();

			const repository = open(root);
			await rewordCommit(repository, base, 'base renamed');

			assert.strictEqual(run(root, 'rev-parse', 'HEAD^{tree}').trim(), treeBefore);
			const head = await repository.getCommitDetails('HEAD');
			assert.strictEqual(head.message, 'merge side');
			assert.strictEqual(head.parents.length, 2);
			assert.deepStrictEqual(run(root, 'log', '--format=%s', '--first-parent').trim().split('\n'), ['merge side', 'main work', 'base renamed', 'init']);
		});

		test('works on a detached HEAD', async () => {
			const root = createRepository();
			commitFile(root, 'f.txt', '1\n', 'one');
			run(root, 'checkout', '-q', '--detach');
			const head = commitFile(root, 'g.txt', '2\n', 'detached work');

			await rewordCommit(open(root), head, 'detached renamed');

			assert.strictEqual(run(root, 'log', '-1', '--format=%s').trim(), 'detached renamed');
		});

		test('refuses when the commit is not part of the current branch', async () => {
			const root = createRepository();
			run(root, 'checkout', '-qb', 'other');
			const other = commitFile(root, 'o.txt', 'o\n', 'only on other');
			run(root, 'checkout', '-q', 'main');

			await assert.rejects(() => rewordCommit(open(root), other, 'nope'), /current branch/);
		});
	});

	suite('replaceSegment', () => {
		test('squashes a straight segment in the middle into one commit with the tree of the last one', async () => {
			const root = createRepository();
			const a = commitFile(root, 'f.txt', '1\n', 'a');
			commitFile(root, 'g.txt', '2\n', 'b');
			const c = commitFile(root, 'h.txt', '3\n', 'c');
			commitFile(root, 'i.txt', '4\n', 'tail');
			const treeBefore = run(root, 'rev-parse', 'HEAD^{tree}').trim();

			const result = await replaceSegment(open(root), { first: a, last: c, message: 'a+b+c' });

			assert.strictEqual(result.replaced.length, 3);
			assert.deepStrictEqual(subjects(root), ['tail', 'a+b+c', 'init']);
			assert.strictEqual(run(root, 'rev-parse', 'HEAD^{tree}').trim(), treeBefore);
			assert.deepStrictEqual(run(root, 'show', '--name-only', '--format=', 'HEAD~1').split('\n').filter(Boolean).sort(), ['f.txt', 'g.txt', 'h.txt']);
			assert.deepStrictEqual(status(root), []);
		});

		test('squashes up to HEAD', async () => {
			const root = createRepository();
			const a = commitFile(root, 'f.txt', '1\n', 'a');
			const b = commitFile(root, 'g.txt', '2\n', 'b');

			await replaceSegment(open(root), { first: a, last: b, message: 'ab' });

			assert.deepStrictEqual(subjects(root), ['ab', 'init']);
		});

		test('rejects a segment that contains a merge', async () => {
			const root = createRepository();
			const base = commitFile(root, 'f.txt', '1\n', 'base');
			run(root, 'checkout', '-qb', 'side');
			commitFile(root, 's.txt', 's\n', 'side');
			run(root, 'checkout', '-q', 'main');
			commitFile(root, 'm.txt', 'm\n', 'main');
			run(root, 'merge', '-q', '--no-ff', '-m', 'merge', 'side');

			await assert.rejects(() => getSegment(open(root), base, 'HEAD'), /straight line/);
		});
	});

	suite('dropCommit', () => {
		test('removes a middle commit and keeps uncommitted work', async () => {
			const root = createRepository();
			commitFile(root, 'f.txt', '1\n', 'keep');
			const unwanted = commitFile(root, 'g.txt', '2\n', 'unwanted');
			commitFile(root, 'h.txt', '3\n', 'tail');
			write(root, 'a.txt', 'dirty\n');

			await dropCommit(open(root), unwanted);

			assert.deepStrictEqual(subjects(root), ['tail', 'keep', 'init']);
			assert.strictEqual(fs.existsSync(path.join(root, 'g.txt')), false);
			assert.strictEqual(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'dirty\n');
		});

		test('drops the tip commit', async () => {
			const root = createRepository();
			commitFile(root, 'f.txt', '1\n', 'keep');
			const tip = commitFile(root, 'g.txt', '2\n', 'tip');

			await dropCommit(open(root), tip);

			assert.deepStrictEqual(subjects(root), ['keep', 'init']);
			assert.strictEqual(fs.existsSync(path.join(root, 'g.txt')), false);
		});

		test('aborts cleanly when later commits depend on the dropped one', async () => {
			const root = createRepository();
			const base = commitFile(root, 'f.txt', 'line\n', 'base');
			commitFile(root, 'f.txt', 'line changed\n', 'depends on base');
			const before = run(root, 'rev-parse', 'HEAD').trim();

			await assert.rejects(() => dropCommit(open(root), base));

			assert.strictEqual(run(root, 'rev-parse', 'HEAD').trim(), before);
			assert.strictEqual(fs.existsSync(path.join(root, '.git', 'rebase-merge')), false);
			assert.deepStrictEqual(status(root), []);
		});
	});

	suite('resetTo', () => {
		function history(root: string): string {
			const first = commitFile(root, 'f.txt', 'one\n', 'first');
			commitFile(root, 'f.txt', 'two\n', 'second');
			commitFile(root, 'g.txt', 'new\n', 'third');
			return first;
		}

		test('soft keeps files and stages the differences', async () => {
			const root = createRepository();
			const first = history(root);

			await open(root).resetTo(first, 'soft');

			assert.strictEqual(run(root, 'rev-parse', 'HEAD').trim(), first);
			assert.strictEqual(fs.readFileSync(path.join(root, 'f.txt'), 'utf8'), 'two\n');
			assert.deepStrictEqual(status(root), ['A  g.txt', 'M  f.txt']);
		});

		test('mixed keeps files and leaves the differences unstaged', async () => {
			const root = createRepository();
			const first = history(root);

			await open(root).resetTo(first, 'mixed');

			assert.strictEqual(fs.readFileSync(path.join(root, 'f.txt'), 'utf8'), 'two\n');
			assert.deepStrictEqual(status(root), [' M f.txt', '?? g.txt']);
		});

		test('hard reverts the files and drops local changes', async () => {
			const root = createRepository();
			const first = history(root);
			write(root, 'a.txt', 'local\n');

			await open(root).resetTo(first, 'hard');

			assert.strictEqual(fs.readFileSync(path.join(root, 'f.txt'), 'utf8'), 'one\n');
			assert.strictEqual(fs.existsSync(path.join(root, 'g.txt')), false);
			assert.strictEqual(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'a1\n');
		});

		test('keep reverts the files but preserves unrelated local changes', async () => {
			const root = createRepository();
			const first = history(root);
			write(root, 'a.txt', 'local\n');

			await open(root).resetTo(first, 'keep');

			assert.strictEqual(fs.readFileSync(path.join(root, 'f.txt'), 'utf8'), 'one\n');
			assert.strictEqual(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'local\n');
		});

		test('keep refuses and changes nothing when a local change would be overwritten', async () => {
			const root = createRepository();
			const first = history(root);
			const head = run(root, 'rev-parse', 'HEAD').trim();
			write(root, 'f.txt', 'local edit\n');

			await assert.rejects(() => open(root).resetTo(first, 'keep'));

			assert.strictEqual(run(root, 'rev-parse', 'HEAD').trim(), head);
			assert.strictEqual(fs.readFileSync(path.join(root, 'f.txt'), 'utf8'), 'local edit\n');
		});
	});

	suite('undoLastCommit', () => {
		test('returns the changes of the last commit to the working tree and reports what it touched', async () => {
			const root = createRepository();
			commitFile(root, 'keep.txt', 'k\n', 'before');
			write(root, 'a.txt', 'a changed\n');
			write(root, 'added.txt', 'brand new\n');
			fs.rmSync(path.join(root, 'b.txt'));
			run(root, 'add', '-A');
			run(root, 'commit', '-qm', 'KNX-45\n\nthe body');

			const result = await undoLastCommit(open(root));

			assert.deepStrictEqual([...result.paths].sort(), ['a.txt', 'added.txt', 'b.txt']);
			assert.deepStrictEqual(result.added, ['added.txt']);
			assert.strictEqual(result.message, 'KNX-45\n\nthe body');
			assert.deepStrictEqual(subjects(root), ['before', 'init']);
			assert.deepStrictEqual(status(root), [' A added.txt', ' D b.txt', ' M a.txt']);
			assert.strictEqual(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'a changed\n');
		});

		test('does not disturb changes that were staged for other files', async () => {
			const root = createRepository();
			commitFile(root, 'f.txt', 'one\n', 'to undo');
			write(root, 'a.txt', 'staged elsewhere\n');
			run(root, 'add', 'a.txt');

			await undoLastCommit(open(root));

			assert.strictEqual(run(root, 'diff', '--cached', '--name-only').trim(), 'a.txt');
			assert.deepStrictEqual(status(root), [' A f.txt', 'M  a.txt']);
		});

		test('refuses to undo a root commit', async () => {
			const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-rewrite-')));
			directories.push(root);
			run(root, 'init', '-q', '-b', 'main');
			run(root, 'config', 'user.email', 'test@example.com');
			run(root, 'config', 'user.name', 'Test');
			commitFile(root, 'f.txt', 'x\n', 'root');

			await assert.rejects(() => undoLastCommit(open(root)), /exactly one parent/);
		});
	});

	suite('published commits', () => {
		test('reports the remote branches that contain a commit', async () => {
			const root = createRepository();
			const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'git-rewrite-remote-'));
			directories.push(remote);
			run(remote, 'init', '-q', '--bare');
			run(root, 'remote', 'add', 'origin', remote);
			const pushed = commitFile(root, 'f.txt', '1\n', 'pushed');
			run(root, 'push', '-q', '-u', 'origin', 'main');
			const local = commitFile(root, 'g.txt', '2\n', 'local only');

			const repository = open(root);
			assert.deepStrictEqual(await repository.getRemoteBranchesContaining(pushed), ['origin/main']);
			assert.deepStrictEqual(await repository.getRemoteBranchesContaining(local), []);
		});
	});
});
