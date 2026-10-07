/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { l10n, window } from 'vscode';
import { DEFAULT_CHANGELIST_ID, validateChangelistName } from './changelists/changelistStore';
import { ResetMode } from './git';
import { editMessage } from './messageEditor';
import type { Repository } from './repository';

export type MessageEditor = (initial: string, title: string) => Thenable<string | undefined>;

const SQUASH_CANDIDATES = 20;
const SHORT_HASH_LENGTH = 8;

function subjectOf(message: string): string {
	return message.split('\n')[0] ?? '';
}

function isOperationInProgress(repository: Repository): boolean {
	return !!(repository.mergeInProgress || repository.rebaseCommit || repository.cherryPickInProgress);
}

function ensureNoOperationInProgress(repository: Repository): boolean {
	if (!isOperationInProgress(repository)) {
		return true;
	}

	window.showWarningMessage(l10n.t('Finish the merge, rebase or cherry-pick that is in progress first.'));
	return false;
}

async function confirmRewrite(repository: Repository, commit: string, action: string): Promise<boolean> {
	const published = await repository.getRemoteBranchesContaining(commit);
	const warning = published.length > 0
		? l10n.t('This commit is already on {0}. {1} rewrites history and will need a force push. Continue?', published.join(', '), action)
		: l10n.t('{0}? This rewrites the commit history of the current branch.', action);
	const proceed = l10n.t('Continue');

	return (await window.showWarningMessage(warning, { modal: true }, proceed)) === proceed;
}

export async function editCommitMessage(repository: Repository, commit: string, edit: MessageEditor = editMessage): Promise<void> {
	if (!ensureNoOperationInProgress(repository)) {
		return;
	}

	const current = await repository.getCommitDetails(commit);
	const message = await edit(current.message, l10n.t('Edit Commit Message'));

	if (!message || message === current.message) {
		return;
	}

	if (!await confirmRewrite(repository, current.hash, l10n.t('Editing the message'))) {
		return;
	}

	await repository.rewordCommit(current.hash, message);
}

async function pickFirstCommitToSquash(repository: Repository, last: string): Promise<string | undefined> {
	const candidates: { hash: string; subject: string }[] = [];
	let current = await repository.getCommitDetails(last);

	while (candidates.length < SQUASH_CANDIDATES && current.parents.length === 1) {
		current = await repository.getCommitDetails(current.parents[0]);
		candidates.push({ hash: current.hash, subject: subjectOf(current.message) });
	}

	if (candidates.length === 0) {
		window.showInformationMessage(l10n.t('There is no earlier commit to squash with.'));
		return undefined;
	}

	const picked = await window.showQuickPick(
		candidates.map((candidate, index) => ({
			label: l10n.t('Squash with the {0} previous commit(s)', index + 1),
			description: l10n.t('down to "{0}"', candidate.subject),
			hash: candidate.hash
		})),
		{ placeHolder: l10n.t('How far back should the squash reach?') }
	);

	return picked?.hash;
}

export async function squashCommits(repository: Repository, last: string, edit: MessageEditor = editMessage): Promise<void> {
	if (!ensureNoOperationInProgress(repository)) {
		return;
	}

	const first = await pickFirstCommitToSquash(repository, last);

	if (!first) {
		return;
	}

	const chain = await repository.getRewriteSegment(first, last);
	const messages = await Promise.all(chain.map(hash => repository.getCommitDetails(hash).then(details => details.message)));
	const message = await edit(messages.join('\n\n'), l10n.t('Squash Commits'));

	if (!message) {
		return;
	}

	if (!await confirmRewrite(repository, first, l10n.t('Squashing {0} commits', chain.length))) {
		return;
	}

	await repository.squashCommits(first, last, message);
}

export async function dropCommit(repository: Repository, commit: string): Promise<void> {
	if (!ensureNoOperationInProgress(repository)) {
		return;
	}

	if (!await confirmRewrite(repository, commit, l10n.t('Dropping this commit'))) {
		return;
	}

	await repository.dropCommit(commit);
}

async function pickResetMode(target: string): Promise<ResetMode | undefined> {
	const modes: { mode: ResetMode; label: string; detail: string; picked?: boolean }[] = [
		{ mode: 'soft', label: l10n.t('Soft'), detail: l10n.t('Files won\'t change, differences will be staged for commit.') },
		{ mode: 'mixed', label: l10n.t('Mixed'), detail: l10n.t('Files won\'t change, differences won\'t be staged.'), picked: true },
		{ mode: 'hard', label: l10n.t('Hard'), detail: l10n.t('Files will be reverted to the state of the selected commit. Warning: any local changes will be lost.') },
		{ mode: 'keep', label: l10n.t('Keep'), detail: l10n.t('Files will be reverted to the state of the selected commit, but local changes will be kept intact.') }
	];

	const picked = await window.showQuickPick(modes, {
		title: l10n.t('Reset Current Branch to {0}', target),
		placeHolder: l10n.t('This will reset the branch head to the selected commit and update the working tree and the index according to the mode')
	});

	return picked?.mode;
}

async function confirmHardReset(hash: string): Promise<boolean> {
	const reset = l10n.t('Reset');
	const answer = await window.showWarningMessage(
		l10n.t('Hard reset to {0} will discard all uncommitted changes and the commits after it from the branch. Continue?', hash.slice(0, SHORT_HASH_LENGTH)),
		{ modal: true },
		reset
	);

	return answer === reset;
}

export async function resetBranchTo(repository: Repository, commit: string): Promise<void> {
	if (!ensureNoOperationInProgress(repository)) {
		return;
	}

	const details = await repository.getCommitDetails(commit);
	const mode = await pickResetMode(`${details.hash.slice(0, SHORT_HASH_LENGTH)} "${subjectOf(details.message)}"`);

	if (!mode || (mode === 'hard' && !await confirmHardReset(details.hash))) {
		return;
	}

	await repository.resetTo(details.hash, mode);
}

async function pickChangelistForUndo(repository: Repository, subject: string): Promise<string | undefined> {
	const { store } = repository.changelists;
	const items: { label: string; description?: string; id?: string; create?: boolean }[] = store.getLists()
		.map(list => ({ label: list.name, description: list.id === DEFAULT_CHANGELIST_ID ? l10n.t('default') : undefined, id: list.id }));

	items.push({ label: l10n.t('$(add) New Changelist…'), description: l10n.t('named after the commit: "{0}"', subject), create: true });

	const picked = await window.showQuickPick(items, {
		title: l10n.t('Undo Commit'),
		placeHolder: l10n.t('Select the changelist that receives the changes of the commit')
	});

	if (!picked) {
		return undefined;
	}

	if (!picked.create) {
		return picked.id;
	}

	const name = await window.showInputBox({
		title: l10n.t('New Changelist'),
		value: subject,
		validateInput: input => validateChangelistName(input, store.getLists())
	});

	return name === undefined ? undefined : store.create(name).id;
}

export async function undoCommitIntoChangelist(repository: Repository, commit: string | undefined): Promise<void> {
	if (!ensureNoOperationInProgress(repository)) {
		return;
	}

	const head = await repository.getCommitDetails('HEAD');

	if (commit !== undefined && commit !== head.hash) {
		window.showWarningMessage(l10n.t('Only the last commit of the current branch can be undone.'));
		return;
	}

	const listId = await pickChangelistForUndo(repository, subjectOf(head.message));

	if (listId === undefined || !await confirmRewrite(repository, head.hash, l10n.t('Undoing the commit'))) {
		return;
	}

	const result = await repository.undoLastCommit();
	await repository.status();
	await repository.changelists.moveFiles(result.paths, listId);

	if (!repository.inputBox.value) {
		repository.inputBox.value = result.message;
	}
}
