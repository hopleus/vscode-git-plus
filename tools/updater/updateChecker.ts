import * as https from 'https';
import { commands, ExtensionContext, l10n, Uri, window, workspace } from 'vscode';

const CHECK_SETTING_SECTION = 'gitPlus';
const CHECK_SETTING_KEY = 'checkForUpdates';
const LAST_CHECK_KEY = 'gitPlus.updates.lastCheck';
const SKIPPED_VERSION_KEY = 'gitPlus.updates.skippedVersion';
const FIRST_CHECK_DELAY_MS = 15_000;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
const HTTP_OK = 200;
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/;

export interface ReleaseInfo {
	readonly version: string;
	readonly url: string;
}

export type ReleaseFetcher = (repository: string) => Promise<ReleaseInfo | undefined>;

export function parseVersion(tag: string): number[] | undefined {
	const match = SEMVER.exec(tag.trim());
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

export function isNewerVersion(candidate: string, current: string): boolean {
	const next = parseVersion(candidate);
	const installed = parseVersion(current);

	if (!next || !installed) {
		return false;
	}

	for (let index = 0; index < next.length; index++) {
		if (next[index] !== installed[index]) {
			return next[index] > installed[index];
		}
	}

	return false;
}

export function parseLatestRelease(payload: unknown): ReleaseInfo | undefined {
	if (typeof payload !== 'object' || payload === null) {
		return undefined;
	}

	const { tag_name, html_url, draft, prerelease } = payload as Record<string, unknown>;

	if (draft === true || prerelease === true || typeof tag_name !== 'string' || typeof html_url !== 'string') {
		return undefined;
	}

	if (!parseVersion(tag_name) || !html_url.startsWith('https://github.com/')) {
		return undefined;
	}

	return { version: tag_name.replace(/^v/, ''), url: html_url };
}

export const fetchLatestRelease: ReleaseFetcher = repository => new Promise((resolve, reject) => {
	const request = https.get({
		host: 'api.github.com',
		path: `/repos/${repository}/releases/latest`,
		headers: { 'User-Agent': 'git-plus-update-check', Accept: 'application/vnd.github+json' },
		timeout: REQUEST_TIMEOUT_MS
	}, response => {
		if (response.statusCode !== HTTP_OK) {
			response.resume();
			resolve(undefined);
			return;
		}

		const chunks: Buffer[] = [];
		response.on('data', chunk => chunks.push(chunk));
		response.on('end', () => {
			try {
				resolve(parseLatestRelease(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
			} catch (err) {
				reject(err);
			}
		});
		response.on('error', reject);
	});

	request.on('timeout', () => request.destroy(new Error('Update check timed out')));
	request.on('error', reject);
});

export class UpdateChecker {

	private timer: NodeJS.Timeout | undefined;

	constructor(
		private readonly context: ExtensionContext,
		private readonly repository: string,
		private readonly installedVersion: string,
		private readonly fetchRelease: ReleaseFetcher = fetchLatestRelease,
		private readonly now: () => number = Date.now
	) { }

	start(): void {
		this.schedule(FIRST_CHECK_DELAY_MS);
	}

	dispose(): void {
		clearTimeout(this.timer);
	}

	async check(): Promise<ReleaseInfo | undefined> {
		if (!this.isEnabled() || !this.isDue()) {
			return undefined;
		}

		await this.context.globalState.update(LAST_CHECK_KEY, this.now());

		const release = await this.fetchRelease(this.repository).catch(() => undefined);

		if (!release || !isNewerVersion(release.version, this.installedVersion) || release.version === this.context.globalState.get<string>(SKIPPED_VERSION_KEY)) {
			return undefined;
		}

		await this.announce(release);
		return release;
	}

	private isEnabled(): boolean {
		return workspace.getConfiguration(CHECK_SETTING_SECTION).get<boolean>(CHECK_SETTING_KEY, true);
	}

	private isDue(): boolean {
		const last = this.context.globalState.get<number>(LAST_CHECK_KEY, 0);
		return this.now() - last >= CHECK_INTERVAL_MS;
	}

	private schedule(delay: number): void {
		this.timer = setTimeout(async () => {
			await this.check();
			this.schedule(CHECK_INTERVAL_MS);
		}, delay);
	}

	private async announce(release: ReleaseInfo): Promise<void> {
		const open = l10n.t('Open Release');
		const skip = l10n.t('Skip This Version');
		const choice = await window.showInformationMessage(l10n.t('A new version of Git Plus is available: {0} (installed: {1}).', release.version, this.installedVersion), open, skip);

		if (choice === open) {
			await commands.executeCommand('vscode.open', Uri.parse(release.url));
		} else if (choice === skip) {
			await this.context.globalState.update(SKIPPED_VERSION_KEY, release.version);
		}
	}
}

export function startUpdateChecker(context: ExtensionContext, repository: string): void {
	const checker = new UpdateChecker(context, repository, context.extension.packageJSON.version);
	checker.start();
	context.subscriptions.push({ dispose: () => checker.dispose() });
}
