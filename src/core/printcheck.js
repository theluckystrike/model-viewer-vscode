'use strict';
// Zovo Pro (lane PRO4): print check and section math on plain triangle arrays. No three.js and no vscode here, so
// the node tests run the same code as the webview.
// A "soup" is a Float64Array with 9 numbers per triangle (x0 y0 z0 x1 y1 z1 x2 y2 z2) in millimetres.

const MAX_TRIANGLES = 3000000;

/** Materials for the weight and filament estimate. Density in g/cm³ (typical datasheet values). */
const MATERIALS = {
  PLA: 1.24, PETG: 1.27, ABS: 1.04, ASA: 1.07, TPU: 1.21, 'Nylon (PA12)': 1.01, PC: 1.2, 'Resin (standard)': 1.12,
};

/** Millimetres per model unit. glTF is metres; 3MF is millimetres; STL, OBJ and PLY have no unit (the user picks). */
const UNIT_MM = { mm: 1, cm: 10, m: 1000, in: 25.4 };

/**
 * Weld the corners by position (within tol), then count edges. Returns the checks a slicer cares about.
 * { triangles, volume, area, min, max, degenerate, openEdges, nonManifoldEdges, flippedEdges, shells, watertight,
 *   inverted, openEdgeList, badEdgeList } (edge lists are flat arrays of 6 numbers per edge, at most listMax edges).
 */
function analyze(soup, opts) {
  const o = opts || {};
  const listMax = o.listMax == null ? 20000 : o.listMax;
  const n = Math.floor(soup.length / 9);
  if (n > MAX_TRIANGLES) throw new Error(`The print check reads up to ${MAX_TRIANGLES.toLocaleString('en-US')} triangles. This model has ${n.toLocaleString('en-US')}.`);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n * 9; i += 3) for (let c = 0; c < 3; c++) { const v = soup[i + c]; if (v < min[c]) min[c] = v; if (v > max[c]) max[c] = v; }
  const diag = n ? Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) : 0;
  const tol = o.tolerance || Math.max(diag * 1e-7, 1e-9);
  // Weld: one id per distinct corner position (rounded to tol).
  const ids = new Map();
  const vid = new Int32Array(n * 3);
  const corner = [];
  for (let t = 0; t < n; t++) for (let k = 0; k < 3; k++) {
    const i = t * 9 + k * 3;
    const key = Math.round(soup[i] / tol) + ',' + Math.round(soup[i + 1] / tol) + ',' + Math.round(soup[i + 2] / tol);
    let id = ids.get(key);
    if (id === undefined) { id = ids.size; ids.set(key, id); corner.push(i); }
    vid[t * 3 + k] = id;
  }
  const nv = ids.size;
  ids.clear();
  let volume = 0, area = 0, degenerate = 0;
  const edgeId = new Map();
  const count = new Int32Array(n * 3), balance = new Int32Array(n * 3), firstTri = new Int32Array(n * 3);
  let ne = 0;
  const parent = new Int32Array(n);
  for (let t = 0; t < n; t++) parent[t] = t;
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  let live = 0;
  for (let t = 0; t < n; t++) {
    const i = t * 9;
    const ax = soup[i], ay = soup[i + 1], az = soup[i + 2];
    const bx = soup[i + 3] - ax, by = soup[i + 4] - ay, bz = soup[i + 5] - az;
    const cx = soup[i + 6] - ax, cy = soup[i + 7] - ay, cz = soup[i + 8] - az;
    const nx = by * cz - bz * cy, ny = bz * cx - bx * cz, nz = bx * cy - by * cx;
    const a2 = Math.hypot(nx, ny, nz);
    // Signed volume of the tetrahedron (origin, a, b, c), relative to a for precision: a·(b×c)/6 with b, c from a.
    volume += (ax * nx + ay * ny + az * nz) / 6;
    area += a2 / 2;
    const v0 = vid[t * 3], v1 = vid[t * 3 + 1], v2 = vid[t * 3 + 2];
    if (v0 === v1 || v1 === v2 || v0 === v2 || a2 <= tol * tol) { degenerate++; continue; }
    live++;
    for (const [u, v] of [[v0, v1], [v1, v2], [v2, v0]]) {
      const lo = u < v ? u : v, hi = u < v ? v : u;
      const key = lo * nv + hi;
      let e = edgeId.get(key);
      if (e === undefined) { e = ne++; edgeId.set(key, e); firstTri[e] = t; }
      else { const ra = find(t), rb = find(firstTri[e]); if (ra !== rb) parent[ra] = rb; }
      count[e]++;
      balance[e] += u < v ? 1 : -1;
    }
  }
  let openEdges = 0, nonManifoldEdges = 0, flippedEdges = 0;
  const openEdgeList = [], badEdgeList = [];
  const push = (list, key) => {
    if (list.length >= listMax * 6) return;
    const lo = Math.floor(key / nv), hi = key - lo * nv;
    const a = corner[lo], b = corner[hi];
    list.push(soup[a], soup[a + 1], soup[a + 2], soup[b], soup[b + 1], soup[b + 2]);
  };
  for (const [key, e] of edgeId) {
    if (count[e] === 1) { openEdges++; push(openEdgeList, key); }
    else if (count[e] > 2) { nonManifoldEdges++; push(badEdgeList, key); }
    else if (balance[e] !== 0) { flippedEdges++; push(badEdgeList, key); }
  }
  const roots = new Set();
  for (let t = 0; t < n; t++) {
    const v0 = vid[t * 3], v1 = vid[t * 3 + 1], v2 = vid[t * 3 + 2];
    if (v0 === v1 || v1 === v2 || v0 === v2) continue;
    roots.add(find(t));
  }
  return {
    triangles: n, vertices: nv, volume, area, min, max, degenerate,
    openEdges, nonManifoldEdges, flippedEdges, shells: live ? roots.size : 0,
    watertight: live > 0 && openEdges === 0 && nonManifoldEdges === 0,
    inverted: volume < 0, openEdgeList, badEdgeList,
  };
}

/**
 * Weight, filament and cost. volume and area in mm³ and mm². A slicer prints walls solid and fills the inside at the
 * infill share, so: shell = area × wall (at most the whole part), inside = the rest × infill.
 */
function estimate({ volume, area, density, infill, wall, diameter, pricePerKg }) {
  const v = Math.abs(volume);
  const shell = Math.min(v, Math.max(0, area) * Math.max(0, wall));
  const printed = shell + (v - shell) * Math.min(1, Math.max(0, infill));
  const g = (mm3) => (mm3 / 1000) * density;
  const r = (diameter || 1.75) / 2;
  return {
    solidGrams: g(v), grams: g(printed), printedMm3: printed,
    filamentMeters: printed / (Math.PI * r * r) / 1000,
    cost: (g(printed) / 1000) * (pricePerKg || 0),
  };
}

/**
 * Cut the soup with the plane coordinate[axis] = value (axis 0, 1, 2). Returns loops in the plane's 2D coordinates
 * (u, v) = (y, z) for X, (z, x) for Y, (x, y) for Z, so a loop seen from +axis runs anticlockwise when it bounds
 * material and clockwise around a hole (for a mesh whose faces point outwards).
 * { segments (flat, 6 numbers each, 3D), loops: [{ points: [u, v, ...], closed, area }], area, perimeter, open }
 */
function section(soup, axis, value) {
  const n = Math.floor(soup.length / 9);
  const U = (axis + 1) % 3, V = (axis + 2) % 3;
  const segs = [];
  const P = [];
  const cut = (i, j) => {
    // Same edge, same point: order the two corners so neighbouring triangles compute identical numbers.
    let a = i, b = j;
    if (soup[a + axis] > soup[b + axis] || (soup[a + axis] === soup[b + axis] && (soup[a + U] > soup[b + U] || (soup[a + U] === soup[b + U] && soup[a + V] > soup[b + V])))) { a = j; b = i; }
    const da = soup[a + axis] - value, db = soup[b + axis] - value;
    const t = da / (da - db);
    return [soup[a] + (soup[b] - soup[a]) * t, soup[a + 1] + (soup[b + 1] - soup[a + 1]) * t, soup[a + 2] + (soup[b + 2] - soup[a + 2]) * t];
  };
  for (let t = 0; t < n; t++) {
    const i = t * 9;
    const s0 = soup[i + axis] - value, s1 = soup[i + 3 + axis] - value, s2 = soup[i + 6 + axis] - value;
    const above = (s0 > 0) + (s1 > 0) + (s2 > 0);
    if (above === 0 || above === 3) continue;
    // A corner exactly on the plane counts as below; the caller nudges the value off vertex planes.
    const c = [i, i + 3, i + 6], s = [s0, s1, s2];
    const pts = [];
    for (let k = 0; k < 3; k++) { const k2 = (k + 1) % 3; if ((s[k] > 0) !== (s[k2] > 0)) pts.push(cut(c[k], c[k2])); }
    if (pts.length !== 2) continue;
    // Orient the segment: (d × n) · N > 0, with n the plane normal and N the face normal.
    const ax = soup[i + 3] - soup[i], ay = soup[i + 4] - soup[i + 1], az = soup[i + 5] - soup[i + 2];
    const bx = soup[i + 6] - soup[i], by = soup[i + 7] - soup[i + 1], bz = soup[i + 8] - soup[i + 2];
    const N = [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
    const d = [pts[1][0] - pts[0][0], pts[1][1] - pts[0][1], pts[1][2] - pts[0][2]];
    // e_U × e_V = e_axis, so d × e_axis = d[V] e_U - d[U] e_V.
    const dn = [0, 0, 0];
    dn[U] = d[V]; dn[V] = -d[U];
    const dot = dn[0] * N[0] + dn[1] * N[1] + dn[2] * N[2];
    const [p, q] = dot >= 0 ? [pts[0], pts[1]] : [pts[1], pts[0]];
    segs.push(p[0], p[1], p[2], q[0], q[1], q[2]);
  }
  // Chain segments into loops by their end points.
  const m = segs.length / 6;
  let span = 0;
  for (let k = 0; k < m * 6; k += 3) span = Math.max(span, Math.abs(segs[k + U]), Math.abs(segs[k + V]));
  const tol = Math.max(span * 1e-9, 1e-12);
  const keyOf = (k) => Math.round(segs[k + U] / tol) + ',' + Math.round(segs[k + V] / tol);
  const starts = new Map();
  for (let s = 0; s < m; s++) {
    const key = keyOf(s * 6);
    const list = starts.get(key);
    if (list) list.push(s); else starts.set(key, [s]);
  }
  const usedSeg = new Uint8Array(m);
  const loops = [];
  let total = 0, perimeter = 0, open = 0;
  for (let s0 = 0; s0 < m; s0++) {
    if (usedSeg[s0]) continue;
    const pts = [];
    let s = s0, closed = false;
    const startKey = keyOf(s0 * 6);
    for (let guard = 0; guard <= m; guard++) {
      usedSeg[s] = 1;
      pts.push(segs[s * 6 + U], segs[s * 6 + V]);
      const endKey = keyOf(s * 6 + 3);
      if (endKey === startKey) { closed = true; break; }
      const next = (starts.get(endKey) || []).find((x) => !usedSeg[x]);
      if (next === undefined) { pts.push(segs[s * 6 + 3 + U], segs[s * 6 + 3 + V]); break; }
      s = next;
    }
    let a = 0, per = 0;
    const k = pts.length / 2;
    for (let j = 0; j < k; j++) {
      const j2 = (j + 1) % k;
      if (!closed && j2 === 0) break;
      a += pts[j * 2] * pts[j2 * 2 + 1] - pts[j2 * 2] * pts[j * 2 + 1];
      per += Math.hypot(pts[j2 * 2] - pts[j * 2], pts[j2 * 2 + 1] - pts[j * 2 + 1]);
    }
    a = closed ? a / 2 : 0;
    if (!closed) open++;
    total += a; perimeter += per;
    loops.push({ points: pts, closed, area: a });
  }
  return { segments: segs, loops, area: Math.abs(total), signedArea: total, perimeter, open, axis, value };
}

/** SVG of a section, in millimetres, holes cut out (even-odd). */
function sectionSvg(sec, title) {
  const closed = sec.loops.filter((l) => l.points.length >= 6);
  let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
  for (const l of closed) for (let j = 0; j < l.points.length; j += 2) {
    minU = Math.min(minU, l.points[j]); maxU = Math.max(maxU, l.points[j]);
    minV = Math.min(minV, l.points[j + 1]); maxV = Math.max(maxV, l.points[j + 1]);
  }
  if (!Number.isFinite(minU)) return null;
  const pad = Math.max(maxU - minU, maxV - minV) * 0.02 || 1;
  const w = maxU - minU + 2 * pad, h = maxV - minV + 2 * pad;
  const f = (x) => Number(x.toFixed(4));
  // SVG y runs down; flip v so the drawing matches the view from +axis.
  const d = closed.map((l) => {
    const p = [];
    for (let j = 0; j < l.points.length; j += 2) p.push((j ? 'L' : 'M') + f(l.points[j] - minU + pad) + ' ' + f(maxV - l.points[j + 1] + pad));
    return p.join(' ') + (l.closed ? ' Z' : '');
  }).join(' ');
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${f(w)}mm" height="${f(h)}mm" viewBox="0 0 ${f(w)} ${f(h)}">
<title>${esc(title || 'Section')}</title>
<path d="${d}" fill="#e8743b" fill-opacity="0.35" fill-rule="evenodd" stroke="#000" stroke-width="${f(Math.max(w, h) / 500)}"/>
</svg>
`;
}

function fmtNum(x, digits) {
  if (!Number.isFinite(x)) return '?';
  const a = Math.abs(Number(x.toPrecision(9))); // 0.9999999 from float sums reads as 1
  const d = digits == null ? (a >= 100 ? 1 : a >= 1 ? 2 : 3) : digits;
  return x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** The report as Markdown (Copy report, Save report). */
function reportMarkdown(r, est, p, name) {
  const yes = (b) => (b ? 'yes' : 'no');
  const lines = [
    `# Print check: ${name}`, '',
    `| Check | Result |`, `|---|---|`,
    `| Size | ${fmtNum(r.max[0] - r.min[0])} × ${fmtNum(r.max[1] - r.min[1])} × ${fmtNum(r.max[2] - r.min[2])} mm |`,
    `| Volume | ${fmtNum(Math.abs(r.volume) / 1000)} cm³ |`,
    `| Surface area | ${fmtNum(r.area / 100)} cm² |`,
    `| Triangles | ${r.triangles.toLocaleString('en-US')} |`,
    `| Watertight | ${yes(r.watertight)} |`,
    `| Open edges | ${r.openEdges.toLocaleString('en-US')} |`,
    `| Non-manifold edges | ${r.nonManifoldEdges.toLocaleString('en-US')} |`,
    `| Edges with flipped faces | ${r.flippedEdges.toLocaleString('en-US')} |`,
    `| Degenerate triangles | ${r.degenerate.toLocaleString('en-US')} |`,
    `| Shells (separate parts) | ${r.shells.toLocaleString('en-US')} |`,
    `| Faces point inwards | ${yes(r.inverted)} |`,
    '',
    `## Estimate (${p.material}, ${Math.round(p.infill * 100)} % infill, ${p.wall} mm walls, ${p.diameter} mm filament)`, '',
    `| | |`, `|---|---|`,
    `| Weight | ${fmtNum(est.grams, 1)} g (solid: ${fmtNum(est.solidGrams, 1)} g) |`,
    `| Filament | ${fmtNum(est.filamentMeters, 2)} m |`,
    `| Material cost | ${fmtNum(est.cost, 2)} at ${fmtNum(p.pricePerKg, 2)} per kg |`,
    '',
    'The estimate ignores supports, brim and the top and bottom layers. A slicer gives the exact figure.',
  ];
  return lines.join('\n') + '\n';
}

module.exports = { analyze, estimate, section, sectionSvg, reportMarkdown, fmtNum, MATERIALS, UNIT_MM, MAX_TRIANGLES };
