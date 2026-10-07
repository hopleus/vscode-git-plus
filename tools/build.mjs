import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { build } from 'esbuild';
import { config, extensionDir, extensionId, manifest, root, tools } from './paths.mjs';

const srcDir = join(root, 'src');
const distDir = join(extensionDir, 'dist');

export const bundleOptions = {
	bundle: true,
	platform: 'node',
	format: 'cjs',
	target: 'es2024',
	sourcemap: true,
	mainFields: ['module', 'main'],
	external: ['vscode'],
	nodePaths: [join(tools, 'node_modules')],
	alias: {
		'@vscode/extension-telemetry': join(tools, 'shims', 'extension-telemetry.ts'),
		'@vscode/fs-copyfile': join(tools, 'shims', 'fs-copyfile.ts'),
		mocha: join(tools, 'shims', 'empty.ts'),
	},
	tsconfigRaw: JSON.stringify({ compilerOptions: { experimentalDecorators: true, target: 'ES2024', useDefineForClassFields: false } }),
	logOverride: { 'import-is-undefined': 'error' },
};

function copyNonTypeScript(dir) {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) {
			if (name !== 'test') {
				copyNonTypeScript(full);
			}
		} else if (!name.endsWith('.ts')) {
			const target = join(distDir, relative(srcDir, full));
			mkdirSync(join(target, '..'), { recursive: true });
			cpSync(full, target);
		}
	}
}

const withUpdater = process.argv.includes('--updater');
const version = process.env.GIT_PLUS_VERSION ?? '0.0.0-dev';
const repository = process.env.GIT_PLUS_REPOSITORY ?? '';

const updateSetting = {
	type: 'boolean',
	default: true,
	description: 'Check GitHub releases once a day and notify when a newer version of Git Plus is available. The only network request made apart from your own git operations.'
};

function writeManifest() {
	const derived = structuredClone(manifest);
	delete derived.aiKey;
	delete derived.scripts;
	delete derived.dependencies;
	delete derived.devDependencies;
	Object.assign(derived, {
		name: config.name,
		displayName: config.displayName,
		description: config.description,
		publisher: config.publisher,
		version,
		main: './dist/main.js',
		engines: { vscode: `^${config.vscode}` },
	});
	if (repository) {
		derived.repository = { type: 'git', url: `https://github.com/${repository}.git` };
	}
	if (withUpdater) {
		const configuration = Array.isArray(derived.contributes.configuration) ? derived.contributes.configuration[0] : derived.contributes.configuration;
		configuration.properties['gitPlus.checkForUpdates'] = updateSetting;
	}
	writeFileSync(join(extensionDir, 'package.json'), JSON.stringify(derived, null, 2));
	writeFileSync(join(extensionDir, '.vscodeignore'), '**/*.map\n');
}

export async function buildExtension() {
	rmSync(extensionDir, { recursive: true, force: true });
	mkdirSync(extensionDir, { recursive: true });
	await build({
		...bundleOptions,
		define: { __GIT_PLUS_REPOSITORY__: JSON.stringify(repository) },
		entryPoints: {
			main: withUpdater ? join(tools, 'updater', 'entry.ts') : join(srcDir, 'main.ts'),
			'askpass-main': join(srcDir, 'askpass-main.ts'),
			'git-editor-main': join(srcDir, 'git-editor-main.ts'),
		},
		outdir: distDir,
	});
	copyNonTypeScript(srcDir);
	cpSync(join(root, 'resources'), join(extensionDir, 'resources'), { recursive: true });
	cpSync(join(root, 'package.nls.json'), join(extensionDir, 'package.nls.json'));
	writeManifest();
}

if (import.meta.url === `file://${process.argv[1]}`) {
	await buildExtension();
	console.log(`built ${extensionDir} (${extensionId})`);
	if (process.argv.includes('--package')) {
		const vsix = join(root, '.build', `${config.name}-${version}.vsix`);
		if (existsSync(vsix)) {
			rmSync(vsix);
		}
		execFileSync(join(tools, 'node_modules', '.bin', 'vsce'), ['package', '--no-dependencies', '--allow-missing-repository', '--skip-license', '--allow-star-activation', '-o', vsix], { cwd: extensionDir, stdio: 'inherit' });
		console.log(`packaged ${vsix}`);
	}
}
