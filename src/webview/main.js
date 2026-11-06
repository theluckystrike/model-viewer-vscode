// Webview: three.js viewer for GLB, glTF, STL, OBJ (+MTL), PLY and 3MF. All DOM text goes in with textContent.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { VertexNormalsHelper } from 'three/addons/helpers/VertexNormalsHelper.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import P from '../core/protocol.js';
import S from '../core/stats.js';

const vscode = acquireVsCodeApi();
const MAX_NORMALS = 250000; // vertex normals drawn for models up to this many vertices
const MAX_TREE = 3000;
const BACKGROUNDS = { dark: 0x1e1f22, light: 0xf2f2f2 };

// ---------- tiny DOM helper (text only, never HTML) ----------
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat()) if (c != null) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}

// ---------- layout ----------
const app = document.getElementById('app');
app.textContent = '';
const ui = {};
const btn = (label, title, on, extra = {}) => h('button', { type: 'button', title, onclick: on, ...extra, text: label });
const toggle = (label, title, key) => {
  const b = btn(label, title, () => setToggle(key, !state[key]), { 'aria-pressed': 'false', 'data-toggle': key });
  ui['t_' + key] = b;
  return b;
};
ui.fit = btn('Fit', 'Fit the model in view (F)', () => fitView());
ui.shading = h('select', { 'aria-label': 'Shading', title: 'Shading' },
  h('option', { value: 'file', text: 'Shading: as stored' }), h('option', { value: 'smooth', text: 'Shading: smooth' }), h('option', { value: 'flat', text: 'Shading: flat' }));
ui.bg = h('select', { 'aria-label': 'Background', title: 'Background' },
  h('option', { value: 'theme', text: 'Background: theme' }), h('option', { value: 'dark', text: 'Background: dark' }), h('option', { value: 'light', text: 'Background: light' }));
ui.up = h('select', { 'aria-label': 'Up axis', title: 'Which model axis points up' },
  h('option', { value: 'y', text: 'Y up' }), h('option', { value: 'z', text: 'Z up' }));
ui.measure = btn('Measure', 'Click two points on the model to measure the distance (M)', () => setMeasure(!state.measure), { 'aria-pressed': 'false' });
ui.shot = btn('Screenshot', 'Save the view as a PNG image', () => screenshot());
ui.panelBtn = btn('Panel', 'Show or hide the stats and scene panel (P)', () => { ui.side.hidden = !ui.side.hidden; ui.panelBtn.setAttribute('aria-pressed', String(!ui.side.hidden)); resize(); }, { 'aria-pressed': 'true' });
ui.toolbar = h('div', { class: 'toolbar', role: 'toolbar' },
  ui.fit, h('span', { class: 'sep' }),
  toggle('Grid', 'Ground grid (G)', 'grid'), toggle('Axes', 'Model axes: X red, Y green, Z blue (A)', 'axes'),
  toggle('Wireframe', 'Wireframe (W)', 'wireframe'), toggle('Normals', 'Vertex normals (N)', 'normals'), toggle('Bounds', 'Bounding box (B)', 'bounds'),
  h('span', { class: 'sep' }), ui.shading, ui.bg, ui.up, h('span', { class: 'sep' }), ui.measure, ui.shot, h('span', { class: 'grow' }), ui.panelBtn);

ui.clip = h('select', { 'aria-label': 'Animation clip', title: 'Animation clip' });
ui.play = btn('Pause', 'Play or pause the animation (Space)', () => setPlaying(!state.playing));
ui.time = h('input', { type: 'range', min: '0', max: '1', step: '0.001', value: '0', 'aria-label': 'Animation time' });
ui.timeText = h('span', { class: 'timetext', text: '0.00 s' });
ui.anim = h('div', { class: 'animbar', hidden: true }, h('span', { class: 'label', text: 'Animation' }), ui.clip, ui.play, ui.time, ui.timeText);

ui.stage = h('div', { class: 'stage' });
ui.notice = h('div', { class: 'notice', hidden: true });
ui.label = h('div', { class: 'measure-label', hidden: true });
ui.stage.append(ui.notice, ui.label);
ui.stats = h('div', { class: 'stats' });
ui.tree = h('div', { class: 'tree', role: 'tree', 'aria-label': 'Scene tree' });
ui.copy = h('button', { type: 'button', class: 'link', title: 'Copy the stats as tab-separated text', text: 'Copy', onclick: () => copyStats() });
ui.side = h('aside', { class: 'side' },
  h('section', {}, h('h2', {}, 'Model ', ui.copy), ui.stats),
  h('section', {}, h('h2', { text: 'Scene' }), ui.tree));
ui.status = h('div', { class: 'status' }, ui.hint = h('span', { class: 'hint' }), h('span', { class: 'grow' }), ui.timing = h('span', { class: 'timing' }));
app.append(ui.toolbar, ui.anim, h('div', { class: 'main' }, ui.stage, ui.side), ui.status);
// The Sponsor and More free viewers line from the host HTML (absent when modelViewer.showSupportLinks is off).
const supportLine = document.getElementById('zovo-support');
if (supportLine) { supportLine.classList.remove('zovo-support-fixed'); ui.status.append(supportLine); }

const state = { grid: true, axes: false, wireframe: false, normals: false, bounds: false, measure: false, playing: true, loaded: false };
let init = null;

function setHint(t) { ui.hint.textContent = t || ''; }
function showNotice(text, kind) {
  ui.notice.hidden = !text;
  ui.notice.textContent = text || '';
  ui.notice.className = 'notice' + (kind ? ' ' + kind : '');
}
function setControlsEnabled(on) {
  for (const el of ui.toolbar.querySelectorAll('button, select')) if (el !== ui.panelBtn) el.disabled = !on;
}
setControlsEnabled(false);

// ---------- three.js setup ----------
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false });
} catch (e) {
  showNotice('WebGL is not available in this VS Code window, so the model cannot be drawn. ' + (e && e.message ? e.message : ''), 'error');
  throw e;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.toneMapping = THREE.NeutralToneMapping;
ui.stage.prepend(renderer.domElement);
renderer.domElement.setAttribute('aria-label', '3D view');
renderer.domElement.addEventListener('webglcontextlost', ev => { ev.preventDefault(); showNotice('The graphics context was lost (the GPU may be busy or out of memory). Close and reopen the file.', 'error'); });

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.screenSpacePanning = true;
controls.addEventListener('change', () => invalidate());

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.7;
scene.add(new THREE.HemisphereLight(0xffffff, 0x444450, 1.2));
const headlight = new THREE.DirectionalLight(0xffffff, 1.6);
headlight.position.set(0.5, 1, 1);
camera.add(headlight);
scene.add(camera);

const root = new THREE.Group(); // up-axis rotation lives here
root.name = 'root';
scene.add(root);
const helpers = new THREE.Group();
helpers.userData.helper = true;
scene.add(helpers);
let model = null, mixer = null, clips = [], action = null, gridHelper = null, axesHelper = null, boxHelper = null, normalsGroup = null;
let radius = 1, unit = 'units', fmt = null, stats = null, box = new THREE.Box3();
const measureGroup = new THREE.Group();
measureGroup.userData.helper = true;
measureGroup.renderOrder = 999;
scene.add(measureGroup);
let measurePts = [];
let dirty = true;
let lastTs = 0; // own frame timer (THREE.Clock is deprecated)
function invalidate() { dirty = true; }

function resize() {
  const r = ui.stage.getBoundingClientRect();
  const w = Math.max(1, Math.floor(r.width)), hgt = Math.max(1, Math.floor(r.height));
  renderer.setSize(w, hgt, false);
  renderer.domElement.style.width = w + 'px';
  renderer.domElement.style.height = hgt + 'px';
  camera.aspect = w / hgt;
  camera.updateProjectionMatrix();
  invalidate();
}
new ResizeObserver(resize).observe(ui.stage);

let firstFrame = true;
function frame(ts) {
  requestAnimationFrame(frame);
  const dt = lastTs ? Math.min((ts - lastTs) / 1000, 0.1) : 0;
  lastTs = ts;
  const moved = controls.update();
  if (mixer && state.playing && action) {
    mixer.update(dt);
    syncTime();
    if (normalsGroup && normalsGroup.visible) normalsGroup.children.forEach(n => n.update());
    if (boxHelper) boxHelper.box.copy(visibleBox(root)); // the box follows the animated pose
    dirty = true;
  }
  if (!dirty && !moved) return;
  dirty = false;
  renderer.render(scene, camera);
  placeLabel();
  if (firstFrame && state.loaded) { firstFrame = false; vscode.postMessage({ type: 'rendered' }); }
}

// ---------- background ----------
function themeColor() {
  const v = getComputedStyle(document.body).getPropertyValue('--vscode-editor-background').trim();
  try { return new THREE.Color(v || '#1e1e1e'); } catch { return new THREE.Color(0x1e1e1e); }
}
function applyBackground() {
  const mode = ui.bg.value;
  const c = mode === 'theme' ? themeColor() : new THREE.Color(BACKGROUNDS[mode]);
  scene.background = c;
  const light = c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722 > 0.5;
  document.body.dataset.bg = light ? 'light' : 'dark';
  if (gridHelper) {
    const [a, b] = light ? [0x9a9a9a, 0xcfcfcf] : [0x5a5a5a, 0x353535];
    const col = gridHelper.geometry.attributes.color;
    const ca = new THREE.Color(a), cb = new THREE.Color(b);
    for (let i = 0; i < col.count; i++) { const isCenter = gridHelper.userData.center.has(i); const cc = isCenter ? ca : cb; col.setXYZ(i, cc.r, cc.g, cc.b); }
    col.needsUpdate = true;
  }
  invalidate();
}
ui.bg.addEventListener('change', applyBackground);
new MutationObserver(() => { if (ui.bg.value === 'theme') applyBackground(); }).observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });

// ---------- loading ----------
window.addEventListener('message', ev => {
  const m = ev.data;
  if (!m || typeof m !== 'object') return;
  if (m.type === 'init') start(m);
  else if (m.type === 'bytes') { if (pendingBytes) pendingBytes(m.data); }
  else if (m.type === 'saved') setHint(m.cancelled ? 'Screenshot not saved.' : `Screenshot saved: ${m.path} (${P.fmtSize(m.bytes)})`);
  else if (m.type === 'copied') setHint('Stats copied to the clipboard.');
  else if (m.type === 'error') { if (m.soft) setHint(m.message); else showNotice(m.message, 'error'); }
});
let pendingBytes = null;

async function readFile(src, size) {
  try {
    const r = await fetch(src);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    if (!r.body || !r.body.getReader) return new Uint8Array(await r.arrayBuffer());
    const reader = r.body.getReader();
    const out = new Uint8Array(size || 0);
    let n = 0, parts = null, last = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (parts || n + value.length > out.length) { parts = parts || [out.subarray(0, n)]; parts.push(value); }
      else out.set(value, n);
      n += value.length;
      if (Date.now() - last > 150) { last = Date.now(); showNotice(`Reading ${P.fmtSize(n)} of ${P.fmtSize(size)}...`, 'info'); }
    }
    if (!parts) return n === out.length ? out : out.subarray(0, n);
    const all = new Uint8Array(n); let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
    return all;
  } catch {
    // remote or virtual files: ask the extension host for the bytes
    return new Promise(res => { pendingBytes = d => { pendingBytes = null; res(d instanceof Uint8Array ? d : new Uint8Array(d)); }; vscode.postMessage({ type: 'needBytes' }); });
  }
}

const baseOf = src => src.slice(0, src.lastIndexOf('/') + 1);
const buf = u8 => (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength ? u8.buffer : u8.slice().buffer);

function defaultMaterial(geo) {
  return new THREE.MeshStandardMaterial({ color: geo.attributes.color ? 0xffffff : 0xb4bcc8, metalness: 0.05, roughness: 0.55, vertexColors: !!geo.attributes.color, side: THREE.DoubleSide });
}

function friendlyGltfError(e, bytes) {
  const msg = String(e && e.message ? e.message : e);
  let required = [];
  try {
    let json;
    if (P.sniff(bytes, 'glb').detail === 'binary') {
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const len = dv.getUint32(12, true);
      json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + len)));
    } else json = JSON.parse(new TextDecoder().decode(bytes));
    required = json.extensionsRequired || [];
  } catch {}
  const names = { KHR_draco_mesh_compression: 'Draco mesh compression', EXT_meshopt_compression: 'meshopt compression', KHR_meshopt_compression: 'meshopt compression', KHR_texture_basisu: 'KTX2/Basis textures' };
  const hit = required.filter(r => names[r]);
  if (hit.length) return `This glTF needs ${hit.map(r => names[r]).join(' and ')}, which 3D Model Viewer does not decode yet. Export it without compression to view it here.`;
  if (/Failed to load buffer|Failed to fetch|404/.test(msg)) return 'A buffer or texture that this glTF file points to was not found next to it. ' + msg;
  return 'The glTF file could not be read: ' + msg;
}

async function parse(bytes, src) {
  const base = baseOf(src);
  const notes = [];
  const sn = P.sniff(bytes, fmt === 'gltf' ? 'gltf' : fmt);
  if (!sn.ok) throw new Error(sn.reason);
  if (sn.warning) notes.push(sn.warning);
  if (fmt === 'glb' || fmt === 'gltf') {
    const manager = new THREE.LoadingManager();
    manager.onError = url => notes.push(`Could not load ${decodeURIComponent(url.split('/').pop().slice(0, 120))}.`);
    const loader = new GLTFLoader(manager);
    try {
      const g = await loader.parseAsync(buf(bytes), base);
      const object = g.scene || g.scenes[0];
      if (!object.name) object.name = init.name;
      return { object, animations: g.animations || [], notes };
    } catch (e) { throw new Error(friendlyGltfError(e, bytes)); }
  }
  if (fmt === 'stl') {
    const geo = new STLLoader().parse(buf(bytes));
    geo.userData.faceted = true;
    const mesh = new THREE.Mesh(geo, defaultMaterial(geo));
    mesh.name = init.name;
    return { object: mesh, animations: [], notes };
  }
  if (fmt === 'ply') {
    const geo = new PLYLoader().parse(buf(bytes));
    let obj;
    if (geo.index && geo.index.count > 0) {
      if (!geo.attributes.normal) geo.computeVertexNormals();
      obj = new THREE.Mesh(geo, defaultMaterial(geo));
    } else {
      geo.computeBoundingSphere();
      const r = geo.boundingSphere ? geo.boundingSphere.radius : 1;
      obj = new THREE.Points(geo, new THREE.PointsMaterial({ size: Math.max(r / 300, 1e-6), sizeAttenuation: true, vertexColors: !!geo.attributes.color, color: geo.attributes.color ? 0xffffff : 0x7fb3ff }));
    }
    obj.name = init.name;
    return { object: obj, animations: [], notes };
  }
  if (fmt === 'obj') {
    const text = new TextDecoder().decode(bytes);
    const loader = new OBJLoader();
    const libs = P.mtlLibs(text.slice(0, 2e6));
    for (const lib of libs.slice(0, 1)) {
      try {
        const r = await fetch(base + lib.split('/').map(encodeURIComponent).join('/'));
        if (!r.ok) throw new Error();
        const mtl = new MTLLoader().setResourcePath(base).parse(await r.text(), base);
        mtl.side = THREE.DoubleSide;
        mtl.preload();
        loader.setMaterials(mtl);
        notes.push(`Materials from ${lib}.`);
      } catch { notes.push(`The material file ${lib} was not found next to the model, so a default material is used.`); }
    }
    const obj = loader.parse(text);
    obj.name = obj.name || init.name;
    obj.traverse(o => { if (o.isMesh && o.geometry && !o.geometry.index) o.geometry.userData.faceted = true; });
    return { object: obj, animations: [], notes };
  }
  if (fmt === '3mf') {
    let obj;
    try { obj = new ThreeMFLoader().parse(buf(bytes)); } catch (e) { throw new Error('The 3MF package could not be read: ' + (e && e.message ? e.message : e)); }
    if (!obj) throw new Error('The 3MF package has no 3D model part.');
    obj.name = obj.name || init.name;
    return { object: obj, animations: [], notes };
  }
  throw new Error('Unknown file type.');
}

async function start(m) {
  init = m;
  fmt = m.format;
  unit = P.UNITS[fmt] || 'units';
  ui.bg.value = ['theme', 'dark', 'light'].includes(m.background) ? m.background : 'theme';
  applyBackground();
  ui.up.value = m.upAxis === 'y' || m.upAxis === 'z' ? m.upAxis : (fmt === 'stl' || fmt === '3mf' ? 'z' : 'y');
  ui.timing.textContent = `${m.name} · ${m.sizeText}`;
  if (!m.plan.load) { showNotice(m.plan.message, 'big'); renderStats(); return; }
  const t0 = performance.now();
  try {
    showNotice(`Reading ${m.sizeText}...`, 'info');
    const bytes = await readFile(m.src, m.size);
    const t1 = performance.now();
    showNotice(`Building the model (${P.fmtSize(bytes.length)})...`, 'info');
    await new Promise(r => setTimeout(r, 0));
    const res = await parse(bytes, m.src);
    model = res.object;
    clips = res.animations;
    root.add(model);
    applyUp();
    stats = S.sceneStats(model, clips);
    if (!stats.meshes && !stats.pointClouds) throw new Error('The file was read but has no meshes or points to draw.');
    fitView();
    buildGrid();
    buildTree();
    setupAnimations();
    renderStats();
    showNotice('');
    setControlsEnabled(true);
    syncToggles();
    state.loaded = true;
    const t2 = performance.now();
    ui.timing.textContent = `${m.name} · ${m.sizeText} · read ${((t1 - t0) / 1000).toFixed(2)} s, built ${((t2 - t1) / 1000).toFixed(2)} s`;
    setHint(res.notes.join(' ') || 'Drag to orbit, right-drag or Shift-drag to pan, scroll to zoom.');
    invalidate();
  } catch (e) {
    showNotice(e && e.message ? e.message : String(e), 'error');
    ui.timing.textContent = `${m.name} · ${m.sizeText}`;
  }
}

// ---------- view ----------
function applyUp() {
  root.rotation.set(ui.up.value === 'z' ? -Math.PI / 2 : 0, 0, 0);
  root.updateMatrixWorld(true);
}
ui.up.addEventListener('change', () => { applyUp(); clearMeasure(); fitView(); buildGrid(); refreshBounds(); invalidate(); });

function visibleBox(obj) {
  const b = new THREE.Box3();
  obj.updateMatrixWorld(true);
  obj.traverseVisible(o => { if ((o.isMesh || o.isPoints) && o.geometry) b.expandByObject(o, false); });
  return b;
}

function fitView(target) {
  const b = visibleBox(target || root);
  if (b.isEmpty()) return;
  if (!target) box = b.clone();
  const center = b.getCenter(new THREE.Vector3());
  const size = b.getSize(new THREE.Vector3());
  const r = Math.max(size.length() / 2, 1e-6);
  if (!target) radius = r;
  const dist = r / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.05;
  const dir = new THREE.Vector3(0.9, 0.65, 1.2).normalize();
  camera.position.copy(center).addScaledVector(dir, dist);
  camera.near = Math.max(r / 500, dist / 10000);
  camera.far = dist + r * 50;
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.maxDistance = dist * 20;
  controls.update();
  invalidate();
}

function niceStep(x) {
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  const f = x / p;
  return (f < 2 ? 1 : f < 5 ? 2 : 5) * p;
}

function buildGrid() {
  if (gridHelper) { helpers.remove(gridHelper); gridHelper.geometry.dispose(); }
  const size = box.getSize(new THREE.Vector3());
  const span = Math.max(size.x, size.z, 1e-6);
  const cell = niceStep(span / 8);
  const n = 2 * Math.ceil(span * 1.5 / cell / 2) + 2;
  gridHelper = new THREE.GridHelper(n * cell, n);
  const c = box.getCenter(new THREE.Vector3());
  gridHelper.position.set(Math.round(c.x / cell) * cell, box.min.y, Math.round(c.z / cell) * cell);
  gridHelper.userData.cell = cell;
  // remember which vertices belong to the two centre lines so the colours can follow the background
  const center = new Set();
  const pos = gridHelper.geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) if (Math.abs(pos.getX(i)) < 1e-9 && Math.abs(pos.getX(i ^ 1)) < 1e-9 || Math.abs(pos.getZ(i)) < 1e-9 && Math.abs(pos.getZ(i ^ 1)) < 1e-9) center.add(i);
  gridHelper.userData.center = center;
  gridHelper.visible = state.grid;
  helpers.add(gridHelper);
  if (axesHelper) { root.remove(axesHelper); axesHelper.dispose(); }
  axesHelper = new THREE.AxesHelper(radius * 0.6);
  axesHelper.userData.helper = true;
  axesHelper.material.depthTest = false;
  axesHelper.renderOrder = 998;
  axesHelper.visible = state.axes;
  root.add(axesHelper);
  applyBackground();
  renderStats();
}

function refreshBounds() {
  if (boxHelper) { helpers.remove(boxHelper); boxHelper.geometry.dispose(); boxHelper = null; }
  if (!state.bounds || !model) return;
  const b = visibleBox(root);
  if (b.isEmpty()) return;
  boxHelper = new THREE.Box3Helper(b, 0xffb000);
  helpers.add(boxHelper);
  const local = modelBox();
  setHint(`Bounding box ${S.fmtDims(local.min, local.max, unit)}`);
}

/** Box in model coordinates (before the up-axis rotation), so X/Y/Z sizes match the file. */
function modelBox() {
  const b = new THREE.Box3();
  if (!model) return b;
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  model.updateMatrixWorld(true);
  model.traverseVisible(o => {
    if (!(o.isMesh || o.isPoints) || !o.geometry) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    const bb = o.geometry.boundingBox.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
    b.union(bb);
  });
  return b;
}

function eachMaterial(fn) {
  if (!model) return;
  model.traverse(o => { if (o.isMesh && o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => fn(m, o)); });
}

function setToggle(key, on) {
  state[key] = on;
  if (key === 'grid' && gridHelper) gridHelper.visible = on;
  if (key === 'axes' && axesHelper) axesHelper.visible = on;
  if (key === 'wireframe') eachMaterial(m => { m.wireframe = on; m.needsUpdate = true; });
  if (key === 'bounds') { refreshBounds(); if (!on) setHint(''); }
  if (key === 'normals') buildNormals();
  syncToggles();
  invalidate();
}
function syncToggles() {
  for (const k of ['grid', 'axes', 'wireframe', 'normals', 'bounds']) if (ui['t_' + k]) ui['t_' + k].setAttribute('aria-pressed', String(!!state[k]));
  ui.measure.setAttribute('aria-pressed', String(state.measure));
}

function buildNormals() {
  if (normalsGroup) { normalsGroup.children.forEach(n => n.dispose && n.dispose()); scene.remove(normalsGroup); normalsGroup = null; }
  if (!state.normals || !model) return;
  if (stats.vertices > MAX_NORMALS) {
    state.normals = false;
    setHint(`Normals are drawn for models up to ${S.fmtInt(MAX_NORMALS)} vertices. This one has ${S.fmtInt(stats.vertices)}.`);
    return;
  }
  normalsGroup = new THREE.Group();
  normalsGroup.userData.helper = true;
  model.traverseVisible(o => { if (o.isMesh && o.geometry && o.geometry.attributes.normal) normalsGroup.add(new VertexNormalsHelper(o, radius * 0.04, 0x33ccff)); });
  scene.add(normalsGroup);
  setHint(normalsGroup.children.length ? 'Vertex normals shown in cyan.' : 'This model has no vertex normals.');
}

// flat / smooth / as stored
ui.shading.addEventListener('change', () => {
  const mode = ui.shading.value;
  const t0 = performance.now();
  model.traverse(o => {
    if (!o.isMesh || !o.geometry) return;
    const ud = o.userData;
    if (!ud.fileGeometry) ud.fileGeometry = o.geometry;
    let g = ud.fileGeometry;
    if (mode === 'smooth' && g.userData.faceted && !o.isSkinnedMesh && !o.morphTargetInfluences) {
      if (!ud.smoothGeometry) {
        const c = g.clone();
        c.deleteAttribute('normal');
        for (const k of Object.keys(c.attributes)) if (k !== 'position' && k !== 'color') c.deleteAttribute(k);
        ud.smoothGeometry = mergeVertices(c, radius * 1e-6);
        ud.smoothGeometry.computeVertexNormals();
        c.dispose();
      }
      g = ud.smoothGeometry;
    }
    if (o.geometry !== g) o.geometry = g;
  });
  eachMaterial(m => { if ('flatShading' in m) { if (m.userData.fileFlat === undefined) m.userData.fileFlat = !!m.flatShading; m.flatShading = mode === 'flat' ? true : mode === 'smooth' ? false : m.userData.fileFlat; m.needsUpdate = true; } });
  if (state.normals) buildNormals();
  setHint(`Shading: ${mode === 'file' ? 'as stored in the file' : mode} (${Math.round(performance.now() - t0)} ms).`);
  invalidate();
});

// ---------- animations ----------
function setupAnimations() {
  if (!clips.length) { ui.anim.hidden = true; return; }
  mixer = new THREE.AnimationMixer(model);
  ui.clip.textContent = '';
  clips.forEach((c, i) => ui.clip.append(h('option', { value: String(i), text: `${c.name || 'Clip ' + (i + 1)} (${c.duration.toFixed(2)} s)` })));
  ui.anim.hidden = false;
  playClip(0);
  resize();
}
function playClip(i) {
  if (!mixer) return;
  mixer.stopAllAction();
  const clip = clips[i];
  action = mixer.clipAction(clip);
  action.reset().play();
  ui.time.max = String(Math.max(clip.duration, 0.001));
  setPlaying(true);
}
function setPlaying(on) {
  state.playing = on && !!action;
  if (action) action.paused = !state.playing;
  ui.play.textContent = state.playing ? 'Pause' : 'Play';
  invalidate();
}
function syncTime() {
  if (!action) return;
  const t = action.time % Math.max(action.getClip().duration, 0.001);
  ui.time.value = String(t);
  ui.timeText.textContent = `${t.toFixed(2)} s`;
}
ui.clip.addEventListener('change', () => playClip(Number(ui.clip.value)));
ui.time.addEventListener('input', () => {
  if (!action) return;
  setPlaying(false);
  action.paused = false;
  action.time = Number(ui.time.value);
  mixer.update(0);
  action.paused = true;
  syncTime();
  if (normalsGroup) normalsGroup.children.forEach(n => n.update());
  invalidate();
});

// ---------- stats panel ----------
function renderStats() {
  ui.stats.textContent = '';
  const rows = [];
  rows.push(['Format', { glb: 'glTF binary (GLB)', gltf: 'glTF', stl: 'STL', obj: 'Wavefront OBJ', ply: 'PLY', '3mf': '3MF' }[fmt] || '?']);
  if (init) rows.push(['File size', init.sizeText]);
  if (stats) {
    for (const [k, v] of S.statsRows(stats)) rows.push([k, v]);
    const lb = modelBox();
    if (!lb.isEmpty()) rows.push(['Size', S.fmtDims(lb.min, lb.max, unit)]);
    if (gridHelper) rows.push(['Grid cell', `${S.round(gridHelper.userData.cell)} ${unit}`]);
  }
  for (const [k, v] of rows) ui.stats.append(h('div', { class: 'row' }, h('span', { class: 'k', text: k }), h('span', { class: 'v', text: v })));
  ui.copy.disabled = !stats;
}
function copyStats() {
  const text = [...ui.stats.querySelectorAll('.row')].map(r => r.children[0].textContent + '\t' + r.children[1].textContent).join('\n');
  vscode.postMessage({ type: 'copy', text });
}

// ---------- scene tree ----------
function buildTree() {
  ui.tree.textContent = '';
  let count = 0, hidden = 0;
  const walk = (o, depth) => {
    if (o.userData.helper) return;
    if (count >= MAX_TREE) { hidden++; o.children.forEach(c => walk(c, depth + 1)); return; }
    count++;
    let kind = o.isSkinnedMesh ? 'skinned mesh' : o.isMesh ? 'mesh' : o.isPoints ? 'points' : o.isBone ? 'bone' : o.isLight ? 'light' : o.isCamera ? 'camera' : 'group';
    let meta = '';
    if ((o.isMesh || o.isPoints) && o.geometry && o.geometry.attributes.position) {
      meta = o.isPoints ? `${S.fmtInt(o.geometry.attributes.position.count)} pts` : `${S.fmtInt(S.triCount(o.geometry, o))} tris`;
    }
    const cb = h('input', { type: 'checkbox', 'aria-label': 'Visible' });
    cb.checked = o.visible;
    cb.addEventListener('change', () => { o.visible = cb.checked; refreshBounds(); if (state.normals) buildNormals(); invalidate(); });
    const name = h('button', { type: 'button', class: 'node-name', title: 'Frame this node', text: o.name || `(${kind})` });
    name.addEventListener('click', () => fitView(o));
    ui.tree.append(h('div', { class: 'node', role: 'treeitem', 'data-depth': depth },
      h('span', { class: 'indent', 'data-w': depth }), cb, name, h('span', { class: 'kind', text: meta || kind })));
    ui.tree.lastChild.firstChild.style.width = `${depth * 12}px`;
    o.children.forEach(c => walk(c, depth + 1));
  };
  walk(model, 0);
  if (hidden) ui.tree.append(h('div', { class: 'more', text: `and ${S.fmtInt(hidden)} more nodes (the first ${S.fmtInt(MAX_TREE)} are listed)` }));
}

// ---------- measure ----------
function setMeasure(on) {
  state.measure = on;
  ui.stage.classList.toggle('measuring', on);
  syncToggles();
  if (on) { clearMeasure(); setHint('Measure: click the first point on the model. Esc to stop.'); }
  else setHint('');
}
function clearMeasure() {
  for (const c of [...measureGroup.children]) { measureGroup.remove(c); c.geometry && c.geometry.dispose(); }
  measurePts = [];
  ui.label.hidden = true;
  invalidate();
}
const raycaster = new THREE.Raycaster();
function visibleChain(o) { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true; }
function pick(clientX, clientY) {
  const r = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  raycaster.params.Points.threshold = radius * 0.01;
  const hits = raycaster.intersectObject(model, true).filter(x => !x.object.userData.helper && visibleChain(x.object));
  return hits[0] || null;
}
function marker(p) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.012, 16, 12), new THREE.MeshBasicMaterial({ color: 0xff3d71, depthTest: false }));
  m.position.copy(p);
  m.renderOrder = 999;
  measureGroup.add(m);
}
function addMeasurePoint(hit) {
  if (measurePts.length === 2) clearMeasure();
  measurePts.push(hit.point.clone());
  marker(hit.point);
  if (measurePts.length === 2) {
    const [a, b] = measurePts;
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), new THREE.LineBasicMaterial({ color: 0xff3d71, depthTest: false }));
    line.renderOrder = 999;
    measureGroup.add(line);
    // distances in model coordinates (before the up-axis rotation)
    const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const la = a.clone().applyMatrix4(inv), lb = b.clone().applyMatrix4(inv);
    const text = S.fmtDistance(la, lb, unit);
    ui.label.textContent = `${S.round(S.distance(la, lb).d)} ${unit}`;
    ui.label.hidden = false;
    setHint(`Distance ${text}. Click again to start a new measurement.`);
  } else setHint('Measure: click the second point.');
  invalidate();
}
function placeLabel() {
  if (ui.label.hidden || measurePts.length < 2) return;
  const mid = measurePts[0].clone().add(measurePts[1]).multiplyScalar(0.5).project(camera);
  const r = renderer.domElement.getBoundingClientRect();
  ui.label.style.left = `${((mid.x + 1) / 2) * r.width}px`;
  ui.label.style.top = `${((1 - mid.y) / 2) * r.height}px`;
}
let down = null;
renderer.domElement.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY, b: e.button }; });
renderer.domElement.addEventListener('pointerup', e => {
  if (!down || !state.measure || !model || down.b !== 0) return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
  down = null;
  if (moved > 4) return;
  const hit = pick(e.clientX, e.clientY);
  if (hit) addMeasurePoint(hit); else setHint('No surface under the pointer. Click on the model.');
});

// ---------- screenshot ----------
function screenshot() {
  renderer.render(scene, camera);
  const url = renderer.domElement.toDataURL('image/png');
  const bin = atob(url.slice(url.indexOf(',') + 1));
  const data = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
  vscode.postMessage({ type: 'screenshot', data });
  setHint('Choose where to save the PNG...');
}

// ---------- keys ----------
window.addEventListener('keydown', e => {
  if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) && e.target.type !== 'checkbox' && e.target.type !== 'range') return;
  if (e.metaKey || e.ctrlKey || e.altKey || !state.loaded) return;
  const k = e.key.toLowerCase();
  const map = { g: 'grid', a: 'axes', w: 'wireframe', n: 'normals', b: 'bounds' };
  if (map[k]) { setToggle(map[k], !state[map[k]]); e.preventDefault(); }
  else if (k === 'f') { fitView(); e.preventDefault(); }
  else if (k === 'm') { setMeasure(!state.measure); e.preventDefault(); }
  else if (k === 'p') { ui.panelBtn.click(); e.preventDefault(); }
  else if (k === 'escape' && state.measure) { setMeasure(false); clearMeasure(); }
  else if (k === ' ' && action) { setPlaying(!state.playing); e.preventDefault(); }
});

// ---------- self-check (read-only): share of drawn pixels that differ from the background ----------
function coverage() {
  renderer.render(scene, camera);
  const gl = renderer.getContext();
  const w = gl.drawingBufferWidth, hh = gl.drawingBufferHeight;
  const px = new Uint8Array(w * hh * 4);
  gl.readPixels(0, 0, w, hh, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const bg = scene.background || new THREE.Color(0, 0, 0);
  const hex = bg.getHex(); // sRGB, like the drawn pixels
  let hit = 0, n = 0;
  const br = (hex >> 16) & 255, bgc = (hex >> 8) & 255, bb = hex & 255;
  for (let y = 0; y < hh; y += 4) for (let x = 0; x < w; x += 4) {
    const i = (y * w + x) * 4; n++;
    if (Math.abs(px[i] - br) + Math.abs(px[i + 1] - bgc) + Math.abs(px[i + 2] - bb) > 30) hit++;
  }
  return n ? hit / n : 0;
}
window.modelViewerProbe = () => ({
  loaded: state.loaded, coverage: state.loaded ? coverage() : 0, state: { ...state }, stats, unit,
  cameraDistance: camera.position.distanceTo(controls.target), radius,
  clip: action ? action.getClip().name : null, time: action ? action.time : null,
  shading: ui.shading.value, background: ui.bg.value, up: ui.up.value,
});

resize();
requestAnimationFrame(frame);
vscode.postMessage({ type: 'ready' });
