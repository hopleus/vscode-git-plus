/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import type { LogOutputChannel } from 'vscode';
import { Operation, OperationKind, OperationManager } from '../operation';

suite('operation manager', () => {
	const logger = { trace() { }, info() { }, debug() { }, warn() { }, error() { } } as unknown as LogOutputChannel;

	test('a running fetch makes the repository busy unless fetch is ignored', () => {
		const manager = new OperationManager(logger);
		const fetch = Operation.Fetch(false);

		manager.start(fetch);

		assert.strictEqual(manager.isIdle(), false);
		assert.strictEqual(manager.isIdle([OperationKind.Fetch]), true);

		manager.end(fetch);
		assert.strictEqual(manager.isIdle(), true);
	});

	test('ignoring fetch does not hide other running operations', () => {
		const manager = new OperationManager(logger);
		const fetch = Operation.Fetch(false);
		const commit = Operation.Commit;

		manager.start(fetch);
		manager.start(commit);

		assert.strictEqual(manager.isIdle([OperationKind.Fetch]), false);
	});
});
