// Zovo Pro tools in the webview (lane PRO4): Print check, Section view, Turntable export.
// The host decides whether a tool may run (license or a free try) and saves every file. Nothing here talks to the
// network. All text goes in with textContent.
import * as THREE from 'three';
import PC from '../core/printcheck.js';
import G from '../core/gif.js';

const AXES = ['X', 'Y', 'Z'];
const UNITLESS = new Set(['stl', 'obj', 'ply']);

export function setupPro(c) {
  const { h, ui, vscode } = c;
  const view = { shown: false, pro: false, features: {}, granted: [], prefs: { material: 'PLA', infill: 15, wall: 0.8, diameter: 1.75, pricePerKg: 20, unit: 'mm' } };
  const waiting = {}; // feature -> function to run when the host says go
  const badge = () => h('span', { class: 'pro-badge', text: 'PRO' });

  // ---------- shared ----------
  const allowedHere = f => view.pro || view.granted.includes(f);
  function ask(f, run) {
    if (allowedHere(f)) { run(); return; }
    waiting[f] = run;
    vscode.postMessage({ type: 'proAsk', feature: f });
  }
  function used(f) { if (!view.pro && !view.granted.includes(f)) { view.granted.push(f); vscode.postMessage({ type: 'proUsed', feature: f }); } }
  /** Millimetres per model unit: glTF is in metres, 3MF in millimetres, STL, OBJ and PLY in the unit the user picks. */
  function mmPerUnit() {
    if (c.fmt === 'glb' || c.fmt === 'gltf') return 1000;
    if (c.fmt === '3mf') return 1;
    return PC.UNIT_MM[view.prefs.unit] || 1;
  }

  let soupCache = null;
  /** Visible mesh triangles in model coordinates (before the up-axis turn), in millimetres. */
  function soup() {
    const scale = mmPerUnit();
    if (soupCache && soupCache.scale === scale) return soupCache;
    const model = c.model;
    const inv = new THREE.Matrix4().copy(c.root.matrixWorld).invert();
    const meshes = [];
    let total = 0;
    model.updateMatrixWorld(true);
    model.traverseVisible(o => {
      if (!o.isMesh || o.userData.helper || !o.geometry || !o.geometry.attributes.position) return;
      const g = o.userData.fileGeometry || o.geometry;
      const pos = g.attributes.position;
      const n = g.index ? g.index.count : pos.count;
      const tris = Math.floor(Math.min(n, g.drawRange && Number.isFinite(g.drawRange.count) ? g.drawRange.count : n) / 3);
      if (!tris) return;
      meshes.push({ o, g, tris });
      total += tris;
    });
    if (total > PC.MAX_TRIANGLES) throw new Error(`The Pro tools read up to ${PC.MAX_TRIANGLES.toLocaleString('en-US')} triangles. The visible meshes have ${total.toLocaleString('en-US')}. Hide parts in the scene tree and try again.`);
    const out = new Float64Array(total * 9);
    const m = new THREE.Matrix4(), v = new THREE.Vector3();
    let k = 0;
    for (const { o, g, tris } of meshes) {
      m.multiplyMatrices(inv, o.matrixWorld);
      const pos = g.attributes.position, idx = g.index;
      const start = g.drawRange ? g.drawRange.start || 0 : 0;
      for (let t = 0; t < tris; t++) for (let j = 0; j < 3; j++) {
        const i = start + t * 3 + j;
        v.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(m);
        out[k++] = v.x * scale; out[k++] = v.y * scale; out[k++] = v.z * scale;
      }
    }
    soupCache = { scale, data: out, triangles: total };
    return soupCache;
  }
  function modelChanged() { soupCache = null; if (print.result) print.stale(); if (section.on) section.rebuild(); }

  // ---------- Print check (side panel) ----------
  const print = (() => {
    const head = h('h2', {}, 'Print check ', badge());
    const body = h('div', { class: 'pro-body' });
    const el = h('section', { class: 'pro-print' }, head, body);
    let problems = null;
    const p = {
      el, result: null, showing: false,
      intro() {
        body.textContent = '';
        const f = view.features.print || {};
        body.append(
          h('p', { class: 'pro-note', text: 'Volume, weight, filament and cost, and a watertight check with open and flipped edges marked, before you slice.' }),
          h('button', { type: 'button', class: 'pro-run', text: 'Run print check', title: 'Zovo Pro', onclick: () => p.start() }),
          h('div', { class: 'pro-meta', text: f.label || '' }),
          links());
      },
      start() {
        if (!c.model) return;
        if (!c.stats || !c.stats.meshes) { c.setHint('The print check needs a mesh. This file has only points.'); return; }
        ask('print', () => p.run());
      },
      run() {
        p.running = true;
        body.textContent = '';
        body.append(h('p', { class: 'pro-note', text: 'Checking the mesh...' }));
        setTimeout(() => {
          try {
            const s = soup();
            const t0 = performance.now();
            p.result = PC.analyze(s.data);
            p.ms = performance.now() - t0;
            p.running = false;
            used('print');
            p.render();
          } catch (e) { p.running = false; body.textContent = ''; body.append(h('p', { class: 'pro-note err', text: e && e.message ? e.message : String(e) }), h('button', { type: 'button', text: 'Try again', onclick: () => p.run() })); }
        }, 20);
      },
      stale() {
        const b = body.querySelector('.pro-stale');
        if (b) return;
        body.prepend(h('p', { class: 'pro-note warn pro-stale' }, 'The visible parts changed. ', h('button', { type: 'button', class: 'link', text: 'Run again', onclick: () => p.run() })));
      },
      estimate() {
        const r = p.result, pr = view.prefs;
        return PC.estimate({ volume: r.volume, area: r.area, density: PC.MATERIALS[pr.material] || 1.24, infill: pr.infill / 100, wall: pr.wall, diameter: pr.diameter, pricePerKg: pr.pricePerKg });
      },
      params() { const pr = view.prefs; return { material: pr.material, density: PC.MATERIALS[pr.material], infill: pr.infill / 100, wall: pr.wall, diameter: pr.diameter, pricePerKg: pr.pricePerKg }; },
      render() {
        const r = p.result;
        body.textContent = '';
        const row = (k, v, cls) => h('div', { class: 'row' + (cls ? ' ' + cls : '') }, h('span', { class: 'k', text: k }), h('span', { class: 'v', text: v }));
        const n = x => x.toLocaleString('en-US');
        const f = PC.fmtNum;
        const unitNote = UNITLESS.has(c.fmt) ? `${c.fmt.toUpperCase()} has no unit. Read as` : null;
        const checks = h('div', { class: 'stats' },
          row('Size', `${f(r.max[0] - r.min[0])} × ${f(r.max[1] - r.min[1])} × ${f(r.max[2] - r.min[2])} mm`),
          row('Volume', `${f(Math.abs(r.volume) / 1000)} cm³`),
          row('Surface', `${f(r.area / 100)} cm²`),
          row('Watertight', r.watertight ? (r.flippedEdges ? 'yes, but some faces are flipped' : 'yes') : 'no', r.watertight && !r.flippedEdges ? 'ok' : 'warn'),
          r.openEdges ? row('Open edges', n(r.openEdges), 'warn') : null,
          r.nonManifoldEdges ? row('Non-manifold', `${n(r.nonManifoldEdges)} edges`, 'warn') : null,
          r.flippedEdges ? row('Flipped', `${n(r.flippedEdges)} edges between faces that point opposite ways`, 'warn') : null,
          r.inverted ? row('Inside out', 'the faces point inwards (negative volume)', 'warn') : null,
          r.degenerate ? row('Degenerate', `${n(r.degenerate)} zero-area triangles`) : null,
          row('Parts', `${n(r.shells)} ${r.shells === 1 ? 'shell' : 'separate shells'}`),
          row('Triangles', `${n(r.triangles)} (${Math.round(p.ms)} ms)`));
        const mat = h('select', { 'aria-label': 'Material' }, ...Object.keys(PC.MATERIALS).map(m => h('option', { value: m, text: `${m} (${PC.MATERIALS[m]} g/cm³)` })));
        mat.value = view.prefs.material;
        const numIn = (key, label, min, max, step, suffix) => {
          const i = h('input', { type: 'number', min: String(min), max: String(max), step: String(step), 'aria-label': label, class: 'pro-num' });
          i.value = String(view.prefs[key]);
          i.addEventListener('change', () => { const v = Number(i.value); if (Number.isFinite(v) && v >= min && v <= max) { view.prefs[key] = v; savePrefs(key); p.renderEstimate(); } else i.value = String(view.prefs[key]); });
          return h('label', { class: 'pro-field' }, h('span', { text: label }), i, suffix ? h('span', { class: 'pro-suffix', text: suffix }) : null);
        };
        const dia = h('select', { 'aria-label': 'Filament diameter' }, h('option', { value: '1.75', text: '1.75 mm' }), h('option', { value: '2.85', text: '2.85 mm' }), h('option', { value: '3', text: '3 mm' }));
        dia.value = String(view.prefs.diameter);
        mat.addEventListener('change', () => { view.prefs.material = mat.value; savePrefs('material'); p.renderEstimate(); });
        dia.addEventListener('change', () => { view.prefs.diameter = Number(dia.value); savePrefs('diameter'); p.renderEstimate(); });
        const fields = h('div', { class: 'pro-fields' },
          h('label', { class: 'pro-field' }, h('span', { text: 'Material' }), mat),
          numIn('infill', 'Infill', 0, 100, 5, '%'), numIn('wall', 'Walls', 0, 20, 0.1, 'mm'),
          h('label', { class: 'pro-field' }, h('span', { text: 'Filament' }), dia),
          numIn('pricePerKg', 'Price', 0, 100000, 1, 'per kg'));
        if (unitNote) {
          const u = h('select', { 'aria-label': 'Model unit' }, ...['mm', 'cm', 'm', 'in'].map(x => h('option', { value: x, text: x })));
          u.value = view.prefs.unit;
          u.addEventListener('change', () => { view.prefs.unit = u.value; savePrefs('unit'); soupCache = null; p.run(); if (section.on) section.rebuild(); });
          fields.prepend(h('label', { class: 'pro-field' }, h('span', { text: 'Unit' }), u, h('span', { class: 'pro-suffix', text: 'per model unit' })));
        }
        p.est = h('div', { class: 'stats' });
        const probs = r.openEdges + r.nonManifoldEdges + r.flippedEdges;
        const showBtn = probs ? h('button', { type: 'button', 'aria-pressed': String(p.showing), text: 'Mark problems', title: 'Open edges in red, non-manifold and flipped edges in magenta', onclick: () => { p.mark(!p.showing); showBtn.setAttribute('aria-pressed', String(p.showing)); } }) : null;
        const actions = h('div', { class: 'pro-actions' }, showBtn,
          h('button', { type: 'button', text: 'Copy report', onclick: () => vscode.postMessage({ type: 'copy', text: p.markdown() }) }),
          h('button', { type: 'button', text: 'Save .md', onclick: () => vscode.postMessage({ type: 'saveText', kind: 'report-md', text: p.markdown() }) }),
          h('button', { type: 'button', text: 'Save .json', onclick: () => vscode.postMessage({ type: 'saveText', kind: 'report-json', text: p.json() }) }));
        body.append(checks, h('h3', { text: 'Weight and cost (estimate)' }), fields, p.est, actions,
          h('p', { class: 'pro-note small', text: (unitNote ? `${unitNote} ${view.prefs.unit}. ` : '') + 'Walls are printed solid and the inside at the infill. Supports, brim and top and bottom layers are not counted; your slicer gives the exact figure.' }));
        p.renderEstimate();
        if (p.showing) p.mark(true);
      },
      renderEstimate() {
        if (!p.est) return;
        const e = p.estimate(), f = PC.fmtNum;
        p.est.textContent = '';
        const row = (k, v) => h('div', { class: 'row' }, h('span', { class: 'k', text: k }), h('span', { class: 'v', text: v }));
        p.est.append(row('Weight', `${f(e.grams, 1)} g (solid ${f(e.solidGrams, 1)} g)`), row('Filament', `${f(e.filamentMeters, 2)} m`), row('Cost', `${f(e.cost, 2)} at ${f(view.prefs.pricePerKg, 2)} per kg`));
      },
      markdown() { return PC.reportMarkdown(p.result, p.estimate(), { ...p.params(), material: view.prefs.material }, c.name); },
      json() {
        const r = p.result, e = p.estimate();
        return JSON.stringify({
          file: c.name, mmPerModelUnit: mmPerUnit(), sizeMm: [0, 1, 2].map(i => r.max[i] - r.min[i]), volumeCm3: Math.abs(r.volume) / 1000, areaCm2: r.area / 100,
          triangles: r.triangles, watertight: r.watertight, openEdges: r.openEdges, nonManifoldEdges: r.nonManifoldEdges, flippedEdges: r.flippedEdges,
          degenerateTriangles: r.degenerate, shells: r.shells, insideOut: r.inverted,
          estimate: { ...p.params(), grams: e.grams, solidGrams: e.solidGrams, filamentMeters: e.filamentMeters, cost: e.cost },
        }, null, 2) + '\n';
      },
      mark(on) {
        p.showing = on;
        if (problems) { c.root.remove(problems); problems.traverse(o => o.geometry && o.geometry.dispose()); problems = null; }
        if (on && p.result) {
          const s = 1 / mmPerUnit();
          problems = new THREE.Group();
          problems.userData.helper = true;
          const add = (list, color) => {
            if (!list.length) return;
            const g = new THREE.BufferGeometry();
            g.setAttribute('position', new THREE.Float32BufferAttribute(list.map(x => x * s), 3));
            const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, depthTest: false }));
            l.renderOrder = 997; l.userData.helper = true;
            problems.add(l);
          };
          add(p.result.openEdgeList, 0xff2d2d);
          add(p.result.badEdgeList, 0xff38f5);
          c.root.add(problems);
          c.setHint(`Marked ${(p.result.openEdges + p.result.nonManifoldEdges + p.result.flippedEdges).toLocaleString('en-US')} problem edges: open in red, non-manifold and flipped in magenta.`);
        }
        c.invalidate();
      },
    };
    return p;
  })();

  function links() {
    if (view.pro) return null;
    const a = (text, cmd, title) => h('button', { type: 'button', class: 'link', text, title, onclick: () => vscode.postMessage({ type: 'proCmd', cmd }) });
    return h('div', { class: 'pro-links' }, a('Get Zovo Pro', 'getPro', 'USD 19 once, all Zovo viewers'), ' · ', a('Unlock', 'unlock', 'GitHub Sponsors or a license key'), ' · ', a('Hide Pro tools', 'hide', 'Setting modelViewer.showProFeatures'));
  }
  /** Send only the field that changed, so two quick changes can never undo each other. */
  function savePrefs(key) { vscode.postMessage({ type: 'printPrefs', prefs: { [key]: view.prefs[key] } }); }

  // ---------- Section view ----------
  const section = (() => {
    const plane = new THREE.Plane();
    const axisSel = h('select', { 'aria-label': 'Section axis', title: 'Cut along this model axis' }, ...AXES.map((a, i) => h('option', { value: String(i), text: a })));
    const slider = h('input', { type: 'range', min: '0', max: '1000', step: '1', value: '500', 'aria-label': 'Section position' });
    const pos = h('span', { class: 'timetext' });
    const flip = h('button', { type: 'button', text: 'Flip', title: 'Show the other side of the cut', 'aria-pressed': 'false' });
    const read = h('span', { class: 'pro-read' });
    const svg = h('button', { type: 'button', text: 'Save SVG', title: 'Save the outline of the cut as an SVG drawing in millimetres' });
    const close = h('button', { type: 'button', text: 'Close', title: 'Close the section view' });
    const bar = h('div', { class: 'animbar sectionbar', hidden: true }, h('span', { class: 'label', text: 'Section' }), axisSel, slider, pos, flip, read, h('span', { class: 'grow' }), svg, close);
    const s = { bar, on: false, axis: 2, t: 0.5, flipped: false, sec: null, bounds: null, outline: null, caps: [], sides: new Map(), raf: 0 };
    const capMat = new THREE.MeshBasicMaterial({ color: 0xe8743b, side: THREE.BackSide, clippingPlanes: [plane] });

    function bounds() {
      const d = soup().data;
      const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < d.length; i += 3) for (let k = 0; k < 3; k++) { const v = d[i + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v; }
      return { mn, mx };
    }
    function valueMm() { const b = s.bounds; return b.mn[s.axis] + s.t * (b.mx[s.axis] - b.mn[s.axis]); }
    function update() {
      s.raf = 0;
      const span = s.bounds.mx[s.axis] - s.bounds.mn[s.axis];
      // Nudged off the exact value, so a plane through a row of corners still cuts cleanly.
      const v = valueMm() + span * 1.2345e-7;
      const scale = mmPerUnit();
      const n = new THREE.Vector3();
      n.setComponent(s.axis, s.flipped ? 1 : -1);
      plane.copy(new THREE.Plane(n, s.flipped ? -v / scale : v / scale)).applyMatrix4(c.root.matrixWorld);
      s.sec = PC.section(soup().data, s.axis, v);
      if (s.outline) { c.root.remove(s.outline); s.outline.geometry.dispose(); s.outline = null; }
      if (s.sec.segments.length) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(s.sec.segments.map(x => x / scale), 3));
        s.outline = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xffd400, depthTest: false }));
        s.outline.renderOrder = 996; s.outline.userData.helper = true;
        c.root.add(s.outline);
      }
      pos.textContent = `${AXES[s.axis].toLowerCase()} = ${PC.fmtNum(v)} mm`;
      const loops = s.sec.loops.filter(l => l.closed).length;
      read.textContent = s.sec.loops.length
        ? `Area ${PC.fmtNum(s.sec.area / 100)} cm², perimeter ${PC.fmtNum(s.sec.perimeter)} mm, ${loops} ${loops === 1 ? 'outline' : 'outlines'}${s.sec.open ? `, ${s.sec.open} open (the mesh has a hole here)` : ''}`
        : 'The plane misses the model here.';
      svg.disabled = !loops;
      c.invalidate();
    }
    const schedule = () => { if (!s.raf) s.raf = requestAnimationFrame(update); };
    function clip(on) {
      for (const cap of s.caps) cap.parent && cap.parent.remove(cap);
      s.caps = [];
      c.renderer.localClippingEnabled = on;
      c.eachMaterial(m => {
        if (on) { if (!s.sides.has(m)) s.sides.set(m, m.side); m.side = THREE.FrontSide; m.clippingPlanes = [plane]; }
        else { if (s.sides.has(m)) m.side = s.sides.get(m); m.clippingPlanes = null; }
        m.needsUpdate = true;
      });
      if (!on) s.sides.clear();
      if (on) {
        const meshes = [];
        c.model.traverse(o => { if (o.isMesh && !o.isSkinnedMesh && !o.userData.helper) meshes.push(o); });
        for (const o of meshes) {
          const cap = new THREE.Mesh(o.geometry, capMat);
          cap.userData.helper = true;
          cap.raycast = () => {};
          o.add(cap);
          s.caps.push(cap);
        }
      }
    }
    s.open = () => {
      if (!c.model) return;
      if (!c.stats || !c.stats.meshes) { c.setHint('The section view needs a mesh. This file has only points.'); return; }
      ask('section', () => {
        try { s.bounds = bounds(); } catch (e) { c.setHint(e && e.message ? e.message : String(e)); return; }
        s.on = true;
        s.axis = c.upAxis === 'z' ? 2 : 1;
        axisSel.value = String(s.axis);
        bar.hidden = false;
        ui.sectionBtn.setAttribute('aria-pressed', 'true');
        clip(true);
        update();
        used('section');
        c.resize();
        c.setHint('Section: drag the slider to move the cut. The cut face shows in orange.');
      });
    };
    s.close = () => {
      if (!s.on) return;
      s.on = false;
      bar.hidden = true;
      ui.sectionBtn.setAttribute('aria-pressed', 'false');
      clip(false);
      if (s.outline) { c.root.remove(s.outline); s.outline.geometry.dispose(); s.outline = null; }
      c.resize();
      c.invalidate();
    };
    s.rebuild = () => { if (!s.on) return; try { s.bounds = bounds(); clip(true); update(); } catch (e) { c.setHint(e && e.message ? e.message : String(e)); s.close(); } };
    slider.addEventListener('input', () => { s.t = Number(slider.value) / 1000; schedule(); });
    axisSel.addEventListener('change', () => { s.axis = Number(axisSel.value); schedule(); });
    flip.addEventListener('click', () => { s.flipped = !s.flipped; flip.setAttribute('aria-pressed', String(s.flipped)); schedule(); });
    close.addEventListener('click', () => s.close());
    svg.addEventListener('click', () => {
      if (!s.sec) return;
      const text = PC.sectionSvg(s.sec, `${c.name}, section at ${AXES[s.axis].toLowerCase()} = ${PC.fmtNum(valueMm())} mm`);
      if (text) vscode.postMessage({ type: 'saveText', kind: 'section-svg', text });
    });
    return s;
  })();

  // ---------- Turntable export ----------
  const turn = { busy: false, cancel: false, acks: new Map() };
  async function runTurntable(j) {
    if (turn.busy || !c.model) { vscode.postMessage({ type: 'turntableEnd', job: j.job, ok: false, error: 'another export is running' }); return; }
    turn.busy = true; turn.cancel = false;
    const r = c.renderer, cam = c.camera, target = c.controls.target.clone();
    const prev = { pr: r.getPixelRatio(), size: r.getSize(new THREE.Vector2()), pos: cam.position.clone(), aspect: cam.aspect, playing: c.isPlaying() };
    if (prev.playing) c.setPlaying(false);
    const w = j.width, hh = j.height;
    let frames = 0;
    try {
      r.setPixelRatio(1);
      r.setSize(w, hh, false);
      cam.aspect = w / hh;
      cam.updateProjectionMatrix();
      const sph = new THREE.Spherical().setFromVector3(prev.pos.clone().sub(target));
      const theta0 = sph.theta;
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = hh;
      const g2 = canvas.getContext('2d', { willReadFrequently: true });
      const gif = j.format === 'gif' ? G.createGifWriter(w, hh) : null;
      const delay = Math.round((j.seconds * 100) / j.frames);
      for (let i = 0; i < j.frames; i++) {
        if (turn.cancel) throw Object.assign(new Error('stopped'), { cancelled: true });
        sph.theta = theta0 + (i / j.frames) * Math.PI * 2;
        cam.position.setFromSpherical(sph).add(target);
        cam.lookAt(target);
        r.render(c.scene, cam);
        g2.clearRect(0, 0, w, hh);
        g2.drawImage(r.domElement, 0, 0, w, hh);
        if (gif) gif.addFrame(g2.getImageData(0, 0, w, hh).data, delay);
        else {
          const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
          if (!blob) throw new Error('The frame could not be encoded as PNG.');
          const data = new Uint8Array(await blob.arrayBuffer());
          const ack = new Promise((res, rej) => { turn.acks.set(i, { res, rej }); setTimeout(() => rej(new Error('VS Code did not confirm the frame within 30 s.')), 30000); });
          vscode.postMessage({ type: 'turntableFrame', job: j.job, index: i, data });
          await ack;
        }
        frames++;
        c.setHint(`Turntable: frame ${i + 1} of ${j.frames}${gif ? `, ${(gif.size / 1048576).toFixed(1)} MB` : ''}. Esc stops.`);
        await new Promise(res => setTimeout(res, 0));
      }
      if (gif) vscode.postMessage({ type: 'turntableData', job: j.job, data: gif.finish() });
      vscode.postMessage({ type: 'turntableEnd', job: j.job, ok: true, frames });
    } catch (e) {
      vscode.postMessage({ type: 'turntableEnd', job: j.job, ok: false, cancelled: !!(e && e.cancelled), frames, error: e && e.message ? String(e.message).slice(0, 400) : String(e) });
    } finally {
      turn.acks.clear();
      r.setPixelRatio(prev.pr);
      r.setSize(prev.size.x, prev.size.y, false);
      cam.aspect = prev.aspect;
      cam.updateProjectionMatrix();
      cam.position.copy(prev.pos);
      cam.lookAt(target);
      c.controls.update();
      if (prev.playing) c.setPlaying(true);
      turn.busy = false;
      c.resize();
      c.invalidate();
    }
  }
  window.addEventListener('keydown', e => { if (turn.busy && e.key === 'Escape') { turn.cancel = true; e.preventDefault(); e.stopPropagation(); } }, true);

  // ---------- toolbar, panel, state ----------
  ui.sectionBtn = h('button', { type: 'button', title: 'Section view: cut the model with a plane and measure the cut (Zovo Pro)', 'aria-pressed': 'false', onclick: () => (section.on ? section.close() : section.open()) }, 'Section ', badge());
  ui.turnBtn = h('button', { type: 'button', title: 'Turntable export: save a 360 degree turn as a GIF or PNG frames (Zovo Pro)', onclick: () => { if (!turn.busy) vscode.postMessage({ type: 'proAsk', feature: 'turntable' }); } }, 'Turntable ', badge());

  function applyView() {
    const show = view.shown || view.pro;
    for (const b of [ui.sectionBtn, ui.turnBtn]) b.hidden = !show;
    print.el.hidden = !show;
    const lab = f => (view.features[f] && view.features[f].label) || '';
    const set = (btn, f) => { const b = btn.querySelector('.pro-badge'); if (!b) return; b.hidden = view.pro || allowedHere(f); b.textContent = 'PRO'; b.title = lab(f) || 'Zovo Pro'; };
    set(ui.sectionBtn, 'section'); set(ui.turnBtn, 'turntable');
    const pb = print.el.querySelector('h2 .pro-badge');
    if (pb) { pb.hidden = view.pro || allowedHere('print'); pb.title = lab('print'); }
    if (!print.result && !print.running) print.intro();
  }

  applyView(); // hidden until the host sends the Pro state

  return {
    sectionBar: section.bar,
    panel: print.el,
    busy: () => turn.busy,
    modelChanged,
    loaded() { applyView(); },
    onMessage(m) {
      if (m.type === 'pro') {
        view.shown = !!m.shown; view.pro = !!m.pro; view.features = m.features || {};
        view.granted = Array.isArray(m.granted) ? m.granted.slice() : [];
        if (m.prefs) view.prefs = { ...view.prefs, ...m.prefs };
        applyView();
        return true;
      }
      if (m.type === 'proGo') { const run = waiting[m.feature]; delete waiting[m.feature]; if (run) run(); return true; }
      if (m.type === 'turntable') { runTurntable(m); return true; }
      if (m.type === 'turntableAck') {
        const a = turn.acks.get(m.index);
        if (a) { turn.acks.delete(m.index); if (m.error) a.rej(new Error(m.error)); else a.res(); }
        return true;
      }
      return false;
    },
    probe: () => ({ view: { ...view }, print: print.result ? { watertight: print.result.watertight, volume: print.result.volume, area: print.result.area, openEdges: print.result.openEdges, shells: print.result.shells } : null, section: section.on ? { axis: section.axis, area: section.sec && section.sec.area, loops: section.sec && section.sec.loops.length } : null, turntableBusy: turn.busy }),
  };
}
