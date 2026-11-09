'use strict';
const vscode = require('vscode');
const path = require('path');
const { buildHtml } = require('./html');
const { validateWebviewMessage, sizePlan, fmtSize, formatOf } = require('./core/protocol');
const { createRatingPrompt } = require('./rate');
const { registerSupport, commandUris, showLinks } = require('./support');
const { createPro } = require('./pro');
const { SAVE_KINDS, PRINT_DEFAULTS, cleanPrefs } = require('./core/protocol');

const VIEW_TYPE = 'modelViewer.preview';
let rating = { success() {}, failure() {} };
let pro = null;
const PREFS_KEY = 'modelViewer.printPrefs';

// Turntable presets (Zovo Pro). Frames turn 360 degrees in `seconds`.
const TURNTABLE = [
  { label: 'GIF, 480 × 480, 3 s turn', detail: '36 frames, a small file for a README or a pull request', format: 'gif', width: 480, height: 480, frames: 36, seconds: 3 },
  { label: 'GIF, 640 × 480, 4 s turn', detail: '48 frames', format: 'gif', width: 640, height: 480, frames: 48, seconds: 4 },
  { label: 'GIF, 800 × 600, 6 s turn', detail: '72 frames, smooth, a larger file', format: 'gif', width: 800, height: 600, frames: 72, seconds: 6 },
  { label: 'PNG frames, 1280 × 960', detail: '72 numbered PNG files in a folder you pick, for video tools', format: 'png', width: 1280, height: 960, frames: 72, seconds: 6 },
];
let nextJob = 1;

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
    // Zovo Pro: features this tab may use without asking again (a free try covers one tab), and the running export.
    const granted = new Set();
    let job = null;
    const postPro = () => post({ type: 'pro', ...(pro ? pro.view() : { shown: false, pro: false, features: {} }), granted: [...granted], prefs: cleanPrefs(ctx.globalState.get(PREFS_KEY) || PRINT_DEFAULTS) });
    const turntable = async () => {
      if (job) { await post({ type: 'hint', text: 'A turntable export is already running.' }); return; }
      if (!(await pro.allow('turntable'))) { await postPro(); return; }
      const pick = await vscode.window.showQuickPick(TURNTABLE.map(t => ({ label: t.label, detail: t.detail, t })), { title: 'Turntable export (Zovo Pro)', placeHolder: 'Size and length of the turn' });
      if (!pick) return;
      const t = pick.t;
      const base = name.replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_') || 'model';
      const j = { id: nextJob++, format: t.format, base, written: 0, bytes: 0 };
      if (t.format === 'gif') {
        const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(folder, `${base}-turntable.gif`), filters: { 'GIF image': ['gif'] }, saveLabel: 'Save Turntable' });
        if (!target) return;
        if (target.toString() === uri.toString() || !/\.gif$/i.test(target.path)) { await post({ type: 'error', message: 'Choose a file name that ends in .gif. The model file is never overwritten.', soft: true }); return; }
        j.target = target;
      } else {
        const dirs = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, defaultUri: folder, openLabel: 'Save Frames Here' });
        if (!dirs || !dirs[0]) return;
        j.dir = dirs[0];
      }
      job = j;
      await post({ type: 'turntable', job: j.id, format: t.format, width: t.width, height: t.height, frames: t.frames, seconds: t.seconds });
    };
    const proSub = pro ? pro.onDidChange(() => postPro()) : null;
    const cfgSub = vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('modelViewer.showProFeatures')) postPro(); });

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
          await postPro();
          return;
        }
        if (msg.type === 'proAsk') {
          if (!pro) return;
          const f = msg.feature;
          if (f === 'turntable') { await turntable(); return; }
          if (granted.has(f) || await pro.allow(f)) await post({ type: 'proGo', feature: f });
          await postPro();
          return;
        }
        if (msg.type === 'proUsed') {
          // print and section: the first run in this tab uses the try; the tab keeps the feature after that.
          if (!pro || msg.feature === 'turntable' || granted.has(msg.feature)) return;
          granted.add(msg.feature);
          await pro.use(msg.feature);
          await postPro();
          return;
        }
        if (msg.type === 'proCmd') {
          if (!pro) return;
          if (msg.cmd === 'getPro') await pro.license.getPro();
          else if (msg.cmd === 'unlock') await pro.license.unlock();
          else if (msg.cmd === 'enterKey') await pro.license.unlock('license-key');
          else if (msg.cmd === 'hide') await vscode.commands.executeCommand('workbench.action.openSettings', 'modelViewer.showProFeatures');
          await postPro();
          return;
        }
        if (msg.type === 'printPrefs') { await ctx.globalState.update(PREFS_KEY, cleanPrefs({ ...(ctx.globalState.get(PREFS_KEY) || PRINT_DEFAULTS), ...msg.prefs })); return; }
        if (msg.type === 'saveText') {
          // Only after the feature ran in this tab (the webview shows Save only then).
          const feature = msg.kind === 'section-svg' ? 'section' : 'print';
          if (!pro || (!granted.has(feature) && !pro.isPro())) return;
          const k = SAVE_KINDS[msg.kind];
          const base = name.replace(/\.[^.]+$/, '');
          const target = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.joinPath(folder, `${base}${k.suffix}.${k.ext}`), filters: { [k.filter]: [k.ext] }, saveLabel: 'Save',
          });
          if (!target) return;
          if (target.toString() === uri.toString()) { await post({ type: 'error', message: 'The model file is never overwritten. Choose another name.', soft: true }); return; }
          await vscode.workspace.fs.writeFile(target, Buffer.from(msg.text, 'utf8'));
          await post({ type: 'hint', text: `Saved ${target.scheme === 'file' ? target.fsPath : target.toString()}` });
          return;
        }
        if (msg.type === 'turntableFrame') {
          const j = job;
          if (!j || j.id !== msg.job || j.format !== 'png') return;
          const file = vscode.Uri.joinPath(j.dir, `${j.base}-turntable-${String(msg.index).padStart(3, '0')}.png`);
          try { await vscode.workspace.fs.writeFile(file, msg.data); } catch (e) {
            await post({ type: 'turntableAck', job: j.id, index: msg.index, error: e && e.message ? e.message : String(e) });
            return;
          }
          j.written++;
          await post({ type: 'turntableAck', job: j.id, index: msg.index });
          return;
        }
        if (msg.type === 'turntableData') {
          const j = job;
          if (!j || j.id !== msg.job || j.format !== 'gif') return;
          // turntableEnd can arrive while this write runs; it waits for j.pending.
          j.pending = Promise.resolve(vscode.workspace.fs.writeFile(j.target, msg.data)).then(() => { j.written = 1; j.bytes = msg.data.length; });
          await j.pending;
          return;
        }
        if (msg.type === 'turntableEnd') {
          const j = job;
          if (!j || j.id !== msg.job) return;
          job = null;
          let writeError = '';
          if (j.pending) await j.pending.catch(e => { writeError = e && e.message ? e.message : String(e); });
          if (writeError) { await post({ type: 'hint', text: `Turntable export failed: ${writeError}. No free try was used.` }); await postPro(); return; }
          if (msg.ok && j.written) {
            await pro.use('turntable');
            const where = j.format === 'gif' ? `${j.target.scheme === 'file' ? j.target.fsPath : j.target.toString()} (${fmtSize(j.bytes)})` : `${j.written} PNG files in ${j.dir.scheme === 'file' ? j.dir.fsPath : j.dir.toString()}`;
            await post({ type: 'hint', text: `Turntable saved: ${where}` });
          } else {
            await post({ type: 'hint', text: msg.cancelled ? 'Turntable export stopped. No free try was used.' : `Turntable export failed: ${msg.error || 'unknown error'}. No free try was used.` });
          }
          await postPro();
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
        if (msg.type === 'failed') { rating.failure(); return; }
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
        const opening = msg.type === 'ready' || msg.type === 'needBytes';
        if (opening) rating.failure();
        // Errors of a save or a Pro tool go to the status line; the model stays on screen.
        await post({ type: 'error', message: e && e.message ? e.message : String(e), soft: !opening });
      }
    });
    panel.onDidDispose(() => { disposed = true; job = null; if (proSub) proSub.dispose(); cfgSub.dispose(); });
  }
}

function activate(context) {
  rating = createRatingPrompt({ vscode, context, extensionId: 'zovo.3d-model-viewer', section: 'modelViewer', name: 'STL Viewer' });
  registerSupport({ vscode, context, prefix: 'modelViewer', selfId: 'zovo.3d-model-viewer' });
  // Zovo Pro (print check, section view, turntable export). Reads local caches only: no network on start.
  pro = createPro({ vscode, context });
  if (vscode.window.registerUriHandler) context.subscriptions.push(vscode.window.registerUriHandler({ handleUri: u => pro.handleUri(u) }));
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
