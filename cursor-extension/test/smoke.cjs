// Run inside a real Cursor Extension Development Host, not Bun.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

async function activeAt(line, suffix) {
  for (let i = 0; i < 250; i++) {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.selection.start.line === line && (!suffix || editor.document.uri.path.endsWith(suffix))) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`Expected active editor at ${suffix || 'stop'}:${line + 1}; got ${vscode.window.activeTextEditor?.document.uri} at ${vscode.window.activeTextEditor?.selection.start.line}`);
}

exports.run = async function () {
  const repo = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const file = path.join(repo, 'smoke-tour.json');
  const extension = vscode.extensions.getExtension('guided-review.guided-review-cursor');
  assert.ok(extension, 'development extension is registered');
  await extension.activate();
  await vscode.commands.executeCommand('guidedReview.open', vscode.Uri.file(file));
  await activeAt(2, 'retry.ts');
  let document = vscode.window.activeTextEditor.document;
  assert.equal(document.uri.scheme, 'guided-review');
  assert.ok(document.getText().includes('maxAttempts'));
  assert.equal(vscode.window.activeTextEditor.selection.start.line, 2);
  const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', document.uri);
  assert.ok(lenses.length >= 2, 'native code lenses were registered');
  const first = lenses.find(lens => lens.command.command === 'guidedReview.goto');
  const id = first.command.arguments[0];
  await vscode.commands.executeCommand('guidedReview.next');
  await activeAt(30, 'retry.ts');
  assert.equal(vscode.window.activeTextEditor.selection.start.line, 30);
  await vscode.commands.executeCommand('guidedReview.follow', id, 5);
  await activeAt(23, 'rate-limiter.ts');
  assert.equal(vscode.window.activeTextEditor.selection.start.line, 23);
  assert.ok(vscode.window.activeTextEditor.document.uri.path.endsWith('rate-limiter.ts'));
  await vscode.commands.executeCommand('guidedReview.back');
  await activeAt(30, 'retry.ts');
  assert.equal(vscode.window.activeTextEditor.selection.start.line, 30);
  await vscode.commands.executeCommand('guidedReview.toggleReviewed');
  document = vscode.window.activeTextEditor.document;
  const reviewed = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', document.uri);
  assert.ok(reviewed.some(lens => lens.command.title === '✓ Reviewed'));
  await vscode.commands.executeCommand('guidedReview.close');
  const cleared = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', document.uri);
  assert.equal(cleared.length, 0, 'closing removes tour lenses');
  await vscode.commands.executeCommand('guidedReview.open', vscode.Uri.file(file));
  await vscode.commands.executeCommand('guidedReview.next');
  await activeAt(30, 'retry.ts');
  const reopened = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', vscode.window.activeTextEditor.document.uri);
  assert.ok(reopened.some(lens => lens.command.title === '✓ Reviewed'), 'progress survives reopen');
  await vscode.commands.executeCommand('guidedReview.showDiff');
  assert.ok(vscode.window.visibleTextEditors.some(editor => editor.document.uri.scheme === 'guided-review'));
  await vscode.commands.executeCommand('guidedReview.close');
  fs.writeFileSync(path.join(repo, 'smoke-result.json'), JSON.stringify({ ok: true, checks: ['activate', 'open', 'selection', 'codeLens', 'next', 'follow', 'back', 'reviewed', 'close', 'persisted-progress', 'native-diff'] }));
};

const run = exports.run;
exports.run = async function () {
  try { await run(); } catch (error) {
    const repo = vscode.workspace.workspaceFolders[0].uri.fsPath;
    fs.writeFileSync(path.join(repo, 'smoke-result.json'), JSON.stringify({ ok: false, error: error.stack || String(error) }));
    throw error;
  }
};
