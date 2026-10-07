const fs = require('node:fs');
const path = require('node:path');
const Mocha = require('mocha');
const vscode = require('vscode');

const originalGetExtension = vscode.extensions.getExtension.bind(vscode.extensions);
vscode.extensions.getExtension = (id) => originalGetExtension(id === 'vscode.git' ? process.env.GIT_PLUS_EXTENSION_ID : id);

exports.run = function run() {
	const mocha = new Mocha({ ui: 'tdd', timeout: 60000, color: false });
	const dir = process.env.GIT_PLUS_TEST_DIR;
	for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.test.js'))) {
		mocha.addFile(path.join(dir, file));
	}
	return new Promise((resolve, reject) => {
		mocha.run((failures) => (failures ? reject(new Error(`${failures} test(s) failed`)) : resolve()));
	});
};
