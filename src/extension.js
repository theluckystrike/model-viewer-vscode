'use strict';
const vscode = require('vscode');
const path = require('path');
const { buildHtml } = require('./html');
const { validateWebviewMessage, sizePlan, fmtSize, formatOf } = require('./core/protocol');
const { createRatingPrompt } = require('./rate');
const { registerSupport, commandUris, showLinks } = require('./support');

const VIEW_TYPE = 'modelViewer.preview';
let rating = { success() {}, failure() {} };

function settings() {
  const c = vscode.workspace.getConfiguration('modelViewer');
  return {
    maxFileMB: c.get('maxFileMB', 1024),
    background: c.get('background', 'theme'),
    upAxis: c.get('upAxis', 'auto'),
  };
}

class ModelEditorProvider {
  constructor(context) { this.context = context; }

  openCustomDocument(uri) { return { uri, dispose() {} }; }

  async resolveCustomEditor(document, panel) {
    const ctx = this.context;
    const uri = document.uri;
    const dist = vscode.Uri.joinPath(ctx.extensionUri, 'dist');
    const media = vscode.Uri.joinPath(ctx.extensionUri, 'media');
    const folder = uri.with({ path: path.posix.dirname(uri.path) });
    // The model folder (and the workspace folders) are readable, so .bin, .mtl and textures next to the model load.
    const roots = [dist, media, folder, ...((vscode.workspace.workspaceFolders || []).map(f => f.uri))];
    // Command links are limited to the two support commands and the settings page (footer "Hide" link).
    panel.webview.options = { enableScripts: true, localResourceRoots: roots, enableCommandUris: commandUris('modelViewer') };
    const name = path.posix.basename(uri.path);
    panel.webview.html = buildHtml({
      cspSource: panel.webview.cspSource,
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'webview.css')).toString(),
      title: name,
      showSupportLinks: showLinks(vscode, 'modelViewer'),
    });
    let disposed = false;
    let counted = false; // one success per opened tab, for the rating prompt
    const post = m => (disposed ? Promise.resolve(false) : panel.webview.postMessage(m));

    panel.webview.onDidReceiveMessage(async raw => {
      const v = validateWebviewMessage(raw);
      if (!v.ok) return;
      const msg = v.msg;
      try {
        if (msg.type === 'ready') {
          const stat = await vscode.workspace.fs.stat(uri);
          const s = settings();
          const plan = sizePlan(stat.size, s.maxFileMB);
          await post({
            type: 'init', name, format: formatOf(name), size: stat.size, sizeText: fmtSize(stat.size), plan,
            src: panel.webview.asWebviewUri(uri).toString(), background: s.background, upAxis: s.upAxis,
          });
          return;
        }
        if (msg.type === 'needBytes') {
          const stat = await vscode.workspace.fs.stat(uri);
          if (!sizePlan(stat.size, settings().maxFileMB).load) return;
          const data = await vscode.workspace.fs.readFile(uri);
          await post({ type: 'bytes', data });
          return;
        }
        if (msg.type === 'rendered') { if (!counted) { counted = true; rating.success(); } return; }
        if (msg.type === 'copy') { await vscode.env.clipboard.writeText(msg.text); await post({ type: 'copied' }); return; }
        if (msg.type === 'screenshot') {
          const base = name.replace(/\.[^.]+$/, '');
          const target = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.joinPath(folder, `${base}.png`), filters: { 'PNG image': ['png'] }, saveLabel: 'Save Screenshot',
          });
          if (!target) { await post({ type: 'saved', cancelled: true }); return; }
          if (target.toString() === uri.toString() || !/\.png$/i.test(target.path)) {
            await post({ type: 'error', message: 'Choose a file name that ends in .png. The model file is never overwritten.', soft: true });
            return;
          }
          await vscode.workspace.fs.writeFile(target, msg.data);
          await post({ type: 'saved', path: target.scheme === 'file' ? target.fsPath : target.toString(), bytes: msg.data.length });
        }
      } catch (e) {
        if (msg.type === 'ready' || msg.type === 'needBytes') rating.failure();
        await post({ type: 'error', message: e && e.message ? e.message : String(e) });
      }
    });
    panel.onDidDispose(() => { disposed = true; });
  }
}

function activate(context) {
  rating = createRatingPrompt({ vscode, context, extensionId: 'zovo.3d-model-viewer', section: 'modelViewer', name: 'STL Viewer' });
  registerSupport({ vscode, context, prefix: 'modelViewer', selfId: 'zovo.3d-model-viewer' });
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, new ModelEditorProvider(context), {
      supportsMultipleEditorsPerDocument: true,
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('modelViewer.openWalkthrough', () =>
      vscode.commands.executeCommand('workbench.action.openWalkthrough', 'zovo.3d-model-viewer#modelViewer.start', false)),
    vscode.commands.registerCommand('modelViewer.openWith', async uri => {
      const target = uri || (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri);
      if (target) await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
    }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate, ModelEditorProvider, VIEW_TYPE };
