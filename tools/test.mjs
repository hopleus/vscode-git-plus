import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { build } from 'esbuild';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';
import { buildExtension, bundleOptions } from './build.mjs';
import { config, extensionDir, extensionId, root, testDir, tools } from './paths.mjs';

await buildExtension();

rmSync(testDir, { recursive: true, force: true });
const testFiles = [
	...readdirSync(join(root, 'src', 'test')).filter((f) => f.endsWith('.test.ts')).map((f) => join(root, 'src', 'test', f)),
	...readdirSync(join(tools, 'updater')).filter((f) => f.endsWith('.test.ts')).map((f) => join(tools, 'updater', f)),
];
await build({
	...bundleOptions,
	entryPoints: Object.fromEntries(testFiles.map((f) => [basename(f).replace(/\.ts$/, ''), f])),
	outdir: testDir,
});

const profile = realpathSync(mkdtempSync(join(tmpdir(), 'gp-test-')));
const workspace = join(profile, 'workspace');
mkdirSync(workspace);
const exe = await downloadAndUnzipVSCode({ version: config.vscode, cachePath: join(root, '.vscode-test') });
await runTests({
	vscodeExecutablePath: exe,
	extensionDevelopmentPath: extensionDir,
	extensionTestsPath: join(tools, 'test-runner.cjs'),
	extensionTestsEnv: { GIT_PLUS_TEST_DIR: testDir, GIT_PLUS_EXTENSION_ID: extensionId },
	launchArgs: [`--enable-proposed-api=${extensionId}`, '--disable-extension=vscode.git', '--user-data-dir', join(profile, 'user-data'), '--disable-workspace-trust', workspace],
});
