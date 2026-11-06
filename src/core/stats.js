'use strict';
// Model statistics from a three.js object tree. Works on any object with traverse(), so it runs in node tests.

function triCount(geo, obj) {
  const pos = geo.attributes && geo.attributes.position;
  if (!pos) return 0;
  if (obj.isPoints || obj.isLine) return 0;
  const n = geo.index ? geo.index.count : pos.count;
  const dr = geo.drawRange && Number.isFinite(geo.drawRange.count) ? Math.min(geo.drawRange.count, n) : n;
  return Math.floor(dr / 3);
}

/** Returns { meshes, points, vertices, triangles, pointCount, materials, textures, nodes, animations } */
function sceneStats(root, animations) {
  const mats = new Set();
  const texs = new Set();
  const geos = new Set();
  const s = { meshes: 0, pointClouds: 0, vertices: 0, triangles: 0, pointCount: 0, materials: 0, textures: 0, nodes: 0, animations: (animations || []).length, hasColors: false, hasUVs: false, skinned: 0, instanced: 0 };
  root.traverse(o => {
    s.nodes++;
    if (!o.geometry || !(o.isMesh || o.isPoints)) return;
    const geo = o.geometry;
    const pos = geo.attributes && geo.attributes.position;
    if (!pos) return;
    const inst = o.isInstancedMesh ? Math.max(1, o.count | 0) : 1;
    if (o.isInstancedMesh) s.instanced++;
    if (o.isSkinnedMesh) s.skinned++;
    if (o.isPoints) { s.pointClouds++; s.pointCount += pos.count * inst; }
    else { s.meshes++; s.vertices += pos.count * inst; s.triangles += triCount(geo, o) * inst; }
    if (geo.attributes.color) s.hasColors = true;
    if (geo.attributes.uv) s.hasUVs = true;
    geos.add(geo);
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of ms) {
      if (!m) continue;
      mats.add(m);
      for (const k of Object.keys(m)) { const v = m[k]; if (v && v.isTexture) texs.add(v.image || v); }
    }
  });
  s.materials = mats.size;
  s.textures = texs.size;
  s.geometries = geos.size;
  return s;
}

function round(n) {
  if (!Number.isFinite(n)) return '?';
  const a = Math.abs(n);
  if (a === 0) return '0';
  if (a >= 1000) return n.toFixed(0);
  return String(Number(n.toPrecision(4))); // 4 significant digits, no trailing zeros
}

function fmtInt(n) { return Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '?'; }

/** "12.5 × 4.00 × 3.20 mm" from a min/max box */
function fmtDims(min, max, unit) {
  if (!min || !max || !Number.isFinite(min.x) || !Number.isFinite(max.x)) return 'empty';
  return `${round(max.x - min.x)} × ${round(max.y - min.y)} × ${round(max.z - min.z)} ${unit || 'units'}`;
}

function distance(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  return { d: Math.sqrt(dx * dx + dy * dy + dz * dz), dx, dy, dz };
}

function fmtDistance(a, b, unit) {
  const r = distance(a, b);
  const eps = r.d * 1e-6; // float noise such as -7e-15 shows as 0
  for (const k of ['dx', 'dy', 'dz']) if (Math.abs(r[k]) < eps) r[k] = 0;
  return `${round(r.d)} ${unit || 'units'}  (Δx ${round(r.dx)}, Δy ${round(r.dy)}, Δz ${round(r.dz)})`;
}

/** Plain-text stats for "Copy", one "name\tvalue" per line. */
function statsRows(s, extra) {
  const rows = [];
  const add = (k, v) => rows.push([k, String(v)]);
  if (extra && extra.format) add('Format', extra.format);
  if (extra && extra.fileSize) add('File size', extra.fileSize);
  if (s.meshes) { add('Meshes', fmtInt(s.meshes)); add('Vertices', fmtInt(s.vertices)); add('Triangles', fmtInt(s.triangles)); }
  if (s.pointClouds) { add('Point clouds', fmtInt(s.pointClouds)); add('Points', fmtInt(s.pointCount)); }
  add('Materials', fmtInt(s.materials));
  add('Textures', fmtInt(s.textures));
  add('Nodes', fmtInt(s.nodes));
  if (s.animations) add('Animations', fmtInt(s.animations));
  if (extra && extra.size) add('Size', extra.size);
  return rows;
}

module.exports = { sceneStats, triCount, fmtDims, fmtInt, round, distance, fmtDistance, statsRows };
