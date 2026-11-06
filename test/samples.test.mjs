// Generates the samples into a temp folder and reads every one back with the three.js loaders the webview uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { unzipSync, strFromU8 } from 'three/addons/libs/fflate.module.js';

const require = createRequire(import.meta.url);
const P = require('../src/core/protocol.js');
const S = require('../src/core/stats.js');
const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-samples-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
execFileSync(process.execPath, [path.join(root, 'scripts', 'make-samples.mjs'), dir]);
const read = n => fs.readFileSync(path.join(dir, n));
const ab = b => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

test('every sample is under 5 MB and passes sniff', () => {
  for (const f of fs.readdirSync(dir)) {
    assert.ok(fs.statSync(path.join(dir, f)).size < 5 * 1024 * 1024, f);
    const fmt = P.formatOf(f);
    if (fmt) assert.equal(P.sniff(read(f), fmt).ok, true, f);
  }
});

test('robot-arm.glb: node tree, 4 materials, 3 animation clips', async () => {
  const g = await new GLTFLoader().parseAsync(ab(read('robot-arm.glb')), '');
  assert.deepEqual(g.animations.map(a => a.name), ['Wave', 'Spin', 'Grip']);
  assert.equal(g.animations[1].duration, 6);
  const s = S.sceneStats(g.scene, g.animations);
  assert.equal(s.meshes, 10);
  assert.equal(s.materials, 4);
  assert.equal(s.animations, 3);
  assert.ok(s.triangles > 1000 && s.vertices > 1000);
  const names = []; g.scene.traverse(o => names.push(o.name));
  for (const n of ['Base', 'Turntable', 'LowerArm', 'Elbow', 'UpperArm', 'Wrist', 'FingerLeft', 'FingerRight']) assert.ok(names.includes(n), n);
  // the clip moves the elbow
  const mixer = new THREE.AnimationMixer(g.scene);
  const elbow = g.scene.getObjectByName('Elbow');
  const before = elbow.quaternion.clone();
  mixer.clipAction(g.animations[0]).play(); mixer.update(1);
  assert.ok(elbow.quaternion.angleTo(before) > 0.1);
});

test('lantern.gltf: external .bin and texture are referenced and sized right', () => {
  const j = JSON.parse(read('lantern.gltf'));
  assert.equal(j.buffers[0].uri, 'lantern.bin');
  assert.equal(j.buffers[0].byteLength, read('lantern.bin').length);
  for (const v of j.bufferViews) assert.ok(v.byteOffset + v.byteLength <= j.buffers[0].byteLength);
  assert.equal(j.images[0].uri, 'lantern-wood.png');
  assert.deepEqual([...read('lantern-wood.png').subarray(1, 4)], [0x50, 0x4e, 0x47]);
  assert.ok(j.meshes.some(m => m.primitives[0].attributes.TEXCOORD_0 !== undefined));
});

test('gear.stl: binary STL triangle count matches the header', () => {
  const b = read('gear.stl');
  const sn = P.sniff(b, 'stl');
  assert.equal(sn.detail, 'binary');
  const geo = new STLLoader().parse(ab(b));
  const s = S.sceneStats(new THREE.Mesh(geo));
  assert.equal(s.triangles, sn.triangles);
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  assert.ok(Math.abs(bb.max.x - bb.min.x - 80) < 2, 'about 80 mm across');
});

test('torus-knot.obj: two objects, mtllib found, MTL materials applied', () => {
  const text = read('torus-knot.obj').toString();
  assert.deepEqual(P.mtlLibs(text), ['torus-knot.mtl']);
  const mtl = new MTLLoader().parse(read('torus-knot.mtl').toString(), '');
  mtl.preload();
  const obj = new OBJLoader().setMaterials(mtl).parse(text);
  const s = S.sceneStats(obj);
  assert.equal(s.meshes, 2);
  const mats = []; obj.traverse(o => o.isMesh && mats.push(o.material.name));
  assert.deepEqual(mats.sort(), ['Copper', 'Slate']);
  assert.equal(s.triangles, 360 * 48 * 2 + 12);
});

test('PLY: point cloud has no faces, vase mesh has faces and colours', () => {
  const pts = new PLYLoader().parse(ab(read('terrain-points.ply')));
  assert.equal(pts.index, null);
  const sp = S.sceneStats(new THREE.Points(pts));
  assert.equal(sp.pointCount, 160000);
  assert.equal(sp.triangles, 0);
  assert.ok(pts.attributes.color);
  const vase = new PLYLoader().parse(ab(read('vase.ply')));
  const sv = S.sceneStats(new THREE.Mesh(vase));
  assert.equal(sv.triangles, 40 * 64 * 2);
  assert.ok(sv.hasColors);
});

test('bracket.3mf: zip with the 3D model part, millimetres, 2 objects', () => {
  const files = unzipSync(new Uint8Array(read('bracket.3mf')));
  assert.ok(files['_rels/.rels'] && files['[Content_Types].xml']);
  const xml = strFromU8(files['3D/3dmodel.model']);
  assert.match(xml, /unit="millimeter"/);
  assert.equal((xml.match(/<object /g) || []).length, 2);
});

test('stats helpers: dims, distance, rows', () => {
  assert.equal(S.fmtDims({ x: 0, y: 0, z: 0 }, { x: 80, y: 12.5, z: 0.25 }, 'mm'), '80 × 12.5 × 0.25 mm');
  assert.equal(S.distance({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 }).d, 5);
  assert.match(S.fmtDistance({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 }, 'm'), /^5 m {2}\(Δx 3, Δy 4, Δz 0\)$/);
  assert.equal(S.fmtDims(null, null), 'empty');
  assert.match(S.fmtDistance({ x: 0, y: 0, z: 1 }, { x: 41.09, y: 30.82, z: 1 - 7.1e-15 }, 'mm'), /Δz 0\)$/, 'float noise shows as 0');
  assert.equal(S.round(0.84), '0.84');
  assert.equal(S.round(81.5312), '81.53');
  assert.equal(S.round(12345.6), '12346');
  const rows = S.statsRows({ meshes: 1, vertices: 1234567, triangles: 3, pointClouds: 0, materials: 1, textures: 0, nodes: 2, animations: 0 });
  assert.deepEqual(rows.find(r => r[0] === 'Vertices'), ['Vertices', '1,234,567']);
  assert.equal(rows.find(r => r[0] === 'Animations'), undefined);
});

test('instanced and indexed draw ranges count right', () => {
  const g = new THREE.BoxGeometry(); // 24 vertices, 12 triangles
  const inst = new THREE.InstancedMesh(g, new THREE.MeshBasicMaterial(), 5);
  const grp = new THREE.Group(); grp.add(inst);
  const s = S.sceneStats(grp);
  assert.equal(s.triangles, 60);
  assert.equal(s.vertices, 120);
  g.setDrawRange(0, 6);
  assert.equal(S.triCount(g, new THREE.Mesh(g)), 2);
});
