import 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { window, workspace } from 'vscode';
import { isNewerVersion, parseLatestRelease, parseVersion, ReleaseInfo, UpdateChecker } from './updateChecker';

suite('update checker', () => {
	teardown(() => sinon.restore());

	suite('versions', () => {
		test('parses plain and v-prefixed releases only', () => {
			assert.deepStrictEqual(parseVersion('1.2.3'), [1, 2, 3]);
			assert.deepStrictEqual(parseVersion('v10.0.1'), [10, 0, 1]);
			assert.strictEqual(parseVersion('v1.2.3-beta.1'), undefined);
			assert.strictEqual(parseVersion('nightly'), undefined);
		});

		test('compares numerically, not lexically', () => {
			assert.ok(isNewerVersion('1.10.0', '1.9.9'));
			assert.ok(isNewerVersion('v2.0.0', '1.99.99'));
			assert.ok(isNewerVersion('1.0.1', '1.0.0'));
			assert.ok(!isNewerVersion('1.0.0', '1.0.0'));
			assert.ok(!isNewerVersion('1.0.0', '1.0.1'));
		});

		test('never reports an update for unparsable versions', () => {
			assert.ok(!isNewerVersion('abc', '1.0.0'));
			assert.ok(!isNewerVersion('2.0.0', '0.0.0-dev'));
		});
	});

	suite('release payload', () => {
		const payload = { tag_name: 'v1.4.0', html_url: 'https://github.com/o/r/releases/tag/v1.4.0', draft: false, prerelease: false };

		test('accepts a published stable release', () => {
			assert.deepStrictEqual(parseLatestRelease(payload), { version: '1.4.0', url: payload.html_url });
		});

		test('rejects drafts, prereleases, foreign links and malformed payloads', () => {
			assert.strictEqual(parseLatestRelease({ ...payload, draft: true }), undefined);
			assert.strictEqual(parseLatestRelease({ ...payload, prerelease: true }), undefined);
			assert.strictEqual(parseLatestRelease({ ...payload, html_url: 'https://evil.example/x' }), undefined);
			assert.strictEqual(parseLatestRelease({ ...payload, tag_name: 'v1.4.0-rc1' }), undefined);
			assert.strictEqual(parseLatestRelease(null), undefined);
			assert.strictEqual(parseLatestRelease('x'), undefined);
		});
	});

	suite('checker', () => {
		const DAY = 24 * 60 * 60 * 1000;
		const release: ReleaseInfo = { version: '2.0.0', url: 'https://github.com/o/r/releases/tag/v2.0.0' };

		function createContext() {
			const store = new Map<string, unknown>();
			return {
				store,
				context: {
					globalState: {
						get: (key: string, fallback?: unknown) => store.has(key) ? store.get(key) : fallback,
						update: async (key: string, value: unknown) => { store.set(key, value); }
					}
				} as never
			};
		}

		function enable(value: boolean) {
			sinon.stub(workspace, 'getConfiguration').returns({ get: (_key: string, fallback: unknown) => value ?? fallback } as never);
		}

		test('announces a newer release and records the check time', async () => {
			const { context, store } = createContext();
			enable(true);
			const info = sinon.stub(window, 'showInformationMessage').resolves(undefined);
			const fetcher = sinon.stub().resolves(release);

			const result = await new UpdateChecker(context, 'o/r', '1.0.0', fetcher, () => 5 * DAY).check();

			assert.deepStrictEqual(result, release);
			assert.ok(fetcher.calledOnceWith('o/r'));
			assert.ok(info.calledOnce);
			assert.strictEqual(store.get('gitPlus.updates.lastCheck'), 5 * DAY);
		});

		test('stays silent when already up to date or when the lookup fails', async () => {
			const { context } = createContext();
			enable(true);
			const info = sinon.stub(window, 'showInformationMessage').resolves(undefined);

			assert.strictEqual(await new UpdateChecker(context, 'o/r', '2.0.0', async () => release, () => 5 * DAY).check(), undefined);
			assert.strictEqual(await new UpdateChecker(context, 'o/r', '1.0.0', async () => { throw new Error('offline'); }, () => 9 * DAY).check(), undefined);
			assert.ok(info.notCalled);
		});

		test('checks at most once a day', async () => {
			const { context } = createContext();
			enable(true);
			sinon.stub(window, 'showInformationMessage').resolves(undefined);
			const fetcher = sinon.stub().resolves(undefined);
			let now = 5 * DAY;
			const checker = new UpdateChecker(context, 'o/r', '1.0.0', fetcher, () => now);

			await checker.check();
			now += DAY - 1;
			await checker.check();
			now += 1;
			await checker.check();

			assert.strictEqual(fetcher.callCount, 2);
		});

		test('does nothing when disabled', async () => {
			const { context } = createContext();
			enable(false);
			const fetcher = sinon.stub().resolves(release);

			assert.strictEqual(await new UpdateChecker(context, 'o/r', '1.0.0', fetcher, () => 5 * DAY).check(), undefined);
			assert.ok(fetcher.notCalled);
		});

		test('does not repeat a skipped version', async () => {
			const { context, store } = createContext();
			enable(true);
			sinon.stub(window, 'showInformationMessage').resolves('Skip This Version' as never);

			await new UpdateChecker(context, 'o/r', '1.0.0', async () => release, () => 5 * DAY).check();
			assert.strictEqual(store.get('gitPlus.updates.skippedVersion'), '2.0.0');

			sinon.restore();
			enable(true);
			const info = sinon.stub(window, 'showInformationMessage').resolves(undefined);
			assert.strictEqual(await new UpdateChecker(context, 'o/r', '1.0.0', async () => release, () => 9 * DAY).check(), undefined);
			assert.ok(info.notCalled);
		});
	});
});
