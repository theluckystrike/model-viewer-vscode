// Release check in a real VS Code: installs the .vsix into an isolated profile, opens the generated samples,
// drives the webview with real mouse and key events, saves screenshots and a JSON report.
// usage: node scripts/e2e-vscode.mjs <work> <port> <vsix> <samplesDir> <shotDir> <outJson>
import { launch, installVsix, sleep } from './vsc.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

const [work0, port, vsix, ws0, shotDir, outJson] = process.argv.slice(2);
const work = path.resolve(work0), ws = path.resolve(ws0);
const R = { install: null, steps: [], console: [], hashes: {}, unchanged: null };
const hash = f => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
for (const f of fs.readdirSync(ws)) if (fs.statSync(path.join(ws, f)).size < 50e6) R.hashes[f] = hash(path.join(ws, f));
fs.rmSync(path.join(work, 'ud'), { recursive: true, force: true });
R.install = installVsix(work, vsix);
const clipBefore = (() => { try { return execSync('pbpaste', { encoding: 'utf8' }); } catch { return null; } })();
const vs = await launch(work, Number(port), ws, { 'files.simpleDialog.enable': true, 'workbench.secondarySideBar.defaultVisibility': 'hidden', 'workbench.auxiliaryBar.visible': false, 'window.titleBarStyle': 'custom', 'workbench.sideBar.location': 'left' });
const shots = [];
const shot = async name => { const f = path.join(shotDir, `model-${String(shots.length + 1).padStart(2, '0')}-${name}.png`); await vs.shot(f); shots.push(f); return f; };
const step = async (name, fn) => {
  const t0 = Date.now();
  try { const v = await fn(); R.steps.push({ name, ok: v !== false, value: v, ms: Date.now() - t0 }); }
  catch (e) { R.steps.push({ name, ok: false, error: String(e.message || e).slice(0, 600), ms: Date.now() - t0 }); try { await shot('FAIL-' + name.replace(/\W+/g, '_').slice(0, 40)); } catch {} }
};
let wv;
const E = expr => vs.wvEval(wv, expr);
const probe = async () => JSON.parse(await E(`JSON.stringify(window.modelViewerProbe ? window.modelViewerProbe() : null)`));
const getWv = async title => vs.waitFor(async () => (await vs.webviews()).find(w => w.title === title && w.w > 0), 20000);
const open = async file => { const t0 = Date.now(); vs.open(path.join(ws, file)); await sleep(800); wv = await getWv(file); if (!wv) throw new Error('no webview for ' + file); return Date.now() - t0; };
const loaded = async () => { const ok = await vs.waitFor(async () => (await probe())?.loaded, 30000, 200); if (!ok) throw new Error('not loaded: ' + await E(`document.querySelector('.notice').textContent`)); await sleep(300); return probe(); };
const text = sel => E(`(document.querySelector(${JSON.stringify(sel)}) || {}).textContent || ''`);
const statsText = () => E(`document.querySelector('.stats').innerText`);
const stat = async k => { const m = new RegExp('^' + k + '\\s+(.+)$', 'm').exec(await statsText()); return m ? m[1].trim() : null; };
const btn = t => `[...document.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(t)})`;
const select = async (sel, value) => { await E(`(() => { const s = document.querySelector(${JSON.stringify(sel)}); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change')); return 1; })()`); await sleep(400); };
const canvasPoint = async (fx, fy) => { const off = await vs.wvOffset(); const b = JSON.parse(await E(`JSON.stringify(document.querySelector('.stage canvas').getBoundingClientRect())`)); return { x: off.x + b.x + b.width * fx, y: off.y + b.y + b.height * fy }; };

try {
  await sleep(2500);
  await vs.command('View: Close Primary Side Bar').catch(() => {});
  await step('robot-arm.glb opens as the default editor and draws: stats, animation bar, scene tree', async () => {
    const ms = await open('robot-arm.glb'); const p = await loaded();
    const tree = await E(`[...document.querySelectorAll('.tree .node-name')].map(n => n.textContent).join('|')`);
    const clips = await E(`[...document.querySelectorAll('select[aria-label="Animation clip"] option')].map(o => o.textContent).join('|')`);
    const anim = await E(`!document.querySelector('.animbar').hidden`);
    if (p.coverage < 0.03 || p.stats.meshes !== 10 || p.stats.materials !== 4 || !anim || !/Wave.*Spin.*Grip/.test(clips) || !/Elbow/.test(tree)) throw new Error(JSON.stringify({ p, clips, tree }));
    await sleep(1200);
    await shot('robot-arm-glb');
    return { openMs: ms, coverage: +p.coverage.toFixed(3), vertices: await stat('Vertices'), triangles: await stat('Triangles'), materials: await stat('Materials'), size: await stat('Size'), clips, treeNodes: tree.split('|').length };
  });
  await step('animation: clip picker, time advances, Pause stops it, slider scrubs', async () => {
    await select('select[aria-label="Animation clip"]', '1');
    const a = await probe(); await sleep(700); const b = await probe();
    await vs.wvClick(wv, btn('Pause')); await sleep(200);
    const c = await probe(); await sleep(600); const d = await probe();
    await E(`(() => { const r = document.querySelector('input[aria-label="Animation time"]'); r.value = '3'; r.dispatchEvent(new Event('input')); return 1; })()`);
    const e = await probe();
    if (a.clip !== 'Spin' || !(b.time > a.time) || c.state.playing || Math.abs(d.time - c.time) > 1e-6 || Math.abs(e.time - 3) > 0.01) throw new Error(JSON.stringify({ a: [a.clip, a.time], b: b.time, c: c.time, d: d.time, e: e.time }));
    await vs.wvClick(wv, btn('Play'));
    await select('select[aria-label="Animation clip"]', '0');
    return { clip: a.clip, advanced: +(b.time - a.time).toFixed(2), pausedAt: +c.time.toFixed(3), scrubbedTo: e.time, timeText: await text('.timetext') };
  });
  await step('scene tree: unchecking UpperArm hides it (fewer drawn pixels); click name frames the node', async () => {
    await vs.wvClick(wv, btn('Pause'));
    const before = (await probe()).coverage;
    await vs.wvClick(wv, `[...document.querySelectorAll('.tree .node')].find(n => n.querySelector('.node-name').textContent === 'UpperArm').querySelector('input')`);
    await sleep(300);
    const after = (await probe()).coverage;
    await vs.wvClick(wv, `[...document.querySelectorAll('.tree .node')].find(n => n.querySelector('.node-name').textContent === 'UpperArm').querySelector('input')`);
    const d0 = (await probe()).cameraDistance;
    await vs.wvClick(wv, `[...document.querySelectorAll('.tree .node-name')].find(n => n.textContent === 'Wrist')`); await sleep(300);
    const d1 = (await probe()).cameraDistance;
    await vs.wvClick(wv, btn('Fit')); await sleep(300);
    const d2 = (await probe()).cameraDistance;
    await vs.wvClick(wv, btn('Play'));
    if (!(after < before) || !(d1 < d0) || Math.abs(d2 - d0) > d0 * 0.05) throw new Error(JSON.stringify({ before, after, d0, d1, d2 }));
    return { coverageBefore: +before.toFixed(3), coverageHidden: +after.toFixed(3), frameWristDistance: +d1.toFixed(3), fitDistance: +d2.toFixed(3) };
  });
  await step('helpers: wireframe, normals, bounds, axes by real clicks and keys', async () => {
    await vs.wvClick(wv, btn('Wireframe')); await vs.wvClick(wv, btn('Normals')); await vs.wvClick(wv, btn('Bounds')); await vs.wvClick(wv, btn('Axes'));
    await sleep(300);
    const p = await probe(); const hint = await text('.hint');
    const pressed = await E(`[...document.querySelectorAll('button[aria-pressed="true"]')].map(b => b.textContent).join(',')`);
    await shot('robot-arm-helpers');
    // keys: focus the canvas, then W turns wireframe off
    const c = await canvasPoint(0.05, 0.95); await vs.click(c.x, c.y); await vs.key('w', 'KeyW', 0, 87); await sleep(200);
    const afterKey = (await probe()).state.wireframe;
    for (const b of ['Normals', 'Bounds', 'Axes']) await vs.wvClick(wv, btn(b));
    if (!p.state.wireframe || !p.state.normals || !p.state.bounds || !p.state.axes || afterKey !== false || !/Bounding box/.test(hint)) throw new Error(JSON.stringify({ s: p.state, hint, afterKey }));
    return { pressed, boundsHint: hint, wireframeAfterW: afterKey };
  });
  await step('wheel zoom then Fit restores the view', async () => {
    await vs.wvClick(wv, btn('Pause')); await vs.wvClick(wv, btn('Fit')); await sleep(300); // same pose for both fits
    const d0 = (await probe()).cameraDistance;
    const c = await canvasPoint(0.5, 0.5);
    for (let i = 0; i < 4; i++) { await vs.s.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: c.x, y: c.y, deltaX: 0, deltaY: -300 }, vs.wb); await sleep(80); }
    await sleep(600);
    const d1 = (await probe()).cameraDistance;
    await vs.key('f', 'KeyF', 0, 70); await sleep(300);
    const d2 = (await probe()).cameraDistance;
    await vs.wvClick(wv, btn('Play'));
    if (!(d1 < d0 * 0.9) || Math.abs(d2 - d0) > d0 * 0.05) throw new Error(JSON.stringify({ d0, d1, d2 }));
    return { start: +d0.toFixed(3), zoomed: +d1.toFixed(3), afterF: +d2.toFixed(3) };
  });
  await step('gear.stl: Z up, stats, measure between two clicked points', async () => {
    await open('gear.stl'); const p = await loaded();
    await vs.wvClick(wv, btn('Measure'));
    let a = await canvasPoint(0.5, 0.5), got = 0;
    // find two surface points: walk outward from the centre until a click lands on the gear
    for (const [fx, fy] of [[0.36, 0.5], [0.4, 0.42], [0.38, 0.55], [0.33, 0.45]]) { a = await canvasPoint(fx, fy); await vs.click(a.x, a.y); await sleep(250); if (/second point/.test(await text('.hint'))) { got = 1; break; } }
    for (const [fx, fy] of [[0.64, 0.5], [0.6, 0.58], [0.62, 0.45], [0.67, 0.55]]) { if (!got) break; const b = await canvasPoint(fx, fy); await vs.click(b.x, b.y); await sleep(300); if (/Distance/.test(await text('.hint'))) { got = 2; break; } }
    const hint = await text('.hint'); const label = await text('.measure-label');
    await shot('gear-stl-measure');
    if (got !== 2 || !/^Distance [\d.]+ units/.test(hint) || p.up !== 'z' || !p.stats.triangles) throw new Error(JSON.stringify({ got, hint, label, up: p.up }));
    await vs.key('Escape', 'Escape');
    return { up: p.up, triangles: await stat('Triangles'), size: await stat('Size'), label, hint };
  });
  await step('shading: smooth merges STL facets, flat, as stored', async () => {
    await select('select[aria-label="Shading"]', 'smooth'); const h1 = await text('.hint');
    await select('select[aria-label="Shading"]', 'flat'); const h2 = await text('.hint');
    await vs.wvClick(wv, btn('Wireframe')); await sleep(200);
    await shot('gear-stl-flat-wireframe');
    await vs.wvClick(wv, btn('Wireframe'));
    await select('select[aria-label="Shading"]', 'file');
    if (!/smooth/.test(h1) || !/flat/.test(h2)) throw new Error(h1 + ' / ' + h2);
    return { smooth: h1, flat: h2 };
  });
  await step('lantern.gltf: external .bin and PNG texture load, 1 texture, no missing-file note', async () => {
    await open('lantern.gltf'); const p = await loaded();
    const hint = await text('.hint');
    await sleep(500);
    await shot('lantern-gltf');
    if (p.stats.textures !== 1 || /Could not load/.test(hint) || p.unit !== 'm') throw new Error(JSON.stringify({ stats: p.stats, hint }));
    return { textures: p.stats.textures, meshes: p.stats.meshes, size: await stat('Size'), coverage: +p.coverage.toFixed(3) };
  });
  await step('torus-knot.obj: .mtl found and applied, 2 meshes', async () => {
    await open('torus-knot.obj'); const p = await loaded();
    const hint = await text('.hint');
    const tree = await E(`[...document.querySelectorAll('.tree .node-name')].map(n => n.textContent).join('|')`);
    await shot('torus-knot-obj');
    if (!/Materials from torus-knot\.mtl/.test(hint) || p.stats.meshes !== 2) throw new Error(JSON.stringify({ hint, stats: p.stats }));
    return { hint, tree, triangles: await stat('Triangles') };
  });
  await step('terrain-points.ply: 160,000 points drawn as a point cloud', async () => {
    await open('terrain-points.ply'); const p = await loaded();
    await shot('terrain-points-ply');
    if (p.stats.pointCount !== 160000 || p.coverage < 0.03) throw new Error(JSON.stringify(p.stats));
    return { points: await stat('Points'), size: await stat('Size'), coverage: +p.coverage.toFixed(3) };
  });
  await step('vase.ply: mesh with vertex colours', async () => {
    await open('vase.ply'); const p = await loaded();
    if (p.stats.triangles !== 5120 || !p.stats.hasColors) throw new Error(JSON.stringify(p.stats));
    return { triangles: await stat('Triangles') };
  });
  await step('bracket.3mf: 2 objects in millimetres', async () => {
    await open('bracket.3mf'); const p = await loaded();
    const size = await stat('Size');
    await shot('bracket-3mf');
    if (p.stats.meshes < 2 || !/mm$/.test(size || '')) throw new Error(JSON.stringify({ stats: p.stats, size }));
    return { meshes: p.stats.meshes, materials: p.stats.materials, size };
  });
  await step('Copy puts the stats on the clipboard as TSV', async () => {
    await vs.wvClick(wv, `document.querySelector('.side button.link')`); await sleep(600);
    const clip = execSync('pbpaste', { encoding: 'utf8' });
    if (!/^Format\t3MF$/m.test(clip) || !/^Triangles\t/m.test(clip)) throw new Error(clip.slice(0, 200));
    return clip.split('\n').length + ' lines';
  });
  await step('Screenshot through the save dialog writes a PNG', async () => {
    const target = path.join(work, 'screenshot-check.png'); fs.rmSync(target, { force: true });
    await vs.wvClick(wv, btn('Screenshot')); await sleep(1500);
    const ib = JSON.parse(await vs.wbEval(`JSON.stringify(document.querySelector('.quick-input-widget input').getBoundingClientRect())`));
    await vs.click(ib.x + ib.width / 2, ib.y + ib.height / 2); await vs.key('a', 'KeyA', 4, 65); await vs.type(target);
    await sleep(300); await vs.key('Enter', 'Enter'); await sleep(1500);
    const ok = await vs.waitFor(() => fs.existsSync(target) && fs.statSync(target).size > 1000, 8000);
    if (!ok) { await shot('screenshot-dialog'); await vs.key('Escape', 'Escape'); throw new Error('no file'); }
    const head = fs.readFileSync(target).subarray(0, 24);
    return { bytes: fs.statSync(target).size, width: head.readUInt32BE(16), height: head.readUInt32BE(20), status: await text('.hint') };
  });
  await step('light background', async () => {
    await open('robot-arm.glb'); await loaded();
    await select('select[aria-label="Background"]', 'light'); await sleep(800);
    const p = await probe();
    await shot('robot-arm-light-background');
    await select('select[aria-label="Background"]', 'theme');
    if (p.background !== 'light' || p.coverage < 0.03) throw new Error(JSON.stringify(p));
    return { background: p.background, coverage: +p.coverage.toFixed(3) };
  });
  await step('over 1 GB (sparse file): clear message, nothing read', async () => {
    await open('huge-scan.stl');
    const t = await vs.waitFor(() => E(`!document.querySelector('.notice').hidden && document.querySelector('.notice').textContent`), 10000);
    await shot('over-1gb-message');
    if (!/1\.1 GB.*up to 1\.0 GB/.test(t)) throw new Error(t);
    return { notice: t };
  });
  await step('broken GLB shows a plain error', async () => {
    await open('broken.glb');
    const t = await vs.waitFor(() => E(`!document.querySelector('.notice').hidden && /not a GLB|version|cut off/.test(document.querySelector('.notice').textContent) && document.querySelector('.notice').textContent`), 10000);
    if (!t) throw new Error(await text('.notice'));
    return t;
  });
} finally {
  R.console = vs.console.filter(c => !/copilot|CloudSandboxApi|LESS API|reading 'selection'/i.test(c.text));
  R.logErrors = [];
  for (const f of vs.extHostLogs()) { const t = fs.readFileSync(f, 'utf8'); for (const l of t.split('\n')) if (/\[error\]/.test(l) && /model|3d-model|zovo/i.test(l)) R.logErrors.push(l.slice(0, 300)); }
  await vs.close();
  if (clipBefore !== null) try { execSync('pbcopy', { input: clipBefore }); } catch {}
  R.unchanged = Object.entries(R.hashes).every(([f, h]) => hash(path.join(ws, f)) === h);
  R.shots = shots;
  fs.writeFileSync(outJson, JSON.stringify(R, null, 1));
  console.log(JSON.stringify({ steps: R.steps.map(s => [s.ok ? 'PASS' : 'FAIL', s.name, s.error || '']), console: R.console, logErrors: R.logErrors, unchanged: R.unchanged, install: R.install.code }, null, 1));
}
