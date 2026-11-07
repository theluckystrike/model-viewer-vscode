'use strict';
// The extension host on a mocked VS Code API.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-ext-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const state = { config: { maxFileMB: 1024, askForRating: true }, saveTarget: null, clipboard: '', infos: [], sizeOverride: null };
function uriOf(p) { return { scheme: 'file', fsPath: p, path: p, with(o) { return uriOf(o.path || p); }, toString() { return 'file://' + p; } }; }
const vscodeMock = {
  Uri: { file: uriOf, joinPath: (u, ...s) => uriOf(path.posix.join(u.path, ...s)), parse: s => ({ toString: () => s }) },
  workspace: {
    workspaceFolders: [{ uri: uriOf('/ws') }],
    getConfiguration: () => ({ get: (k, d) => (k in state.config ? state.config[k] : d) }),
    fs: { stat: async u => ({ size: state.sizeOverride ?? fs.statSync(u.fsPath).size }), readFile: async u => new Uint8Array(fs.readFileSync(u.fsPath)), writeFile: async (u, d) => fs.writeFileSync(u.fsPath, d) },
    isTrusted: true,
  },
  window: {
    registered: [], state: { focused: true },
    registerCustomEditorProvider(id, p, o) { this.registered.push([id, p, o]); return { dispose() {} }; },
    showSaveDialog: async () => state.saveTarget, showInformationMessage: async (...a) => { state.infos.push(a); },
  },
  commands: { list: [], registerCommand(id) { this.list.push(id); return { dispose() {} }; }, executeCommand: async () => {} },
  env: { clipboard: { writeText: async t => { state.clipboard = t; } }, sessionId: 's1', openExternal: async () => true },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'vscode' ? vscodeMock : origLoad.call(this, req, ...rest); };
const ext = require('../src/extension.js');

function fakePanel() {
  const sent = []; let handler = null; let dispose = null;
  const panel = {
    webview: { options: null, html: '', cspSource: 'https://csp', asWebviewUri: u => 'https://res' + u.path, postMessage: async m => { sent.push(m); return true; }, onDidReceiveMessage: h => { handler = h; } },
    onDidDispose: h => { dispose = h; },
  };
  return { panel, sent, send: m => handler(m), close: () => dispose() };
}
const ctxOf = () => ({ extensionUri: uriOf('/ext'), subscriptions: [], globalState: { data: new Map(), get(k) { return this.data.get(k); }, async update(k, v) { this.data.set(k, v); } } });
async function open(file, ctx = ctxOf()) {
  const prov = new ext.ModelEditorProvider(ctx);
  const f = fakePanel();
  await prov.resolveCustomEditor({ uri: uriOf(file) }, f.panel);
  return Object.assign(f, { ctx });
}
const model = path.join(tmp, 'part.stl');
fs.writeFileSync(model, Buffer.alloc(84 + 50));

test('activate registers the custom editor and the commands; manifest matches', () => {
  ext.activate(ctxOf());
  assert.equal(vscodeMock.window.registered[0][0], 'modelViewer.preview');
  assert.equal(vscodeMock.window.registered[0][2].supportsMultipleEditorsPerDocument, true);
  assert.deepEqual(vscodeMock.commands.list.sort(), ['modelViewer.moreViewers', 'modelViewer.openWalkthrough', 'modelViewer.openWith', 'modelViewer.supportDeveloper']);
  const pkg = require('../package.json');
  assert.equal(pkg.contributes.customEditors[0].viewType, ext.VIEW_TYPE);
  assert.deepEqual(pkg.contributes.customEditors[0].selector.map(s => s.filenamePattern), ['*.glb', '*.gltf', '*.stl', '*.obj', '*.ply', '*.3mf']);
  assert.ok(pkg.displayName.toLowerCase().startsWith('3d model viewer') && pkg.displayName.length <= 45);
  assert.ok(pkg.keywords.length <= 30);
  assert.equal(pkg.publisher, 'zovo');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/); // monetize.py rollouts bump it
});

test('webview options: scripts on, roots are dist, media, the model folder and workspace folders; CSP set', async () => {
  const f = await open(model);
  assert.equal(f.panel.webview.options.enableScripts, true);
  assert.deepEqual(f.panel.webview.options.localResourceRoots.map(u => u.path), ['/ext/dist', '/ext/media', tmp, '/ws']);
  assert.match(f.panel.webview.html, /Content-Security-Policy/);
  assert.match(f.panel.webview.html, /part\.stl/);
});

test('ready gives init with format, size, plan and the resource URL', async () => {
  const f = await open(model);
  await f.send({ type: 'ready' });
  const m = f.sent[0];
  assert.equal(m.type, 'init');
  assert.equal(m.format, 'stl');
  assert.equal(m.size, 134);
  assert.equal(m.plan.load, true);
  assert.equal(m.src, 'https://res' + model);
  assert.equal(m.background, 'theme');
});

test('over the limit: init says do not load, needBytes is refused', async () => {
  state.sizeOverride = 1.1 * 1024 ** 3;
  try {
    const f = await open(model);
    await f.send({ type: 'ready' });
    assert.equal(f.sent[0].plan.load, false);
    assert.match(f.sent[0].plan.message, /1\.1 GB/);
    await f.send({ type: 'needBytes' });
    assert.equal(f.sent.length, 1, 'no bytes sent');
  } finally { state.sizeOverride = null; }
});

test('needBytes posts the file bytes (remote fallback)', async () => {
  const f = await open(model);
  await f.send({ type: 'needBytes' });
  assert.equal(f.sent[0].type, 'bytes');
  assert.equal(f.sent[0].data.length, 134);
});

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
test('screenshot: saves the PNG, refuses non-PNG names and the model itself, handles cancel', async () => {
  const f = await open(model);
  state.saveTarget = uriOf(path.join(tmp, 'shot.png'));
  await f.send({ type: 'screenshot', data: PNG });
  assert.deepEqual([...fs.readFileSync(path.join(tmp, 'shot.png'))], [...PNG]);
  assert.equal(f.sent.at(-1).type, 'saved');
  assert.equal(f.sent.at(-1).bytes, PNG.length);
  state.saveTarget = uriOf(path.join(tmp, 'shot.txt'));
  await f.send({ type: 'screenshot', data: PNG });
  assert.equal(f.sent.at(-1).type, 'error');
  assert.equal(fs.existsSync(path.join(tmp, 'shot.txt')), false);
  state.saveTarget = uriOf(model);
  await f.send({ type: 'screenshot', data: PNG });
  assert.equal(fs.readFileSync(model).length, 134, 'model untouched');
  state.saveTarget = null;
  await f.send({ type: 'screenshot', data: PNG });
  assert.equal(f.sent.at(-1).cancelled, true);
  const n = f.sent.length;
  await f.send({ type: 'screenshot', data: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]) });
  assert.equal(f.sent.length, n, 'non-PNG data is dropped before any dialog');
});

test('copy goes to the clipboard; unknown messages are dropped', async () => {
  const f = await open(model);
  await f.send({ type: 'copy', text: 'Vertices\t8' });
  assert.equal(state.clipboard, 'Vertices\t8');
  assert.equal(f.sent.at(-1).type, 'copied');
  const n = f.sent.length;
  await f.send({ type: 'writeFile', path: '/etc/passwd', data: 'x' });
  await f.send(null);
  assert.equal(f.sent.length, n);
});

test('rendered counts one success per tab for the rating prompt', async () => {
  const ctx = ctxOf();
  ext.activate(ctx);
  const f = await open(model, ctx);
  await f.send({ type: 'rendered' });
  await f.send({ type: 'rendered' });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(ctx.globalState.data.get('zovo.rating.v1').count, 1);
  const g = await open(model, ctx);
  await g.send({ type: 'rendered' });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(ctx.globalState.data.get('zovo.rating.v1').count, 2);
});

test('after dispose nothing is posted', async () => {
  const f = await open(model);
  f.close();
  await f.send({ type: 'ready' });
  assert.equal(f.sent.length, 0);
});

// ---------- support links (Sponsor, More free viewers) ----------
test('support: package.json has the sponsor field, the two commands and the setting', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const support = require('../src/support');
  assert.equal(pkg.sponsor.url, 'https://github.com/sponsors/theluckystrike');
  assert.equal(pkg.sponsor.url, support.sponsorUrl());
  const ids = pkg.contributes.commands.map(c => c.command);
  assert.ok(ids.includes('modelViewer.supportDeveloper') && ids.includes('modelViewer.moreViewers'));
  const prop = [].concat(pkg.contributes.configuration).map(c => c.properties['modelViewer.showSupportLinks']).find(Boolean);
  assert.equal(prop.default, true);
  assert.ok(support.otherProducts('zovo.3d-model-viewer').every(p => p.id !== 'zovo.3d-model-viewer'));
});

test('support: the footer shows by default and modelViewer.showSupportLinks=false hides it', async () => {
  try {
    for (const [val, shown] of [[undefined, true], [false, false]]) {
      if (val === undefined) delete state.config.showSupportLinks; else state.config.showSupportLinks = val;
      const f = await open(model);
      const html = f.panel.webview.html;
      assert.equal(/id="zovo-support"/.test(html), shown, String(val));
      assert.equal(html.includes('command:modelViewer.supportDeveloper'), shown);
      assert.deepEqual(f.panel.webview.options.enableCommandUris, ['modelViewer.supportDeveloper', 'modelViewer.moreViewers', 'workbench.action.openSettings']);
    }
  } finally { delete state.config.showSupportLinks; }
});
