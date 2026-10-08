/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'crypto';
import { l10n, Uri, ViewColumn, Webview, window } from 'vscode';

const SUBJECT_SOFT_LIMIT = 72;

interface Reply {
	type: 'apply' | 'cancel';
	text?: string;
}

export function editMessage(initial: string, title: string): Promise<string | undefined> {
	return new Promise(resolve => {
		const webviewRoot = Uri.joinPath(Uri.file(__dirname), 'webview');
		const panel = window.createWebviewPanel('git.editCommitMessage', title, ViewColumn.Active, { enableScripts: true, localResourceRoots: [webviewRoot] });
		let settled = false;
		const finish = (value: string | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			resolve(value);
			panel.dispose();
		};
		panel.webview.html = render(initial, title, panel.webview, Uri.joinPath(webviewRoot, 'messageEditor.js'));
		panel.webview.onDidReceiveMessage((reply: Reply) => finish(reply.type === 'apply' ? reply.text?.trim() : undefined));
		panel.onDidDispose(() => finish(undefined));
	});
}

function escapeHtml(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function render(initial: string, title: string, webview: Webview, elementsUri: Uri): string {
	const nonce = randomBytes(16).toString('base64');
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; font-src ${webview.cspSource}; script-src ${webview.cspSource} 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
  body { padding: 16px 24px; max-width: 880px; }
  h2 { font-weight: 600; margin: 0 0 12px; }
  vscode-textarea { width: 100%; }
  .bar { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
  .hint { flex: 1; color: var(--vscode-descriptionForeground); }
  .hint.warn { color: var(--vscode-editorWarning-foreground); }
</style>
</head>
<body>
  <h2>${escapeHtml(title)}</h2>
  <vscode-textarea id="text" rows="14" resize="vertical" monospace spellcheck autofocus value="${escapeHtml(initial).replace(/"/g, '&quot;')}"></vscode-textarea>
  <div class="bar">
    <span id="hint" class="hint"></span>
    <vscode-button id="cancel" secondary>${escapeHtml(l10n.t('Cancel'))}</vscode-button>
    <vscode-button id="apply">${escapeHtml(l10n.t('Apply'))}</vscode-button>
  </div>
  <script src="${webview.asWebviewUri(elementsUri)}"></script>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const text = document.getElementById('text');
    const hint = document.getElementById('hint');
    const apply = document.getElementById('apply');
    const LIMIT = ${SUBJECT_SOFT_LIMIT};
    const refresh = () => {
      const subject = text.value.split('\\n')[0].length;
      const empty = text.value.trim().length === 0;
      apply.disabled = empty;
      hint.textContent = (empty ? ${JSON.stringify(l10n.t('The message must not be empty'))} : ${JSON.stringify(l10n.t('Subject: {0} characters', '@@'))}.replace('@@', subject)) + '   ·   ' + ${JSON.stringify(l10n.t('Cmd/Ctrl+Enter to apply'))};
      hint.classList.toggle('warn', !empty && subject > LIMIT);
    };
    const submit = () => { if (!apply.disabled) vscode.postMessage({ type: 'apply', text: text.value }); };
    text.addEventListener('input', refresh);
    text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } });
    apply.addEventListener('click', submit);
    document.getElementById('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
    refresh();
    customElements.whenDefined('vscode-textarea').then(() => requestAnimationFrame(() => { text.focus(); text.wrappedElement.setSelectionRange(0, 0); }));
  </script>
</body>
</html>`;
}
