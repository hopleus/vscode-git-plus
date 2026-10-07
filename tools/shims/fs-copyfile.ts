import { cp as nodeCp, type CopyOptions } from 'node:fs';
import { promisify } from 'node:util';

const cpAsync = promisify(nodeCp);

export function cp(src: string, dest: string, options?: CopyOptions): Promise<void> {
	return cpAsync(src, dest, options);
}
