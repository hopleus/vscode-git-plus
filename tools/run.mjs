import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import { build, config, extensionDir, extensionId, root } from './paths.mjs';

const folder = resolve(process.argv[2] ?? join(root, '..', 'godwit-sandbox'));
if (!existsSync(folder)) {
	throw new Error(`folder does not exist: ${folder}`);
}
const profile = join(build, 'profile');
mkdirSync(profile, { recursive: true });
const exe = await downloadAndUnzipVSCode({ version: config.vscode, cachePath: join(root, '.vscode-test') });
spawn(exe, [
	`--extensionDevelopmentPath=${extensionDir}`,
	`--enable-proposed-api=${extensionId}`,
	'--disable-extension=vscode.git',
	'--user-data-dir', join(profile, 'user-data'),
	'--extensions-dir', join(profile, 'extensions'),
	'--disable-workspace-trust',
	folder,
], { detached: true, stdio: 'ignore' }).unref();
console.log(`launched ${extensionId} on ${folder}`);
