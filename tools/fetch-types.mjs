import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, manifest, root } from './paths.mjs';

const target = join(root, '.vscode-dts');
const base = `https://raw.githubusercontent.com/microsoft/vscode/${config.vscode}/src/vscode-dts`;
const names = ['vscode.d.ts', ...(manifest.enabledApiProposals ?? []).map((p) => `vscode.proposed.${p}.d.ts`)];

mkdirSync(target, { recursive: true });
for (const name of names) {
	const response = await fetch(`${base}/${name}`);
	if (!response.ok) {
		throw new Error(`cannot download ${name}: ${response.status}`);
	}
	writeFileSync(join(target, name), await response.text());
}
console.log(`downloaded ${names.length} type definition files for VS Code ${config.vscode}`);
