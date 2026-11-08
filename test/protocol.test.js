'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const P = require('../src/core/protocol');
const { buildHtml } = require('../src/html');

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

test('formatOf maps the six extensions, case-insensitive', () => {
  assert.equal(P.formatOf('a.GLB'), 'glb');
  assert.equal(P.formatOf('dir/a.gltf'), 'gltf');
  assert.equal(P.formatOf('a.stl'), 'stl');
  assert.equal(P.formatOf('a.Obj'), 'obj');
  assert.equal(P.formatOf('a.ply'), 'ply');
  assert.equal(P.formatOf('a.3mf'), '3mf');
  assert.equal(P.formatOf('a.fbx'), null);
  assert.equal(P.formatOf('noext'), null);
});

test('sizePlan: files over the limit are not loaded and get a clear message', () => {
  assert.deepEqual(P.sizePlan(5e6, 1024), { load: true, limitMB: 1024 });
  const big = P.sizePlan(1.1 * 1024 ** 3, 1024);
  assert.equal(big.load, false);
  assert.match(big.message, /1\.1 GB/);
  assert.match(big.message, /up to 1\.0 GB/);
  assert.match(big.message, /modelViewer\.maxFileMB/);
  assert.equal(P.sizePlan(10, -5).limitMB, 1024, 'bad setting falls back to 1024');
  assert.equal(P.sizePlan(10, 99999).limitMB, 4096, 'capped at 4 GB');
});

test('only known webview messages pass', () => {
  assert.deepEqual(P.validateWebviewMessage({ type: 'ready', extra: 1 }), { ok: true, msg: { type: 'ready' } });
  assert.equal(P.validateWebviewMessage({ type: 'rendered' }).ok, true);
  assert.deepEqual(P.validateWebviewMessage({ type: 'failed', x: 1 }), { ok: true, msg: { type: 'failed' } });
  assert.equal(P.validateWebviewMessage({ type: 'needBytes' }).ok, true);
  for (const bad of [null, 1, 'ready', {}, { type: 'writeFile', path: '/etc/x' }, { type: 'openExternal', url: 'https://x' }, { type: 'export' }])
    assert.equal(P.validateWebviewMessage(bad).ok, false, JSON.stringify(bad));
});

test('screenshot must be PNG bytes', () => {
  assert.equal(P.validateWebviewMessage({ type: 'screenshot', data: PNG }).ok, true);
  assert.equal(P.validateWebviewMessage({ type: 'screenshot', data: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]) }).ok, false, 'not PNG');
  assert.equal(P.validateWebviewMessage({ type: 'screenshot', data: 'iVBORw0KGgo=' }).ok, false, 'string');
  assert.equal(P.validateWebviewMessage({ type: 'screenshot' }).ok, false);
  assert.equal(P.validateWebviewMessage({ type: 'copy', text: 'a\tb' }).ok, true);
  assert.equal(P.validateWebviewMessage({ type: 'copy', text: 'x'.repeat(100001) }).ok, false);
  assert.equal(P.validateWebviewMessage({ type: 'copy', text: 5 }).ok, false);
});

test('sniff: GLB header, version and truncation', () => {
  const g = Buffer.alloc(20); g.write('glTF'); g.writeUInt32LE(2, 4); g.writeUInt32LE(20, 8);
  assert.deepEqual(P.sniff(g, 'glb'), { ok: true, detail: 'binary' });
  const v1 = Buffer.from(g); v1.writeUInt32LE(1, 4);
  assert.match(P.sniff(v1, 'glb').reason, /version 1/);
  const cut = Buffer.from(g); cut.writeUInt32LE(999, 8);
  assert.match(P.sniff(cut, 'glb').reason, /cut off/);
  assert.match(P.sniff(Buffer.from('hello world'), 'glb').reason, /not a GLB/);
  assert.equal(P.sniff(Buffer.from(' {"asset":{}}'), 'glb').detail, 'json');
  assert.equal(P.sniff(Buffer.from('\uFEFF{"asset":{}}'), 'gltf').ok, true);
  assert.equal(P.sniff(Buffer.from('<xml/>'), 'gltf').ok, false);
  assert.match(P.sniff(new Uint8Array(0), 'stl').reason, /empty/);
});

test('sniff: STL binary vs ASCII, PLY header, 3MF zip, OBJ text', () => {
  const b = Buffer.alloc(84 + 2 * 50); b.write('solid looks like ascii but is binary'); b.writeUInt32LE(2, 80);
  assert.deepEqual(P.sniff(b, 'stl'), { ok: true, detail: 'binary', triangles: 2 });
  assert.equal(P.sniff(Buffer.from('solid x\nfacet normal 0 0 1\nouter loop\n'), 'stl').detail, 'ascii');
  assert.equal(P.sniff(Buffer.from('tiny'), 'stl').ok, false);
  const odd = Buffer.alloc(200); odd.writeUInt32LE(7, 80);
  assert.ok(P.sniff(odd, 'stl').warning);
  const ply = P.sniff(Buffer.from('ply\nformat ascii 1.0\nelement vertex 8\nproperty float x\nelement face 12\nproperty list uchar int vertex_indices\nend_header\n'), 'ply');
  assert.deepEqual([ply.ok, ply.detail, ply.vertices, ply.faces], [true, 'ascii', 8, 12]);
  assert.match(P.sniff(Buffer.from('ply\nformat weird 1.0\nend_header\n'), 'ply').reason, /format/);
  assert.match(P.sniff(Buffer.from('ply\nformat ascii 1.0\n'), 'ply').reason, /end_header/);
  assert.match(P.sniff(Buffer.from('plx\n'), 'ply').reason, /not a PLY/);
  assert.equal(P.sniff(Buffer.from('PK\x03\x04'), '3mf').ok, true);
  assert.match(P.sniff(Buffer.from('<model/>'), '3mf').reason, /ZIP/);
  assert.equal(P.sniff(Buffer.from('v 0 0 0\nf 1 2 3\n'), 'obj').ok, true);
  assert.match(P.sniff(Buffer.from([0x76, 0, 0, 0x20]), 'obj').reason, /binary/);
});

test('mtlLibs keeps plain relative names and drops URLs, absolute paths and ..', () => {
  const t = 'mtllib a.mtl\n  mtllib sub/b.mtl \nmtllib ../escape.mtl\nmtllib /etc/passwd\nmtllib https://x.test/c.mtl\nmtllib C:\\x.mtl\nmtllib dir\\d.mtl\n';
  assert.deepEqual(P.mtlLibs(t), ['a.mtl', 'sub/b.mtl', 'dir/d.mtl']);
});

test('CSP: nonce script, no remote, no unsafe; title escaped', () => {
  const html = buildHtml({ cspSource: 'https://res.test', scriptUri: 'https://res.test/w.js', styleUri: 'https://res.test/s.css', title: '<img src=x onerror=alert(1)>.glb', nonce: 'N0NCE' });
  const csp = /content="([^"]+)"/.exec(html)[1];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'nonce-N0NCE'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*|http:/);
  assert.match(csp, /connect-src https:\/\/res\.test data: blob:/);
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;.glb'));
});

test('webview code: no innerHTML, no eval, fetch only for the model and its neighbours', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'webview', 'main.js'), 'utf8');
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/);
  assert.doesNotMatch(src, /https?:\/\//);
  const fetches = src.match(/fetch\(/g) || [];
  assert.equal(fetches.length, 2, 'the model file and the .mtl next to it');
});

test('extension host writes only the screenshot', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.js'), 'utf8');
  assert.equal((src.match(/writeFile\(/g) || []).length, 1);
  assert.doesNotMatch(src, /https?:\/\//);
});
