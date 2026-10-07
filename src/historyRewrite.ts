/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CommitDetails, Repository } from './git';

export interface RewriteSegment {
	readonly first: string;
	readonly last: string;
	readonly message: string;
}

export interface RewriteResult {
	readonly oldHead: string;
	readonly newHead: string;
	readonly replaced: string[];
}

export interface UndoResult {
	readonly paths: string[];
	readonly added: string[];
	readonly message: string;
}

export async function getSegment(repository: Repository, first: string, last: string): Promise<string[]> {
	const firstCommit = await repository.getCommitDetails(first);
	const lastCommit = await repository.getCommitDetails(last);

	if (firstCommit.hash === lastCommit.hash) {
		return [firstCommit.hash];
	}

	if (!await repository.isAncestor(firstCommit.hash, lastCommit.hash)) {
		throw new Error('The first commit is not an ancestor of the last one');
	}

	const between = await repository.listAncestryPath(firstCommit.hash, lastCommit.hash);
	let expectedParent = firstCommit.hash;

	for (const hash of between) {
		const commit = await repository.getCommitDetails(hash);
		if (commit.parents.length !== 1 || commit.parents[0] !== expectedParent) {
			throw new Error('The selected commits must be a straight line without merges');
		}

		expectedParent = hash;
	}

	return [firstCommit.hash, ...between];
}

export async function replaceSegment(repository: Repository, segment: RewriteSegment): Promise<RewriteResult> {
	const chain = await getSegment(repository, segment.first, segment.last);
	const first = await repository.getCommitDetails(chain[0]);
	const last = await repository.getCommitDetails(chain[chain.length - 1]);
	const oldHead = (await repository.getCommitDetails('HEAD')).hash;

	if (!await repository.isAncestor(last.hash, oldHead)) {
		throw new Error('The commits are not part of the current branch');
	}

	const created = await repository.createCommitFromTree({ tree: last.tree, parents: first.parents, message: segment.message, author: first.author });
	const mapping = new Map<string, string>([[last.hash, created]]);

	for (const hash of await repository.listAncestryPath(last.hash, oldHead)) {
		const commit = await repository.getCommitDetails(hash);
		const rebuilt = await repository.createCommitFromTree({
			tree: commit.tree,
			parents: commit.parents.map(parent => mapping.get(parent) ?? parent),
			message: commit.message,
			author: commit.author,
			committer: commit.committer
		});
		mapping.set(hash, rebuilt);
	}

	const newHead = mapping.get(oldHead) ?? created;
	await repository.updateHead(newHead, oldHead);
	return { oldHead, newHead, replaced: chain };
}

export function rewordCommit(repository: Repository, commit: string, message: string): Promise<RewriteResult> {
	return replaceSegment(repository, { first: commit, last: commit, message });
}

export async function dropCommit(repository: Repository, commit: string): Promise<void> {
	const details = await repository.getCommitDetails(commit);

	if (details.parents.length !== 1) {
		throw new Error('Only commits with exactly one parent can be dropped');
	}

	await repository.dropCommit(details.hash, details.parents[0]);
}

export async function undoLastCommit(repository: Repository): Promise<UndoResult> {
	const head: CommitDetails = await repository.getCommitDetails('HEAD');

	if (head.parents.length !== 1) {
		throw new Error('Only a commit with exactly one parent can be undone');
	}

	const entries = await repository.getNameStatusOfCommit(head.hash);
	const paths = entries.map(entry => entry.path);
	const added = entries.filter(entry => entry.status === 'A').map(entry => entry.path);

	await repository.resetTo(head.parents[0], 'soft');
	await repository.resetIndexPaths(paths);
	await repository.addIntentToAdd(added);
	return { paths, added, message: head.message };
}
