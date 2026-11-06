// Writes procedural sample models (each under 5 MB) for the README, the walkthrough and the release check.
// usage: node scripts/make-samples.mjs <outDir>
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const out = path.resolve(process.argv[2] || 'samples');
fs.mkdirSync(out, { recursive: true });
const written = [];
const save = (name, data) => { fs.writeFileSync(path.join(out, name), data); written.push([name, fs.statSync(path.join(out, name)).size]); };

// ---------- CRC32, PNG, ZIP ----------
const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
export function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1); }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
export function zipStore(files) { // [{name, data}] stored (no compression)
  const parts = [], central = []; let off = 0;
  for (const f of files) {
    const name = Buffer.from(f.name); const data = Buffer.from(f.data); const crc = crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
    parts.push(lh, name, data);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    central.push(ch, name);
    off += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}

// ---------- glTF writer ----------
function gltfBuilder() {
  const chunks = []; let len = 0;
  const json = { asset: { version: '2.0', generator: '3d-model-viewer make-samples' }, scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [], materials: [], accessors: [], bufferViews: [], buffers: [] };
  const view = (typed, target) => {
    const b = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
    const pad = (4 - (len % 4)) % 4; if (pad) { chunks.push(Buffer.alloc(pad)); len += pad; }
    json.bufferViews.push({ buffer: 0, byteOffset: len, byteLength: b.length, ...(target ? { target } : {}) });
    chunks.push(b); len += b.length;
    return json.bufferViews.length - 1;
  };
  const accessor = (typed, type, target, minmax) => {
    const comp = typed instanceof Float32Array ? 5126 : typed instanceof Uint32Array ? 5125 : 5123;
    const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[type];
    const a = { bufferView: view(typed, target), componentType: comp, count: typed.length / n, type };
    if (minmax) { const mn = Array(n).fill(Infinity), mx = Array(n).fill(-Infinity); for (let i = 0; i < typed.length; i++) { mn[i % n] = Math.min(mn[i % n], typed[i]); mx[i % n] = Math.max(mx[i % n], typed[i]); } a.min = mn; a.max = mx; }
    json.accessors.push(a); return json.accessors.length - 1;
  };
  return {
    json,
    material(m) { json.materials.push(m); return json.materials.length - 1; },
    mesh(name, geo, material) {
      const g = geo.index ? geo : geo;
      const attributes = { POSITION: accessor(new Float32Array(g.attributes.position.array), 'VEC3', 34962, true), NORMAL: accessor(new Float32Array(g.attributes.normal.array), 'VEC3', 34962) };
      if (g.attributes.uv && json.textures) attributes.TEXCOORD_0 = accessor(new Float32Array(g.attributes.uv.array), 'VEC2', 34962);
      const prim = { attributes, material };
      if (g.index) prim.indices = accessor(g.index.array instanceof Uint32Array ? new Uint32Array(g.index.array) : new Uint16Array(g.index.array), 'SCALAR', 34963);
      json.meshes.push({ name, primitives: [prim] }); return json.meshes.length - 1;
    },
    node(n, parent) { json.nodes.push(n); const i = json.nodes.length - 1; if (parent == null) json.scenes[0].nodes.push(i); else (json.nodes[parent].children ||= []).push(i); return i; },
    animation(name, channels) {
      const a = { name, channels: [], samplers: [] };
      for (const c of channels) {
        const input = accessor(new Float32Array(c.times), 'SCALAR', undefined, true);
        const output = accessor(new Float32Array(c.values), c.path === 'rotation' ? 'VEC4' : 'VEC3');
        a.samplers.push({ input, output, interpolation: 'LINEAR' });
        a.channels.push({ sampler: a.samplers.length - 1, target: { node: c.node, path: c.path } });
      }
      (json.animations ||= []).push(a);
    },
    bin() { const pad = (4 - (len % 4)) % 4; return Buffer.concat([...chunks, Buffer.alloc(pad)]); },
  };
}
function glb(json, bin) {
  let js = Buffer.from(JSON.stringify(json)); js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
  const head = Buffer.alloc(12); head.write('glTF', 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + js.length + 8 + bin.length, 8);
  const c0 = Buffer.alloc(8); c0.writeUInt32LE(js.length, 0); c0.writeUInt32LE(0x4e4f534a, 4);
  const c1 = Buffer.alloc(8); c1.writeUInt32LE(bin.length, 0); c1.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([head, c0, js, c1, bin]);
}
const q = (axis, deg) => new THREE.Quaternion().setFromAxisAngle(axis, THREE.MathUtils.degToRad(deg)).toArray();
const Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);

// ---------- 1. robot-arm.glb: node tree, 4 materials, 3 animation clips ----------
{
  const b = gltfBuilder();
  const pbr = (name, c, metal, rough) => b.material({ name, pbrMetallicRoughness: { baseColorFactor: [...c, 1], metallicFactor: metal, roughnessFactor: rough } });
  const steel = pbr('Brushed steel', [0.62, 0.64, 0.68], 0.9, 0.35), orange = pbr('Safety orange', [0.95, 0.38, 0.05], 0.1, 0.45), dark = pbr('Dark rubber', [0.08, 0.08, 0.09], 0, 0.9), blue = pbr('Sensor blue', [0.1, 0.45, 0.95], 0.2, 0.2);
  const base = b.node({ name: 'Base', mesh: b.mesh('BaseMesh', new THREE.CylinderGeometry(0.35, 0.42, 0.18, 48), dark), translation: [0, 0.09, 0] });
  const turn = b.node({ name: 'Turntable', mesh: b.mesh('TurntableMesh', new THREE.CylinderGeometry(0.26, 0.28, 0.12, 48), steel), translation: [0, 0.15, 0] }, base);
  const shoulder = b.node({ name: 'Shoulder', mesh: b.mesh('ShoulderMesh', new THREE.SphereGeometry(0.13, 32, 16), steel), translation: [0, 0.12, 0] }, turn);
  const lower = b.node({ name: 'LowerArm', mesh: b.mesh('LowerArmMesh', new THREE.BoxGeometry(0.14, 0.7, 0.14).translate(0, 0.35, 0), orange), rotation: q(Z, -18) }, shoulder);
  const elbow = b.node({ name: 'Elbow', mesh: b.mesh('ElbowMesh', new THREE.CylinderGeometry(0.1, 0.1, 0.2, 32).rotateX(Math.PI / 2), steel), translation: [0, 0.7, 0], rotation: q(Z, 60) }, lower);
  const upper = b.node({ name: 'UpperArm', mesh: b.mesh('UpperArmMesh', new THREE.BoxGeometry(0.11, 0.55, 0.11).translate(0, 0.275, 0), orange) }, elbow);
  const wrist = b.node({ name: 'Wrist', mesh: b.mesh('WristMesh', new THREE.CylinderGeometry(0.07, 0.07, 0.08, 24), steel), translation: [0, 0.59, 0] }, upper);
  b.node({ name: 'Camera', mesh: b.mesh('CameraMesh', new THREE.SphereGeometry(0.035, 16, 8), blue), translation: [0.07, 0.02, 0.05] }, wrist);
  const fl = b.node({ name: 'FingerLeft', mesh: b.mesh('FingerMesh', new THREE.BoxGeometry(0.03, 0.14, 0.06).translate(0, 0.07, 0), dark), translation: [-0.05, 0.04, 0] }, wrist);
  const fr = b.node({ name: 'FingerRight', mesh: b.mesh('FingerMeshR', new THREE.BoxGeometry(0.03, 0.14, 0.06).translate(0, 0.07, 0), dark), translation: [0.05, 0.04, 0] }, wrist);
  const T = [0, 1, 2, 3, 4];
  b.animation('Wave', [{ node: elbow, path: 'rotation', times: T, values: [60, 25, 60, 95, 60].flatMap(d => q(Z, d)) }, { node: lower, path: 'rotation', times: T, values: [-18, -8, -18, -28, -18].flatMap(d => q(Z, d)) }]);
  b.animation('Spin', [{ node: turn, path: 'rotation', times: [0, 1.5, 3, 4.5, 6], values: [0, 90, 180, 270, 360].flatMap(d => q(Y, d)) }]);
  b.animation('Grip', [{ node: fl, path: 'translation', times: [0, 0.6, 1.2], values: [-0.05, 0.04, 0, -0.018, 0.04, 0, -0.05, 0.04, 0] }, { node: fr, path: 'translation', times: [0, 0.6, 1.2], values: [0.05, 0.04, 0, 0.018, 0.04, 0, 0.05, 0.04, 0] }]);
  const bin = b.bin(); b.json.buffers.push({ byteLength: bin.length });
  save('robot-arm.glb', glb(b.json, bin));
}

// ---------- 2. lantern.gltf + lantern.bin + lantern-wood.png (external files) ----------
{
  const b = gltfBuilder();
  const W = 128, H = 128, px = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const ring = Math.sin((x * 0.09 + Math.sin(y * 0.05) * 3) * 2.2) * 0.5 + 0.5;
    const i = (y * W + x) * 4; px[i] = 120 + ring * 70; px[i + 1] = 72 + ring * 45; px[i + 2] = 35 + ring * 20; px[i + 3] = 255;
  }
  b.json.images = [{ uri: 'lantern-wood.png', name: 'Wood' }];
  b.json.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }];
  b.json.textures = [{ source: 0, sampler: 0 }];
  const wood = b.material({ name: 'Wood', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.7 } });
  const brass = b.material({ name: 'Brass', pbrMetallicRoughness: { baseColorFactor: [0.85, 0.65, 0.25, 1], metallicFactor: 1, roughnessFactor: 0.3 } });
  const glass = b.material({ name: 'Glass', alphaMode: 'BLEND', pbrMetallicRoughness: { baseColorFactor: [1, 0.85, 0.5, 0.45], metallicFactor: 0, roughnessFactor: 0.05 }, emissiveFactor: [0.9, 0.6, 0.2] });
  const root = b.node({ name: 'Lantern' });
  b.node({ name: 'Base', mesh: b.mesh('Base', new THREE.CylinderGeometry(0.16, 0.18, 0.05, 6), wood), translation: [0, 0.025, 0] }, root);
  b.node({ name: 'Glass', mesh: b.mesh('Glass', new THREE.CylinderGeometry(0.12, 0.12, 0.26, 6, 1, true), glass), translation: [0, 0.18, 0] }, root);
  for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2 + Math.PI / 6; b.node({ name: `Post ${k + 1}`, mesh: b.mesh(`Post${k}`, new THREE.BoxGeometry(0.02, 0.27, 0.02), brass), translation: [Math.cos(a) * 0.135, 0.18, Math.sin(a) * 0.135] }, root); }
  b.node({ name: 'Roof', mesh: b.mesh('Roof', new THREE.ConeGeometry(0.19, 0.12, 6), wood), translation: [0, 0.37, 0] }, root);
  b.node({ name: 'Handle', mesh: b.mesh('Handle', new THREE.TorusGeometry(0.05, 0.008, 12, 32), brass), translation: [0, 0.47, 0] }, root);
  const bin = b.bin(); b.json.buffers.push({ uri: 'lantern.bin', byteLength: bin.length });
  save('lantern.gltf', JSON.stringify(b.json, null, 1));
  save('lantern.bin', bin);
  save('lantern-wood.png', png(W, H, px));
}

// ---------- 3. gear.stl: binary STL, millimetres, Z up ----------
function gearShape(teeth, rOuter, rRoot, rHole) {
  const s = new THREE.Shape();
  const steps = teeth * 4;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2; const r = (i % 4 === 1 || i % 4 === 2) ? rOuter : rRoot;
    if (i === 0) s.moveTo(Math.cos(a) * r, Math.sin(a) * r); else s.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  const hole = new THREE.Path(); hole.absarc(0, 0, rHole, 0, Math.PI * 2, true); s.holes.push(hole);
  for (let k = 0; k < 5; k++) { const a = (k / 5) * Math.PI * 2; const p = new THREE.Path(); p.absarc(Math.cos(a) * rRoot * 0.6, Math.sin(a) * rRoot * 0.6, rRoot * 0.16, 0, Math.PI * 2, true); s.holes.push(p); }
  return s;
}
function stlBinary(geo, header) {
  const g = geo.index ? geo.toNonIndexed() : geo; const pos = g.attributes.position; const n = pos.count / 3;
  const b = Buffer.alloc(84 + n * 50); b.write(header.slice(0, 80), 0); b.writeUInt32LE(n, 80);
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3(), N = new THREE.Vector3();
  for (let t = 0; t < n; t++) {
    A.fromBufferAttribute(pos, t * 3); B.fromBufferAttribute(pos, t * 3 + 1); C.fromBufferAttribute(pos, t * 3 + 2);
    N.subVectors(C, B).cross(new THREE.Vector3().subVectors(A, B)).normalize();
    let o = 84 + t * 50; for (const v of [N, A, B, C]) { b.writeFloatLE(v.x, o); b.writeFloatLE(v.y, o + 4); b.writeFloatLE(v.z, o + 8); o += 12; }
  }
  return b;
}
{
  const geo = new THREE.ExtrudeGeometry(gearShape(24, 40, 35, 8), { depth: 12, bevelEnabled: true, bevelSize: 0.8, bevelThickness: 0.8, bevelSegments: 2, curveSegments: 24 });
  const hub = new THREE.CylinderGeometry(14, 14, 10, 64).rotateX(Math.PI / 2).translate(0, 0, 17);
  const hubHoleless = hub.toNonIndexed();
  const merged = new THREE.BufferGeometry();
  const a = geo.attributes.position.array, c = hubHoleless.attributes.position.array;
  merged.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array([...a, ...c]), 3));
  save('gear.stl', stlBinary(merged, 'gear: 24 teeth, 80 mm, made by 3d-model-viewer make-samples'));
}

// ---------- 4. torus-knot.obj + torus-knot.mtl ----------
{
  const knot = new THREE.TorusKnotGeometry(1, 0.32, 360, 48, 2, 3);
  const plate = new THREE.BoxGeometry(3.4, 0.2, 3.4).translate(0, -1.75, 0);
  const lines = ['# torus knot on a plate, made by 3d-model-viewer make-samples', 'mtllib torus-knot.mtl'];
  const p = knot.attributes.position, n = knot.attributes.normal, uv = knot.attributes.uv;
  lines.push('o TorusKnot', 'usemtl Copper');
  for (let i = 0; i < p.count; i++) lines.push(`v ${p.getX(i).toFixed(5)} ${p.getY(i).toFixed(5)} ${p.getZ(i).toFixed(5)}`);
  for (let i = 0; i < uv.count; i++) lines.push(`vt ${uv.getX(i).toFixed(5)} ${uv.getY(i).toFixed(5)}`);
  for (let i = 0; i < n.count; i++) lines.push(`vn ${n.getX(i).toFixed(4)} ${n.getY(i).toFixed(4)} ${n.getZ(i).toFixed(4)}`);
  const idx = knot.index.array;
  for (let i = 0; i < idx.length; i += 3) { const [a, b, c] = [idx[i] + 1, idx[i + 1] + 1, idx[i + 2] + 1]; lines.push(`f ${a}/${a}/${a} ${b}/${b}/${b} ${c}/${c}/${c}`); }
  const off = p.count; const pp = plate.attributes.position;
  lines.push('o Plate', 'usemtl Slate');
  for (let i = 0; i < pp.count; i++) lines.push(`v ${pp.getX(i).toFixed(5)} ${pp.getY(i).toFixed(5)} ${pp.getZ(i).toFixed(5)}`);
  const pi = plate.index.array; // no normals for the plate: the viewer computes them
  for (let i = 0; i < pi.length; i += 3) lines.push(`f ${pi[i] + 1 + off} ${pi[i + 1] + 1 + off} ${pi[i + 2] + 1 + off}`);
  save('torus-knot.obj', lines.join('\n') + '\n');
  save('torus-knot.mtl', ['# materials for torus-knot.obj', 'newmtl Copper', 'Ka 0.2 0.1 0.05', 'Kd 0.85 0.45 0.25', 'Ks 0.9 0.7 0.5', 'Ns 120', 'illum 2', '', 'newmtl Slate', 'Kd 0.25 0.28 0.32', 'Ks 0.1 0.1 0.1', 'Ns 10', 'illum 2', ''].join('\n'));
}

// ---------- 5. terrain-points.ply: binary point cloud with colours ----------
{
  const N = 400; const count = N * N;
  const header = `ply\nformat binary_little_endian 1.0\ncomment synthetic terrain scan, made by 3d-model-viewer make-samples\nelement vertex ${count}\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n`;
  const body = Buffer.alloc(count * 15); let o = 0;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = (i / (N - 1) - 0.5) * 100, z = (j / (N - 1) - 0.5) * 100;
    const hgt = 8 * Math.sin(x * 0.06) * Math.cos(z * 0.05) + 5 * Math.exp(-((x - 15) ** 2 + (z + 10) ** 2) / 300) * 3 + 1.5 * Math.sin(x * 0.4 + z * 0.3);
    const t = Math.min(1, Math.max(0, (hgt + 12) / 34));
    const col = t < 0.35 ? [40, 110 + t * 200, 60] : t < 0.7 ? [120 + t * 80, 100 + t * 60, 60] : [230, 230, 235];
    body.writeFloatLE(x, o); body.writeFloatLE(hgt, o + 4); body.writeFloatLE(z, o + 8); body[o + 12] = col[0]; body[o + 13] = col[1]; body[o + 14] = col[2]; o += 15;
  }
  save('terrain-points.ply', Buffer.concat([Buffer.from(header), body]));
}

// ---------- 6. vase.ply: ASCII mesh with vertex colours ----------
{
  const prof = []; for (let i = 0; i <= 40; i++) { const t = i / 40; prof.push(new THREE.Vector2(0.4 + 0.35 * Math.sin(t * Math.PI * 1.3) + 0.1 * t, t * 2)); }
  const geo = new THREE.LatheGeometry(prof, 64);
  const p = geo.attributes.position, idx = geo.index.array;
  const lines = ['ply', 'format ascii 1.0', 'comment lathe vase, made by 3d-model-viewer make-samples', `element vertex ${p.count}`, 'property float x', 'property float y', 'property float z', 'property uchar red', 'property uchar green', 'property uchar blue', `element face ${idx.length / 3}`, 'property list uchar int vertex_indices', 'end_header'];
  for (let i = 0; i < p.count; i++) { const t = p.getY(i) / 2; lines.push(`${p.getX(i).toFixed(5)} ${p.getY(i).toFixed(5)} ${p.getZ(i).toFixed(5)} ${Math.round(30 + 200 * t)} ${Math.round(90 + 60 * (1 - t))} ${Math.round(200 - 120 * t)}`); }
  for (let i = 0; i < idx.length; i += 3) lines.push(`3 ${idx[i]} ${idx[i + 1]} ${idx[i + 2]}`);
  save('vase.ply', lines.join('\n') + '\n');
}

// ---------- 7. bracket.3mf: two objects, base materials, millimetres ----------
{
  const L = new THREE.Shape(); L.moveTo(0, 0); L.lineTo(60, 0); L.lineTo(60, 8); L.lineTo(8, 8); L.lineTo(8, 45); L.lineTo(0, 45); L.lineTo(0, 0);
  const objXml = (id, name, geo, pindex) => {
    const g0 = geo.clone(); for (const k of Object.keys(g0.attributes)) if (k !== 'position') g0.deleteAttribute(k);
    const g = mergeVertices(g0.index ? g0.toNonIndexed() : g0, 1e-4); const p = g.attributes.position; const ix = g.index.array;
    const v = []; for (let i = 0; i < p.count; i++) v.push(`<vertex x="${p.getX(i).toFixed(4)}" y="${p.getY(i).toFixed(4)}" z="${p.getZ(i).toFixed(4)}"/>`);
    const t = []; for (let i = 0; i < ix.length; i += 3) t.push(`<triangle v1="${ix[i]}" v2="${ix[i + 1]}" v3="${ix[i + 2]}"/>`);
    return `<object id="${id}" name="${name}" type="model" pid="1" pindex="${pindex}"><mesh><vertices>${v.join('')}</vertices><triangles>${t.join('')}</triangles></mesh></object>`;
  };
  const bracket = new THREE.ExtrudeGeometry(L, { depth: 30, bevelEnabled: false }).rotateX(Math.PI / 2).translate(0, 30, 0);
  const bolt = new THREE.CylinderGeometry(3, 3, 20, 32).rotateX(Math.PI / 2).translate(30, 15, 18);
  const model = `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Title">Bracket sample</metadata><resources><basematerials id="1"><base name="Orange PLA" displaycolor="#F07818FF"/><base name="Steel" displaycolor="#9AA0A8FF"/></basematerials>${objXml(2, 'Bracket', bracket, 0)}${objXml(3, 'Bolt', bolt, 1)}</resources><build><item objectid="2"/><item objectid="3"/></build></model>`;
  save('bracket.3mf', zipStore([
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>' },
    { name: '3D/3dmodel.model', data: model },
  ]));
}

for (const [n, s] of written) { if (s > 5 * 1024 * 1024) throw new Error(`${n} is over 5 MB`); console.log(`${n}\t${s}`); }
