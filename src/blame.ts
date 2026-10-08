/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DecorationOptions, l10n, Position, Range, TextEditor, TextEditorChange, TextEditorDecorationType, TextEditorChangeKind, ThemeColor, Uri, window, workspace, EventEmitter, ConfigurationChangeEvent, StatusBarItem, StatusBarAlignment, Command, MarkdownString, languages, HoverProvider, CancellationToken, Hover, TextDocument, commands } from 'vscode';
import { Model } from './model';
import { dispose, fromNow, getCommitShortHash, IDisposable, truncate } from './util';
import { Repository } from './repository';
import { throttle } from './decorators';
import { BlameInformation, Commit } from './git';
import { fromGitUri, isGitUri, toGitUri } from './uri';
import { emojify, ensureEmojis } from './emoji';
import { getWorkingTreeAndIndexDiffInformation, getWorkingTreeDiffInformation } from './staging';
import { provideSourceControlHistoryItemAvatar, provideSourceControlHistoryItemHoverCommands, provideSourceControlHistoryItemMessageLinks } from './historyItemDetailsProvider';
import type { AvatarQuery, AvatarQueryCommit } from './api/git';
import { LRUCache } from './cache';
import { AVATAR_SIZE, getCommitHover, getHoverCommitHashCommands, processHoverRemoteCommands } from './hover';

function lineRangesContainLine(changes: readonly TextEditorChange[], lineNumber: number): boolean {
	return changes.some(c => c.modified.startLineNumber <= lineNumber && lineNumber < c.modified.endLineNumberExclusive);
}

function lineRangeLength(startLineNumber: number, endLineNumberExclusive: number): number {
	return endLineNumberExclusive - startLineNumber;
}

function mapModifiedLineNumberToOriginalLineNumber(lineNumber: number, changes: readonly TextEditorChange[]): number {
	if (changes.length === 0) {
		return lineNumber;
	}

	for (const change of changes) {
		// Do not process changes after the line number
		if (lineNumber < change.modified.startLineNumber) {
			break;
		}

		// Map line number to the original line number
		if (change.kind === TextEditorChangeKind.Addition) {
			// Addition
			lineNumber = lineNumber - lineRangeLength(change.modified.startLineNumber, change.modified.endLineNumberExclusive);
		} else if (change.kind === TextEditorChangeKind.Deletion) {
			// Deletion
			lineNumber = lineNumber + lineRangeLength(change.original.startLineNumber, change.original.endLineNumberExclusive);
		} else if (change.kind === TextEditorChangeKind.Modification) {
			// Modification
			const originalRangeLength = lineRangeLength(change.original.startLineNumber, change.original.endLineNumberExclusive);
			const modifiedRangeLength = lineRangeLength(change.modified.startLineNumber, change.modified.endLineNumberExclusive);

			if (originalRangeLength !== modifiedRangeLength) {
				lineNumber = lineNumber - (modifiedRangeLength - originalRangeLength);
			}
		} else {
			throw new Error('Unexpected change kind');
		}
	}

	return lineNumber;
}

function getEditorDecorationRange(lineNumber: number): Range {
	const position = new Position(lineNumber, Number.MAX_SAFE_INTEGER);
	return new Range(position, position);
}

function isResourceSchemeSupported(uri: Uri): boolean {
	return uri.scheme === 'file' || isGitUri(uri);
}

function isResourceBlameInformationEqual(a: ResourceBlameInformation | undefined, b: ResourceBlameInformation | undefined): boolean {
	if (a === b) {
		return true;
	}

	if (!a || !b ||
		a.resource.toString() !== b.resource.toString() ||
		a.blameInformation.length !== b.blameInformation.length) {
		return false;
	}

	for (let index = 0; index < a.blameInformation.length; index++) {
		if (a.blameInformation[index].lineNumber !== b.blameInformation[index].lineNumber) {
			return false;
		}

		const aBlameInformation = a.blameInformation[index].blameInformation;
		const bBlameInformation = b.blameInformation[index].blameInformation;

		if (typeof aBlameInformation === 'string' && typeof bBlameInformation === 'string') {
			if (aBlameInformation !== bBlameInformation) {
				return false;
			}
		} else if (typeof aBlameInformation !== 'string' && typeof bBlameInformation !== 'string') {
			if (aBlameInformation.hash !== bBlameInformation.hash) {
				return false;
			}
		} else {
			return false;
		}
	}

	return true;
}

type BlameInformationTemplateTokens = {
	readonly hash: string;
	readonly hashShort: string;
	readonly subject: string;
	readonly authorName: string;
	readonly authorEmail: string;
	readonly authorDate: string;
	readonly authorDateAgo: string;
};

interface ResourceBlameInformation {
	readonly resource: Uri;
	readonly blameInformation: readonly LineBlameInformation[];
}

interface LineBlameInformation {
	readonly lineNumber: number;
	readonly blameInformation: BlameInformation | string;
}

class GitBlameInformationCache {
	private readonly _cache = new Map<Repository, LRUCache<string, BlameInformation[]>>();

	clear(): void {
		this._cache.clear();
	}

	delete(repository: Repository): boolean {
		return this._cache.delete(repository);
	}

	get(repository: Repository, resource: Uri, commit: string): BlameInformation[] | undefined {
		const key = this._getCacheKey(resource, commit);
		return this._cache.get(repository)?.get(key);
	}

	set(repository: Repository, resource: Uri, commit: string, blameInformation: BlameInformation[]): void {
		if (!this._cache.has(repository)) {
			this._cache.set(repository, new LRUCache<string, BlameInformation[]>(100));
		}

		const key = this._getCacheKey(resource, commit);
		this._cache.get(repository)!.set(key, blameInformation);
	}

	private _getCacheKey(resource: Uri, commit: string): string {
		return toGitUri(resource, commit).toString();
	}
}

export class GitBlameController {
	private readonly _subjectMaxLength = 50;

	private readonly _onDidChangeBlameInformation = new EventEmitter<void>();
	public readonly onDidChangeBlameInformation = this._onDidChangeBlameInformation.event;

	private _textEditorBlameInformation: ResourceBlameInformation | undefined;
	get textEditorBlameInformation(): ResourceBlameInformation | undefined {
		return this._textEditorBlameInformation;
	}
	private set textEditorBlameInformation(blameInformation: ResourceBlameInformation | undefined) {
		if (isResourceBlameInformationEqual(this._textEditorBlameInformation, blameInformation)) {
			return;
		}

		this._textEditorBlameInformation = blameInformation;
		this._onDidChangeBlameInformation.fire();
	}

	private _HEAD: string | undefined;
	private readonly _commitInformationCache = new LRUCache<string, Commit>(100);
	private readonly _repositoryBlameCache = new GitBlameInformationCache();

	private _editorDecoration: GitBlameEditorDecoration | undefined;
	private _annotation: GitBlameAnnotation | undefined;
	private _statusBarItem: GitBlameStatusBarItem | undefined;

	private _repositoryDisposables = new Map<Repository, IDisposable[]>();
	private _enablementDisposables: IDisposable[] = [];
	private _disposables: IDisposable[] = [];

	constructor(private readonly _model: Model) {
		workspace.onDidChangeConfiguration(this._onDidChangeConfiguration, this, this._disposables);
		this._onDidChangeConfiguration();

		this._annotation = new GitBlameAnnotation(this);
		this._disposables.push(this._annotation);
	}

	async getFileBlameInformation(textEditor: TextEditor): Promise<(BlameInformation | string | undefined)[] | undefined> {
		const uri = textEditor.document.uri;
		if (!isResourceSchemeSupported(uri)) {
			return undefined;
		}

		const repository = this._model.getRepository(uri);
		if (!repository) {
			return undefined;
		}

		await ensureEmojis();

		let resourceBlameInformation: BlameInformation[] | undefined;
		if (!isGitUri(uri)) {
			resourceBlameInformation = await repository.blameContents(uri.fsPath, textEditor.document.getText());
		} else {
			const { ref } = fromGitUri(uri);
			if (ref === '') {
				resourceBlameInformation = await repository.blameContents(uri.fsPath, textEditor.document.getText());
			} else {
				const commit = /^[0-9a-f]{40}$/i.test(ref) ? ref : repository.HEAD?.commit;
				resourceBlameInformation = commit ? await this._getBlameInformation(uri, commit) : undefined;
			}
		}

		if (!resourceBlameInformation) {
			return undefined;
		}

		const byLine = new Map<number, BlameInformation>();
		for (const info of resourceBlameInformation) {
			for (const range of info.ranges) {
				for (let line = range.startLineNumber; line <= range.endLineNumber; line++) {
					byLine.set(line, info);
				}
			}
		}

		const result: (BlameInformation | string | undefined)[] = [];
		for (let lineNumber = 0; lineNumber < textEditor.document.lineCount; lineNumber++) {
			const info = byLine.get(lineNumber + 1);
			result.push(info && /^0+$/.test(info.hash) ? l10n.t('Not Committed Yet') : info);
		}

		return result;
	}

	formatBlameInformationMessage(documentUri: Uri, template: string, blameInformation: BlameInformation): string {
		const templateTokens = {
			hash: blameInformation.hash,
			hashShort: getCommitShortHash(documentUri, blameInformation.hash),
			subject: emojify(truncate(blameInformation.subject ?? '', this._subjectMaxLength)),
			authorName: blameInformation.authorName ?? '',
			authorEmail: blameInformation.authorEmail ?? '',
			authorDate: new Date(blameInformation.authorDate ?? new Date()).toLocaleString(),
			authorDateAgo: fromNow(blameInformation.authorDate ?? new Date(), true, true)
		} satisfies BlameInformationTemplateTokens;

		return template.replace(/\$\{(.+?)\}/g, (_, token) => {
			return templateTokens.hasOwnProperty(token)
				? templateTokens[token as keyof BlameInformationTemplateTokens]
				: `\${${token}}`;
		});
	}

	async getBlameInformationHover(documentUri: Uri, blameInformation: BlameInformation): Promise<MarkdownString> {
		const remoteHoverCommands: Command[] = [];
		let commitAvatar: string | undefined;
		let commitInformation: Commit | undefined;
		let commitMessageWithLinks: string | undefined;

		const repository = this._model.getRepository(documentUri);
		if (repository) {
			try {
				// Commit details
				commitInformation = this._commitInformationCache.get(blameInformation.hash);
				if (!commitInformation) {
					commitInformation = await repository.getCommit(blameInformation.hash);
					this._commitInformationCache.set(blameInformation.hash, commitInformation);
				}

				// Avatar
				const avatarQuery = {
					commits: [{
						hash: blameInformation.hash,
						authorName: blameInformation.authorName,
						authorEmail: blameInformation.authorEmail
					} satisfies AvatarQueryCommit],
					size: AVATAR_SIZE
				} satisfies AvatarQuery;

				const avatarResult = await provideSourceControlHistoryItemAvatar(this._model, repository, avatarQuery);
				commitAvatar = avatarResult?.get(blameInformation.hash);
			} catch { }

			// Remote hover commands
			const unpublishedCommits = await repository.getUnpublishedCommits();
			if (!unpublishedCommits.has(blameInformation.hash)) {
				remoteHoverCommands.push(...await provideSourceControlHistoryItemHoverCommands(this._model, repository) ?? []);
			}

			// Message links
			commitMessageWithLinks = await provideSourceControlHistoryItemMessageLinks(
				this._model, repository, commitInformation?.message ?? blameInformation.subject ?? '');
		}

		const hash = commitInformation?.hash ?? blameInformation.hash;
		const authorName = commitInformation?.authorName ?? blameInformation.authorName;
		const authorEmail = commitInformation?.authorEmail ?? blameInformation.authorEmail;
		const authorDate = commitInformation?.authorDate ?? blameInformation.authorDate;
		const message = commitMessageWithLinks ?? commitInformation?.message ?? blameInformation.subject ?? '';

		// Commands
		const commands: Command[][] = [
			getHoverCommitHashCommands(documentUri, hash),
			processHoverRemoteCommands(remoteHoverCommands, hash)
		];

		commands.push([{
			title: `$(gear)`,
			tooltip: l10n.t('Open Settings'),
			command: 'workbench.action.openSettings',
			arguments: ['git.blame']
		}] satisfies Command[]);

		return getCommitHover(commitAvatar, authorName, authorEmail, authorDate, message, commitInformation?.shortStat, commands, commitInformation?.coAuthors);
	}

	private _onDidChangeConfiguration(e?: ConfigurationChangeEvent): void {
		if (e &&
			!e.affectsConfiguration('git.blame.ignoreWhitespace') &&
			!e.affectsConfiguration('git.blame.editorDecoration.enabled') &&
			!e.affectsConfiguration('git.blame.statusBarItem.enabled')) {
			return;
		}

		// Clear cache when ignoreWhitespace setting changes
		if (e && e.affectsConfiguration('git.blame.ignoreWhitespace')) {
			this._repositoryBlameCache.clear();
			this._updateTextEditorBlameInformation(window.activeTextEditor);
			return;
		}

		const config = workspace.getConfiguration('git');
		const editorDecorationEnabled = config.get<boolean>('blame.editorDecoration.enabled') === true;
		const statusBarItemEnabled = config.get<boolean>('blame.statusBarItem.enabled') === true;

		// Editor decoration
		if (editorDecorationEnabled) {
			if (!this._editorDecoration) {
				this._editorDecoration = new GitBlameEditorDecoration(this);
			}
		} else {
			this._editorDecoration?.dispose();
			this._editorDecoration = undefined;
		}

		// StatusBar item
		if (statusBarItemEnabled) {
			if (!this._statusBarItem) {
				this._statusBarItem = new GitBlameStatusBarItem(this);
			}
		} else {
			this._statusBarItem?.dispose();
			this._statusBarItem = undefined;
		}

		// Listeners
		if (editorDecorationEnabled || statusBarItemEnabled) {
			if (this._enablementDisposables.length === 0) {
				this._model.onDidOpenRepository(this._onDidOpenRepository, this, this._enablementDisposables);
				this._model.onDidCloseRepository(this._onDidCloseRepository, this, this._enablementDisposables);
				for (const repository of this._model.repositories) {
					this._onDidOpenRepository(repository);
				}

				window.onDidChangeActiveTextEditor(e => this._updateTextEditorBlameInformation(e), this, this._enablementDisposables);
				window.onDidChangeTextEditorSelection(e => this._updateTextEditorBlameInformation(e.textEditor, 'selection'), this, this._enablementDisposables);
				window.onDidChangeTextEditorDiffInformation(e => this._updateTextEditorBlameInformation(e.textEditor), this, this._enablementDisposables);
			}
		} else {
			this._enablementDisposables = dispose(this._enablementDisposables);
		}

		this._updateTextEditorBlameInformation(window.activeTextEditor);
	}

	private _onDidOpenRepository(repository: Repository): void {
		const repositoryDisposables: IDisposable[] = [];
		repository.onDidRunGitStatus(() => this._onDidRunGitStatus(repository), this, repositoryDisposables);

		this._repositoryDisposables.set(repository, repositoryDisposables);
	}

	private _onDidCloseRepository(repository: Repository): void {
		const disposables = this._repositoryDisposables.get(repository);
		if (disposables) {
			dispose(disposables);
		}

		this._repositoryDisposables.delete(repository);
		this._repositoryBlameCache.delete(repository);
	}

	private _onDidRunGitStatus(repository: Repository): void {
		if (!repository.HEAD?.commit || this._HEAD === repository.HEAD.commit) {
			return;
		}

		this._HEAD = repository.HEAD.commit;
		this._updateTextEditorBlameInformation(window.activeTextEditor);
	}

	private async _getBlameInformation(resource: Uri, commit: string): Promise<BlameInformation[] | undefined> {
		const repository = this._model.getRepository(resource);
		if (!repository) {
			return undefined;
		}

		const resourceBlameInformation = this._repositoryBlameCache.get(repository, resource, commit);
		if (resourceBlameInformation) {
			return resourceBlameInformation;
		}

		// Ensure that the emojis are loaded as we will need
		// access to them when formatting the blame information.
		await ensureEmojis();

		// Get blame information for the resource and cache it
		const blameInformation = await repository.blame2(resource.fsPath, commit) ?? [];
		this._repositoryBlameCache.set(repository, resource, commit, blameInformation);

		return blameInformation;
	}

	@throttle
	private async _updateTextEditorBlameInformation(textEditor: TextEditor | undefined, reason?: 'selection'): Promise<void> {
		if (textEditor) {
			if (!textEditor.diffInformation || textEditor !== window.activeTextEditor) {
				return;
			}
		} else {
			this.textEditorBlameInformation = undefined;
			return;
		}

		const repository = this._model.getRepository(textEditor.document.uri);
		if (!repository || !repository.HEAD?.commit) {
			return;
		}

		// Only support resources with `file` and `git` schemes
		if (!isResourceSchemeSupported(textEditor.document.uri)) {
			this.textEditorBlameInformation = undefined;
			return;
		}

		// Do not show blame information when there is a single selection and it is at the beginning
		// of the file [0, 0, 0, 0] unless the user explicitly navigates the cursor there. We do this
		// to avoid showing blame information when the editor is not focused.
		if (reason !== 'selection' && textEditor.selections.length === 1 &&
			textEditor.selections[0].start.line === 0 && textEditor.selections[0].start.character === 0 &&
			textEditor.selections[0].end.line === 0 && textEditor.selections[0].end.character === 0) {
			this.textEditorBlameInformation = undefined;
			return;
		}

		let allChanges: readonly TextEditorChange[];
		let workingTreeChanges: readonly TextEditorChange[];
		let workingTreeAndIndexChanges: readonly TextEditorChange[] | undefined;

		if (isGitUri(textEditor.document.uri)) {
			const { ref } = fromGitUri(textEditor.document.uri);

			// For the following scenarios we can discard the diff information
			// 1) Commit - Resource in the multi-file diff editor when viewing the details of a commit.
			// 2) HEAD   - Resource on the left-hand side of the diff editor when viewing a resource from the index.
			// 3) ~      - Resource on the left-hand side of the diff editor when viewing a resource from the working tree.
			if (/^[0-9a-f]{40}$/i.test(ref) || ref === 'HEAD' || ref === '~') {
				workingTreeChanges = allChanges = [];
				workingTreeAndIndexChanges = undefined;
			} else if (ref === '') {
				// Resource on the right-hand side of the diff editor when viewing a resource from the index.
				const diffInformationWorkingTreeAndIndex = getWorkingTreeAndIndexDiffInformation(textEditor);

				// Working tree + index diff information is present and it is stale. Diff information
				// may be stale when the selection changes because of a content change and the diff
				// information is not yet updated.
				if (diffInformationWorkingTreeAndIndex && diffInformationWorkingTreeAndIndex.isStale) {
					this.textEditorBlameInformation = undefined;
					return;
				}

				workingTreeChanges = [];
				workingTreeAndIndexChanges = allChanges = diffInformationWorkingTreeAndIndex?.changes ?? [];
			} else {
				throw new Error(`Unexpected ref: ${ref}`);
			}
		} else {
			// Working tree diff information. Diff Editor (Working Tree) -> Text Editor
			const diffInformationWorkingTree = getWorkingTreeDiffInformation(textEditor);

			// Working tree diff information is not present or it is stale. Diff information
			// may be stale when the selection changes because of a content change and the diff
			// information is not yet updated.
			if (!diffInformationWorkingTree || diffInformationWorkingTree.isStale) {
				this.textEditorBlameInformation = undefined;
				return;
			}

			// Working tree + index diff information
			const diffInformationWorkingTreeAndIndex = getWorkingTreeAndIndexDiffInformation(textEditor);

			// Working tree + index diff information is present and it is stale. Diff information
			// may be stale when the selection changes because of a content change and the diff
			// information is not yet updated.
			if (diffInformationWorkingTreeAndIndex && diffInformationWorkingTreeAndIndex.isStale) {
				this.textEditorBlameInformation = undefined;
				return;
			}

			workingTreeChanges = diffInformationWorkingTree.changes;
			workingTreeAndIndexChanges = diffInformationWorkingTreeAndIndex?.changes;

			// For staged resources, we provide an additional "original resource" so that the editor
			// diff information contains both the changes that are in the working tree and the changes
			// that are in the working tree + index.
			allChanges = workingTreeAndIndexChanges ?? workingTreeChanges;
		}

		let commit: string;
		if (!isGitUri(textEditor.document.uri)) {
			// Resource with the `file` scheme
			commit = repository.HEAD.commit;
		} else {
			// Resource with the `git` scheme
			const { ref } = fromGitUri(textEditor.document.uri);
			commit = /^[0-9a-f]{40}$/i.test(ref) ? ref : repository.HEAD.commit;
		}

		// Git blame information
		const resourceBlameInformation = await this._getBlameInformation(textEditor.document.uri, commit);
		if (!resourceBlameInformation) {
			return;
		}

		const lineBlameInformation: LineBlameInformation[] = [];
		for (const lineNumber of new Set(textEditor.selections.map(s => s.active.line))) {
			// Check if the line is contained in the working tree diff information
			if (lineRangesContainLine(workingTreeChanges, lineNumber + 1)) {
				if (reason === 'selection') {
					// Only show the `Not Committed Yet` message upon selection change due to navigation
					lineBlameInformation.push({ lineNumber, blameInformation: l10n.t('Not Committed Yet') });
				}
				continue;
			}

			// Check if the line is contained in the working tree + index diff information
			if (lineRangesContainLine(workingTreeAndIndexChanges ?? [], lineNumber + 1)) {
				lineBlameInformation.push({ lineNumber, blameInformation: l10n.t('Not Committed Yet (Staged)') });
				continue;
			}

			// Map the line number to the git blame ranges using the diff information
			const lineNumberWithDiff = mapModifiedLineNumberToOriginalLineNumber(lineNumber + 1, allChanges);
			const blameInformation = resourceBlameInformation.find(blameInformation => {
				return blameInformation.ranges.find(range => {
					return lineNumberWithDiff >= range.startLineNumber && lineNumberWithDiff <= range.endLineNumber;
				});
			});

			if (blameInformation) {
				lineBlameInformation.push({ lineNumber, blameInformation });
			}
		}

		this.textEditorBlameInformation = {
			resource: textEditor.document.uri,
			blameInformation: lineBlameInformation
		};
	}

	dispose() {
		for (const disposables of this._repositoryDisposables.values()) {
			dispose(disposables);
		}
		this._repositoryDisposables.clear();

		this._disposables = dispose(this._disposables);
	}
}

class GitBlameEditorDecoration implements HoverProvider {
	private _template = '';
	private _decoration: TextEditorDecorationType;

	private _hoverDisposable: IDisposable | undefined;
	private _disposables: IDisposable[] = [];

	constructor(private readonly _controller: GitBlameController) {
		this._decoration = window.createTextEditorDecorationType({
			after: {
				color: new ThemeColor('git.blame.editorDecorationForeground')
			}
		});
		this._disposables.push(this._decoration);

		workspace.onDidChangeConfiguration(this._onDidChangeConfiguration, this, this._disposables);
		window.onDidChangeActiveTextEditor(this._onDidChangeActiveTextEditor, this, this._disposables);
		this._controller.onDidChangeBlameInformation(() => this._onDidChangeBlameInformation(), this, this._disposables);

		this._onDidChangeConfiguration();
	}

	async provideHover(document: TextDocument, position: Position, token: CancellationToken): Promise<Hover | undefined> {
		if (token.isCancellationRequested) {
			return undefined;
		}

		const textEditor = window.activeTextEditor;
		if (!textEditor) {
			return undefined;
		}

		// Position must be at the end of the line
		if (position.character !== document.lineAt(position.line).range.end.character) {
			return undefined;
		}

		// Get blame information
		const blameInformation = this._controller.textEditorBlameInformation?.blameInformation;
		const lineBlameInformation = blameInformation?.find(blame => blame.lineNumber === position.line);

		if (!lineBlameInformation || typeof lineBlameInformation.blameInformation === 'string') {
			return undefined;
		}

		const contents = await this._controller.getBlameInformationHover(textEditor.document.uri, lineBlameInformation.blameInformation);

		if (!contents || token.isCancellationRequested) {
			return undefined;
		}

		return { range: getEditorDecorationRange(position.line), contents: [contents] };
	}

	private _onDidChangeConfiguration(e?: ConfigurationChangeEvent): void {
		if (e &&
			!e.affectsConfiguration('git.commitShortHashLength') &&
			!e.affectsConfiguration('git.blame.editorDecoration.template') &&
			!e.affectsConfiguration('git.blame.editorDecoration.disableHover')) {
			return;
		}

		// Cache the decoration template
		const config = workspace.getConfiguration('git');
		this._template = config.get<string>('blame.editorDecoration.template', '${subject}, ${authorName} (${authorDateAgo})');

		this._registerHoverProvider();
		this._onDidChangeBlameInformation();
	}

	private _onDidChangeActiveTextEditor(): void {
		// Clear decorations
		for (const editor of window.visibleTextEditors) {
			if (editor !== window.activeTextEditor) {
				editor.setDecorations(this._decoration, []);
			}
		}

		// Register hover provider
		this._registerHoverProvider();
	}

	private _onDidChangeBlameInformation(): void {
		const textEditor = window.activeTextEditor;
		if (!textEditor) {
			return;
		}

		// Get blame information
		const blameInformation = this._controller.textEditorBlameInformation?.blameInformation;
		if (!blameInformation || blameInformation.length === 0) {
			textEditor.setDecorations(this._decoration, []);
			return;
		}

		// Set decorations for the editor
		const decorations = blameInformation.map(blame => {
			const contentText = typeof blame.blameInformation !== 'string'
				? this._controller.formatBlameInformationMessage(textEditor.document.uri, this._template, blame.blameInformation)
				: blame.blameInformation;

			return this._createDecoration(blame.lineNumber, contentText);
		});

		textEditor.setDecorations(this._decoration, decorations);
	}

	private _createDecoration(lineNumber: number, contentText: string): DecorationOptions {
		return {
			range: getEditorDecorationRange(lineNumber),
			renderOptions: {
				after: {
					contentText,
					margin: '0 0 0 50px'
				}
			},
		};
	}

	private _registerHoverProvider(): void {
		this._hoverDisposable?.dispose();

		const config = workspace.getConfiguration('git');
		const disableHover = config.get<boolean>('blame.editorDecoration.disableHover', false);
		if (!disableHover && window.activeTextEditor && isResourceSchemeSupported(window.activeTextEditor.document.uri)) {
			this._hoverDisposable = languages.registerHoverProvider({
				pattern: window.activeTextEditor.document.uri.fsPath
			}, this);
		}
	}

	dispose() {
		this._hoverDisposable?.dispose();
		this._hoverDisposable = undefined;

		this._disposables = dispose(this._disposables);
	}
}

class GitBlameAnnotation implements HoverProvider {
	private readonly _columnWidth = 34;
	private readonly _decoration: TextEditorDecorationType;
	private readonly _lineDecoration: TextEditorDecorationType;
	private _lineHighlighted = false;
	private readonly _annotated = new Set<string>();
	private readonly _lines = new Map<string, (BlameInformation | string | undefined)[]>();
	private _version = 0;
	private _disposables: IDisposable[] = [];

	constructor(private readonly _controller: GitBlameController) {
		this._decoration = window.createTextEditorDecorationType({});
		this._lineDecoration = window.createTextEditorDecorationType({
			isWholeLine: true,
			backgroundColor: new ThemeColor('editor.lineHighlightBackground'),
			border: '1px solid',
			borderColor: new ThemeColor('editor.lineHighlightBorder')
		});
		this._disposables.push(this._decoration, this._lineDecoration);

		this._disposables.push(
			commands.registerCommand('git.blame.annotate', (arg?: { uri?: Uri }) => this._toggle(arg?.uri)),
			commands.registerCommand('git.blame.closeAnnotations', (arg?: { uri?: Uri }) => this._toggle(arg?.uri)),
			commands.registerCommand('git.blame.toggleAnnotations', (arg?: { uri?: Uri }) => this._toggle(arg?.uri)),
			languages.registerHoverProvider([{ scheme: 'file' }, { scheme: 'git' }], this),
			window.onDidChangeActiveTextEditor(() => this._updateContext()),
			window.onDidChangeVisibleTextEditors(() => { this._updateContext(); this._refresh(); }),
			workspace.onDidChangeConfiguration(e => e.affectsConfiguration('git.blame.annotation.dateFormat') && this._refresh()),
			window.onDidChangeTextEditorVisibleRanges(() => this._clearLineHighlight()),
			window.onDidChangeTextEditorSelection(() => this._clearLineHighlight()),
			window.onDidChangeTextEditorDiffInformation(() => this._refresh()),
			workspace.onDidCloseTextDocument(d => this._close(d.uri.toString()))
		);
	}

	private _toggle(uri?: Uri): void {
		const key = (uri ?? window.activeTextEditor?.document.uri)?.toString();
		if (!key) {
			return;
		}

		if (this._annotated.has(key)) {
			this._close(key);
		} else {
			this._annotated.add(key);
		}

		this._updateContext(key);
		this._refresh();
	}

	private _close(key: string): void {
		this._annotated.delete(key);
		this._lines.delete(key);
		for (const editor of window.visibleTextEditors) {
			if (editor.document.uri.toString() === key) {
				editor.setDecorations(this._decoration, []);
			}
		}
		this._updateContext();
	}

	private _updateContext(_key?: string): void {
		const keys = [...this._annotated];
		commands.executeCommand('setContext', 'git.blame.annotated.file', keys.some(k => k.startsWith('file:')));
		commands.executeCommand('setContext', 'git.blame.annotated.git', keys.some(k => k.startsWith('git:')));
	}

	private async _refresh(): Promise<void> {
		const version = ++this._version;

		for (const editor of window.visibleTextEditors) {
			const key = editor.document.uri.toString();
			if (!this._annotated.has(key)) {
				continue;
			}

			const lines = await this._controller.getFileBlameInformation(editor);
			if (version !== this._version || !this._annotated.has(key)) {
				return;
			}

			if (!lines) {
				editor.setDecorations(this._decoration, []);
				continue;
			}

			this._lines.set(key, lines);
			this._render(editor);
		}
	}

	private _render(editor: TextEditor): void {
		const key = editor.document.uri.toString();
		const lines = this._lines.get(key);
		if (!lines || !this._annotated.has(key)) {
			return;
		}

		const levels = 6;
		const times = lines.map(l => l !== undefined && typeof l !== 'string' ? new Date(l.authorDate ?? 0).getTime() : undefined);
		const distinct = [...new Set(times.filter((t): t is number => t !== undefined))].sort((a, b) => a - b);
		const levelOf = (t: number) => distinct.length < 2 ? levels - 1 : Math.round(distinct.indexOf(t) / (distinct.length - 1) * (levels - 1));

		editor.setDecorations(this._decoration, lines.map((info, line) => {
			const t = times[line];
			return this._createDecoration(line, info, t === undefined ? undefined : levelOf(t), levels);
		}));
	}

	private _formatDate(date: Date): string {
		const format = workspace.getConfiguration('git').get<string>('blame.annotation.dateFormat', 'system');
		if (format === 'system') {
			return date.toLocaleDateString();
		}

		const dd = String(date.getDate()).padStart(2, '0');
		const MM = String(date.getMonth() + 1).padStart(2, '0');
		const yyyy = String(date.getFullYear());

		return format.replace('dd', dd).replace('MM', MM).replace('yyyy', yyyy);
	}

	private _getLineHeight(): number {
		const config = workspace.getConfiguration('editor');
		const fontSize = config.get<number>('fontSize', 12);
		const lineHeight = config.get<number>('lineHeight', 0);

		if (lineHeight === 0) {
			return Math.round(1.5 * fontSize);
		}

		return lineHeight < 8 ? Math.round(lineHeight * fontSize) : lineHeight;
	}

	private _createDecoration(line: number, info: BlameInformation | string | undefined, level: number | undefined, levels: number): DecorationOptions {
		let text = '';
		let backgroundColor: string | undefined;
		if (info !== undefined && typeof info !== 'string') {
			const alpha = 0.05 + 0.45 * ((level ?? 0) / (levels - 1));
			backgroundColor = `rgba(70, 140, 255, ${alpha.toFixed(3)})`;
			const date = this._formatDate(new Date(info.authorDate ?? new Date()));
			text = `${date} ${truncate(info.authorName ?? '', 18)}`;
		}

		const contentText = text.padEnd(this._columnWidth, ' ').replace(/ /g, '\u00a0');

		return {
			range: new Range(line, 0, line, 0),
			renderOptions: {
				before: {
					contentText,
					color: new ThemeColor('editor.foreground'),
					backgroundColor,
					margin: '0 16px 0 0',
					textDecoration: `none; display: inline-block; vertical-align: top; height: ${this._getLineHeight()}px; line-height: ${this._getLineHeight()}px; padding-left: 6px; border-right: 1px solid rgba(128, 128, 128, 0.25)`
				}
			}
		};
	}

	private _clearLineHighlight(): void {
		this._lineHighlighted = false;
		for (const editor of window.visibleTextEditors) {
			editor.setDecorations(this._lineDecoration, []);
		}
	}

	private _highlightLine(document: TextDocument, line: number): void {
		this._clearLineHighlight();
		for (const editor of window.visibleTextEditors) {
			if (editor.document === document) {
				editor.setDecorations(this._lineDecoration, [new Range(line, 0, line, 0)]);
			}
		}
		this._lineHighlighted = true;
	}

	async provideHover(document: TextDocument, position: Position, token: CancellationToken): Promise<Hover | undefined> {
		const info = this._lines.get(document.uri.toString())?.[position.line];
		if (position.character !== 0 || !info || typeof info === 'string') {
			if (this._lineHighlighted) {
				this._clearLineHighlight();
			}
			return undefined;
		}

		this._highlightLine(document, position.line);

		const contents = await this._controller.getBlameInformationHover(document.uri, info);
		if (!contents || token.isCancellationRequested) {
			return undefined;
		}

		return { contents: [contents] };
	}

	dispose() {
		this._disposables = dispose(this._disposables);
	}
}

class GitBlameStatusBarItem {
	private _template = '';
	private _statusBarItem: StatusBarItem;
	private _disposables: IDisposable[] = [];

	constructor(private readonly _controller: GitBlameController) {
		this._statusBarItem = window.createStatusBarItem('git.blame', StatusBarAlignment.Right, 200);
		this._statusBarItem.name = l10n.t('Git Blame Information');
		this._disposables.push(this._statusBarItem);

		workspace.onDidChangeConfiguration(this._onDidChangeConfiguration, this, this._disposables);
		this._controller.onDidChangeBlameInformation(() => this._onDidChangeBlameInformation(), this, this._disposables);

		this._onDidChangeConfiguration();
	}

	private _onDidChangeConfiguration(e?: ConfigurationChangeEvent): void {
		if (e &&
			!e.affectsConfiguration('git.commitShortHashLength') &&
			!e.affectsConfiguration('git.blame.statusBarItem.template')) {
			return;
		}

		// Cache the decoration template
		const config = workspace.getConfiguration('git');
		this._template = config.get<string>('blame.statusBarItem.template', '${authorName} (${authorDateAgo})');

		this._onDidChangeBlameInformation();
	}

	private async _onDidChangeBlameInformation(): Promise<void> {
		if (!window.activeTextEditor) {
			this._statusBarItem.hide();
			return;
		}

		const blameInformation = this._controller.textEditorBlameInformation?.blameInformation;
		if (!blameInformation || blameInformation.length === 0) {
			this._statusBarItem.hide();
			return;
		}

		if (typeof blameInformation[0].blameInformation === 'string') {
			this._statusBarItem.text = `$(git-commit) ${blameInformation[0].blameInformation}`;
			this._statusBarItem.tooltip = l10n.t('Git Blame Information');
			this._statusBarItem.command = undefined;
		} else {
			this._statusBarItem.text = `$(git-commit) ${this._controller.formatBlameInformationMessage(
				window.activeTextEditor.document.uri, this._template, blameInformation[0].blameInformation)}`;

			this._statusBarItem.tooltip2 = (cancellationToken: CancellationToken) => {
				return this._provideTooltip(window.activeTextEditor!.document.uri,
					blameInformation[0].blameInformation as BlameInformation, cancellationToken);
			};

			const uri = window.activeTextEditor.document.uri;
			const hash = blameInformation[0].blameInformation.hash;

			this._statusBarItem.command = {
				title: l10n.t('Open Commit'),
				command: 'git.viewCommit',
				arguments: [uri, hash, uri]
			} satisfies Command;
		}

		this._statusBarItem.show();
	}

	private async _provideTooltip(uri: Uri, blameInformation: BlameInformation, cancellationToken: CancellationToken): Promise<MarkdownString | undefined> {
		if (cancellationToken.isCancellationRequested) {
			return undefined;
		}

		const tooltip = await this._controller.getBlameInformationHover(uri, blameInformation);
		return cancellationToken.isCancellationRequested ? undefined : tooltip;
	}

	dispose() {
		this._disposables = dispose(this._disposables);
	}
}
