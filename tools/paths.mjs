import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const root = resolve(import.meta.dirname, '..');
export const tools = import.meta.dirname;
export const config = JSON.parse(readFileSync(join(tools, 'config.json'), 'utf8'));
export const build = join(root, '.build');
export const extensionDir = join(build, 'extension');
export const testDir = join(build, 'test');
export const extensionId = `${config.publisher}.${config.name}`;
export const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
