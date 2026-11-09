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

const state = { config: { maxFileMB: 1024, askForRating: true }, saveTarget: null, openTarget: null, pick: null, modal: undefined, clipboard: '', infos: [], status: [], sizeOverride: null, cfgListeners: [] };
function uriOf(p) { return { scheme: 'file', fsPath: p, path: p, with(o) { return uriOf(o.path || p); }, toString() { return 'file://' + p; } }; }
const vscodeMock = {
  Uri: { file: uriOf, joinPath: (u, ...s) => uriOf(path.posix.join(u.path, ...s)), parse: s => ({ toString: () => s }) },
  workspace: {
    workspaceFolders: [{ uri: uriOf('/ws') }],
    getConfiguration: () => ({ get: (k, d) => (k in state.config ? state.config[k] : d) }),
    fs: { stat: async u => ({ size: state.sizeOverride ?? fs.statSync(u.fsPath).size }), readFile: async u => new Uint8Array(fs.readFileSync(u.fsPath)), writeFile: async (u, d) => fs.writeFileSync(u.fsPath, d) },
    isTrusted: true,
    onDidChangeConfiguration: fn => { state.cfgListeners.push(fn); return { dispose() {} }; },
  },
  authentication: { getSession: async () => undefined },
  window: {
    registered: [], state: { focused: true },
    registerCustomEditorProvider(id, p, o) { this.registered.push([id, p, o]); return { dispose() {} }; },
    showSaveDialog: async () => state.saveTarget, showOpenDialog: async () => (state.openTarget ? [state.openTarget] : undefined),
    showInformationMessage: async (...a) => { state.infos.push(a); return a[1] && a[1].modal ? state.modal : undefined; },
    showWarningMessage: async (...a) => { state.infos.push(a); },
    showQuickPick: async items => (state.pick == null ? undefined : (await items)[state.pick]),
    setStatusBarMessage: t => { state.status.push(t); return { dispose() {} }; },
    registerUriHandler: () => ({ dispose() {} }),
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
const secretsOf = () => { const m = new Map(); return { get: async k => m.get(k), store: async (k, v) => { m.set(k, v); }, delete: async k => { m.delete(k); }, onDidChange: () => ({ dispose() {} }) }; };
const ctxOf = () => ({ extensionUri: uriOf('/ext'), subscriptions: [], secrets: secretsOf(), globalState: { data: new Map(), get(k) { return this.data.get(k); }, async update(k, v) { this.data.set(k, v); }, setKeysForSync() {} } });
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
  assert.deepEqual(vscodeMock.commands.list.sort(), ['modelViewer.enterLicenseKey', 'modelViewer.getPro', 'modelViewer.moreViewers', 'modelViewer.openWalkthrough', 'modelViewer.openWith', 'modelViewer.removeLicense', 'modelViewer.supportDeveloper', 'modelViewer.unlockWithSponsors']);
  const pkg = require('../package.json');
  assert.equal(pkg.contributes.customEditors[0].viewType, ext.VIEW_TYPE);
  assert.deepEqual(pkg.contributes.customEditors[0].selector.map(s => s.filenamePattern), ['*.glb', '*.gltf', '*.stl', '*.obj', '*.ply', '*.3mf']);
  assert.ok(pkg.displayName.toLowerCase().startsWith('stl viewer') && pkg.displayName.length <= 45);
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
    assert.equal(f.sent.filter(m => m.type === 'bytes').length, 0, 'no bytes sent');
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
  assert.equal(ctx.globalState.data.get('zovo.rating.v2').count, 1);
  const g = await open(model, ctx);
  await g.send({ type: 'rendered' });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(ctx.globalState.data.get('zovo.rating.v2').count, 2);
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

// ---------- Zovo Pro (lane PRO4) ----------
const GIF = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0x70, 0, 0, 0x3b]);
const tick = () => new Promise(r => setTimeout(r, 5));
async function proTab(ctx) {
  const f = await open(model, ctx);
  await f.send({ type: 'ready' });
  return f;
}
const last = (f, type) => f.sent.filter(m => m.type === type).at(-1);

test('pro: ready sends the Pro state after init, with 3 free tries per tool and no prompt', async () => {
  const ctx = ctxOf(); ext.activate(ctx);
  state.infos.length = 0;
  const f = await proTab(ctx);
  assert.equal(f.sent[0].type, 'init');
  const p = last(f, 'pro');
  assert.equal(p.shown, true);
  assert.equal(p.pro, false);
  assert.deepEqual(Object.keys(p.features), ['print', 'section', 'turntable']);
  assert.equal(p.features.print.label, 'Pro, 3 free tries');
  assert.equal(p.prefs.material, 'PLA');
  assert.equal(state.infos.length, 0, 'nothing shows on open');
});

test('pro: print check uses one try per tab; after 3 tabs the click shows one modal and no go', async () => {
  const ctx = ctxOf(); ext.activate(ctx);
  for (let i = 0; i < 3; i++) {
    const f = await proTab(ctx);
    await f.send({ type: 'proAsk', feature: 'print' });
    assert.equal(last(f, 'proGo').feature, 'print');
    await f.send({ type: 'proUsed', feature: 'print' });
    await f.send({ type: 'proUsed', feature: 'print' }); // a second run in the same tab is free
    assert.equal(ctx.globalState.data.get('modelViewer.proTrial').print, i + 1);
    assert.match(state.status.at(-1), new RegExp(`${2 - i} left on this computer`));
    await f.send({ type: 'proAsk', feature: 'print' });
    assert.equal(f.sent.filter(m => m.type === 'proGo').length, 2, 'the tab keeps the feature');
  }
  state.infos.length = 0; state.modal = undefined;
  const g = await proTab(ctx);
  assert.equal(last(g, 'pro').features.print.label, 'Pro');
  await g.send({ type: 'proAsk', feature: 'print' });
  assert.equal(g.sent.filter(m => m.type === 'proGo').length, 0);
  const modal = state.infos.find(a => a[1] && a[1].modal);
  assert.match(modal[0], /Print check is part of Zovo Pro/);
  assert.match(modal[1].detail, /used the 3 free tries/);
  assert.match(modal[1].detail, /USD 19 once/);
  assert.match(modal[1].detail, /stays free/);
  assert.ok(modal.includes('Unlock with GitHub Sponsors') && modal.includes('I have a license key') && modal.includes('Get Zovo Pro'));
  // the other tools still have their own tries
  await g.send({ type: 'proAsk', feature: 'section' });
  assert.equal(last(g, 'proGo').feature, 'section');
});

test('pro: saveText needs the tool in this tab, never overwrites the model, writes UTF-8', async () => {
  const ctx = ctxOf(); ext.activate(ctx);
  const f = await proTab(ctx);
  state.saveTarget = uriOf(path.join(tmp, 'r.md'));
  await f.send({ type: 'saveText', kind: 'report-md', text: '# Print check: µ' });
  assert.equal(fs.existsSync(path.join(tmp, 'r.md')), false, 'not before the tool ran');
  await f.send({ type: 'proAsk', feature: 'print' });
  await f.send({ type: 'proUsed', feature: 'print' });
  await f.send({ type: 'saveText', kind: 'report-md', text: '# Print check: µ' });
  assert.equal(fs.readFileSync(path.join(tmp, 'r.md'), 'utf8'), '# Print check: µ');
  state.saveTarget = uriOf(model);
  await f.send({ type: 'saveText', kind: 'report-md', text: 'x' });
  assert.equal(fs.readFileSync(model).length, 134, 'model untouched');
  await f.send({ type: 'saveText', kind: 'section-svg', text: '<svg/>' });
  assert.equal(fs.readFileSync(model).length, 134);
  state.saveTarget = null;
});

test('pro: turntable GIF goes to the picked file and uses a try only when saved', async () => {
  const ctx = ctxOf(); ext.activate(ctx);
  const f = await proTab(ctx);
  // cancelled quick pick: nothing happens
  state.pick = null;
  await f.send({ type: 'proAsk', feature: 'turntable' });
  assert.equal(last(f, 'turntable'), undefined);
  state.pick = 0; state.saveTarget = uriOf(path.join(tmp, 'turn.gif'));
  await f.send({ type: 'proAsk', feature: 'turntable' });
  const j = last(f, 'turntable');
  assert.deepEqual([j.format, j.width, j.height, j.frames, j.seconds], ['gif', 480, 480, 36, 3]);
  // a stopped export uses no try
  await f.send({ type: 'turntableEnd', job: j.job, ok: false, cancelled: true });
  assert.equal((ctx.globalState.data.get('modelViewer.proTrial') || {}).turntable, undefined);
  assert.match(last(f, 'hint').text, /No free try was used/);
  await f.send({ type: 'proAsk', feature: 'turntable' });
  const j2 = last(f, 'turntable');
  assert.notEqual(j2.job, j.job);
  await f.send({ type: 'turntableData', job: j.job, data: GIF }); // stale job: ignored
  assert.equal(fs.existsSync(path.join(tmp, 'turn.gif')), false);
  // the webview sends both messages at once: End must wait for the write of the GIF
  await Promise.all([f.send({ type: 'turntableData', job: j2.job, data: GIF }), f.send({ type: 'turntableEnd', job: j2.job, ok: true, frames: 36 })]);
  assert.deepEqual([...fs.readFileSync(path.join(tmp, 'turn.gif'))], [...GIF]);
  assert.equal(ctx.globalState.data.get('modelViewer.proTrial').turntable, 1);
  assert.match(last(f, 'hint').text, /Turntable saved: .*turn\.gif/);
  // a .png name for a GIF is refused
  state.saveTarget = uriOf(path.join(tmp, 'turn.png'));
  await f.send({ type: 'proAsk', feature: 'turntable' });
  assert.equal(last(f, 'error').soft, true);
  state.saveTarget = null; state.pick = null;
});

test('pro: turntable PNG frames are written one by one into the picked folder and acknowledged', async () => {
  const ctx = ctxOf(); ext.activate(ctx);
  const f = await proTab(ctx);
  const dir = path.join(tmp, 'frames'); fs.mkdirSync(dir);
  state.pick = 3; state.openTarget = uriOf(dir);
  await f.send({ type: 'proAsk', feature: 'turntable' });
  const j = last(f, 'turntable');
  assert.equal(j.format, 'png');
  for (let i = 0; i < 3; i++) await f.send({ type: 'turntableFrame', job: j.job, index: i, data: PNG });
  assert.deepEqual(f.sent.filter(m => m.type === 'turntableAck').map(m => m.index), [0, 1, 2]);
  await f.send({ type: 'turntableEnd', job: j.job, ok: true, frames: 3 });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['part-turntable-000.png', 'part-turntable-001.png', 'part-turntable-002.png']);
  assert.match(last(f, 'hint').text, /3 PNG files/);
  state.pick = null; state.openTarget = null;
});

test('pro: showProFeatures=false hides the tools; prefs are checked and kept', async () => {
  const ctx = ctxOf(); ext.activate(ctx);
  state.config.showProFeatures = false;
  try {
    const f = await proTab(ctx);
    assert.equal(last(f, 'pro').shown, false);
    await f.send({ type: 'printPrefs', prefs: { material: '<script>', infill: 900 } });
    assert.equal(ctx.globalState.data.get('modelViewer.printPrefs'), undefined, 'nothing valid: nothing stored');
    // one field per message; two quick changes in any order keep both
    await Promise.all([f.send({ type: 'printPrefs', prefs: { infill: 40 } }), f.send({ type: 'printPrefs', prefs: { material: 'PETG' } })]);
    for (const [k, v] of [['wall', 1.2], ['diameter', 2.85], ['pricePerKg', 30], ['unit', 'in']]) await f.send({ type: 'printPrefs', prefs: { [k]: v } });
    await f.send({ type: 'printPrefs', prefs: { infill: 900 } });
    assert.deepEqual(ctx.globalState.data.get('modelViewer.printPrefs'), { material: 'PETG', infill: 40, wall: 1.2, diameter: 2.85, pricePerKg: 30, unit: 'in' });
    const g = await proTab(ctx);
    assert.equal(last(g, 'pro').prefs.material, 'PETG');
    assert.equal(last(g, 'pro').prefs.unit, 'in');
  } finally { delete state.config.showProFeatures; }
});

test('pro: no network on activation, open, ask or use (fetch is never called)', async () => {
  const orig = global.fetch; let calls = 0;
  global.fetch = async () => { calls++; throw new Error('no network in this test'); };
  try {
    const ctx = ctxOf(); ext.activate(ctx);
    const f = await proTab(ctx);
    await f.send({ type: 'proAsk', feature: 'section' });
    await f.send({ type: 'proUsed', feature: 'section' });
    await tick();
    assert.equal(calls, 0);
  } finally { global.fetch = orig; }
});
