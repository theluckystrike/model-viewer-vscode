'use strict';
// Print check and section math (Zovo Pro, lane PRO4) on solids with known answers.
const test = require('node:test');
const assert = require('node:assert');
const PC = require('../src/core/printcheck');

/** Axis-aligned box as 12 outward-facing triangles; inward = true flips every face (a cavity). */
function box(x0, y0, z0, x1, y1, z1, inward) {
  const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const f = [[0, 3, 2], [0, 2, 1], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const out = [];
  for (const [a, b, c] of f) for (const k of inward ? [a, c, b] : [a, b, c]) out.push(...v[k]);
  return out;
}
const soup = (...parts) => Float64Array.from(parts.flat());
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} is not ${b}`);

test('a 10 mm cube: volume, area, watertight, one shell', () => {
  const r = PC.analyze(soup(box(0, 0, 0, 10, 10, 10)));
  near(r.volume, 1000); near(r.area, 600);
  assert.strictEqual(r.triangles, 12);
  assert.strictEqual(r.vertices, 8);
  assert.strictEqual(r.watertight, true);
  assert.strictEqual(r.shells, 1);
  assert.strictEqual(r.inverted, false);
  assert.deepStrictEqual([r.openEdges, r.nonManifoldEdges, r.flippedEdges, r.degenerate], [0, 0, 0, 0]);
});

test('the volume does not depend on where the part sits', () => {
  near(PC.analyze(soup(box(1000, -500, 250, 1010, -490, 260))).volume, 1000, 1e-9);
});

test('a missing triangle gives 3 open edges and not watertight', () => {
  const s = box(0, 0, 0, 10, 10, 10).slice(9);
  const r = PC.analyze(soup(s));
  assert.strictEqual(r.openEdges, 3);
  assert.strictEqual(r.watertight, false);
  assert.strictEqual(r.openEdgeList.length, 18);
});

test('one flipped face is found by its 3 edges', () => {
  const s = box(0, 0, 0, 10, 10, 10);
  const t = s.slice(0, 9);
  s.splice(0, 9, ...t.slice(0, 3), ...t.slice(6, 9), ...t.slice(3, 6));
  const r = PC.analyze(soup(s));
  assert.strictEqual(r.flippedEdges, 3);
  assert.strictEqual(r.openEdges, 0);
});

test('an inside-out part is named', () => {
  const r = PC.analyze(soup(box(0, 0, 0, 10, 10, 10, true)));
  assert.strictEqual(r.inverted, true);
  near(r.volume, -1000);
});

test('two separate cubes are two shells; two cubes sharing an edge make it non-manifold', () => {
  assert.strictEqual(PC.analyze(soup(box(0, 0, 0, 1, 1, 1), box(5, 0, 0, 6, 1, 1))).shells, 2);
  const r = PC.analyze(soup(box(0, 0, 0, 1, 1, 1), box(1, 1, 0, 2, 2, 1)));
  assert.strictEqual(r.nonManifoldEdges, 1);
  assert.strictEqual(r.watertight, false);
});

test('a hollow cube: the cavity is subtracted', () => {
  const r = PC.analyze(soup(box(0, 0, 0, 10, 10, 10), box(2, 2, 2, 8, 8, 8, true)));
  near(r.volume, 1000 - 216);
  assert.strictEqual(r.watertight, true);
  assert.strictEqual(r.shells, 2);
});

test('degenerate triangles are counted and skipped', () => {
  const r = PC.analyze(soup(box(0, 0, 0, 10, 10, 10), [0, 0, 0, 5, 5, 5, 0, 0, 0]));
  assert.strictEqual(r.degenerate, 1);
  assert.strictEqual(r.watertight, true);
});

test('tiny seams from float noise weld together', () => {
  const s = box(0, 0, 0, 10, 10, 10).map((v, i) => (i % 7 === 0 ? v + 1e-9 : v));
  assert.strictEqual(PC.analyze(soup(s)).watertight, true);
});

test('the estimate: shell plus infill, weight, filament and cost', () => {
  const e = PC.estimate({ volume: 1000, area: 600, density: 1.24, infill: 0.2, wall: 0.8, diameter: 1.75, pricePerKg: 20 });
  near(e.solidGrams, 1.24);
  near(e.printedMm3, 480 + 520 * 0.2);
  near(e.grams, 0.584 * 1.24);
  near(e.filamentMeters, 584 / (Math.PI * 0.875 * 0.875) / 1000);
  near(e.cost, (0.584 * 1.24 / 1000) * 20);
  // walls thicker than the part: everything is solid
  near(PC.estimate({ volume: 1000, area: 600, density: 1, infill: 0, wall: 50, diameter: 1.75 }).grams, 1);
});

test('section through a cube: one anticlockwise loop of 100 mm² and 40 mm', () => {
  for (const axis of [0, 1, 2]) {
    const s = PC.section(soup(box(0, 0, 0, 10, 10, 10)), axis, 5.0001);
    assert.strictEqual(s.loops.length, 1, 'axis ' + axis);
    assert.strictEqual(s.loops[0].closed, true);
    assert.ok(s.loops[0].area > 0, 'anticlockwise seen from +axis');
    near(s.area, 100, 1e-6); near(s.perimeter, 40, 1e-6);
    assert.strictEqual(s.open, 0);
  }
});

test('section through a hollow cube: outer loop minus the hole', () => {
  const s = PC.section(soup(box(0, 0, 0, 10, 10, 10), box(2, 2, 2, 8, 8, 8, true)), 2, 4.5);
  assert.strictEqual(s.loops.length, 2);
  assert.strictEqual(s.loops.filter((l) => l.area < 0).length, 1, 'the hole runs clockwise');
  near(s.area, 100 - 36, 1e-6);
  near(s.perimeter, 40 + 24, 1e-6);
});

test('section of an open mesh reports open chains; a plane outside the part is empty', () => {
  const open = box(0, 0, 0, 10, 10, 10).slice(9 * 6); // drop 6 of 12 faces
  const s = PC.section(soup(open), 2, 5);
  assert.ok(s.open > 0);
  const none = PC.section(soup(box(0, 0, 0, 10, 10, 10)), 2, 50);
  assert.strictEqual(none.loops.length, 0);
  assert.strictEqual(none.area, 0);
});

test('section SVG: millimetre size, one path, even-odd holes, title escaped', () => {
  const s = PC.section(soup(box(0, 0, 0, 10, 10, 10), box(2, 2, 2, 8, 8, 8, true)), 2, 4.5);
  const svg = PC.sectionSvg(s, 'a<b>&c');
  assert.match(svg, /width="10\.4mm" height="10\.4mm"/);
  assert.strictEqual((svg.match(/<path /g) || []).length, 1);
  assert.strictEqual((svg.match(/M/g) || []).length, 2);
  assert.match(svg, /fill-rule="evenodd"/);
  assert.match(svg, /<title>a&lt;b&gt;&amp;c<\/title>/);
  assert.strictEqual(PC.sectionSvg({ loops: [] }), null);
});

test('report Markdown has the numbers a buyer checks', () => {
  const r = PC.analyze(soup(box(0, 0, 0, 10, 10, 10)));
  const p = { material: 'PETG', density: 1.27, infill: 0.15, wall: 0.8, diameter: 1.75, pricePerKg: 25 };
  const md = PC.reportMarkdown(r, PC.estimate({ ...p, volume: r.volume, area: r.area }), p, 'part.stl');
  assert.match(md, /^# Print check: part\.stl/);
  assert.match(md, /\| Volume \| 1\.00 cm³ \|/);
  assert.match(md, /\| Watertight \| yes \|/);
  assert.match(md, /PETG, 15 % infill/);
});

test('too many triangles is a clear message, not a hang', () => {
  assert.throws(() => PC.analyze({ length: (PC.MAX_TRIANGLES + 1) * 9 }), /reads up to 3,000,000 triangles/);
});
