import type { ExtensionContext } from 'vscode';
import * as git from '../../src/main';
import { startUpdateChecker } from './updateChecker';

declare const __GIT_PLUS_REPOSITORY__: string;

export const deactivate = git.deactivate;

export async function activate(context: ExtensionContext) {
	const api = await git.activate(context);
	startUpdateChecker(context, __GIT_PLUS_REPOSITORY__);
	return api;
}
