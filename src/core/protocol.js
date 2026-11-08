'use strict';
// Shared by the extension host, the webview bundle and the tests. No vscode import here.

const MB = 1024 * 1024;
const FORMATS = { glb: 'glb', gltf: 'gltf', stl: 'stl', obj: 'obj', ply: 'ply', '3mf': '3mf' };
const UNITS = { glb: 'm', gltf: 'm', '3mf': 'mm' };

function formatOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  return m ? FORMATS[m[1].toLowerCase()] || null : null;
}

function fmtSize(n) {
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n < 1024) return `${n} B`;
  if (n < MB) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * MB) return `${(n / MB).toFixed(1)} MB`;
  return `${(n / (1024 * MB)).toFixed(1)} GB`;
}

/** Decide whether a file is loaded. Files over the limit get a clear message and are never read. */
function sizePlan(size, maxFileMB) {
  const limitMB = Number.isFinite(maxFileMB) && maxFileMB > 0 ? Math.min(maxFileMB, 4096) : 1024;
  if (size > limitMB * MB) {
    return {
      load: false, limitMB,
      message: `This file is ${fmtSize(size)}. 3D Model Viewer opens files up to ${fmtSize(limitMB * MB)} so VS Code stays responsive (setting modelViewer.maxFileMB). The file was not read.`,
    };
  }
  return { load: true, limitMB };
}

const isBytes = v => v instanceof Uint8Array;
const str = (v, max) => typeof v === 'string' && v.length <= max;

/** Only known webview messages pass, with checked fields. Everything else is dropped. */
function validateWebviewMessage(m) {
  if (!m || typeof m !== 'object' || typeof m.type !== 'string') return { ok: false };
  switch (m.type) {
    case 'ready':
    case 'needBytes':
      return { ok: true, msg: { type: m.type } };
    case 'rendered':
      return { ok: true, msg: { type: 'rendered' } };
    case 'failed':
      return { ok: true, msg: { type: 'failed' } };
    case 'screenshot': {
      if (!isBytes(m.data) || m.data.length < 8 || m.data.length > 200 * MB) return { ok: false };
      const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
      if (!sig.every((b, i) => m.data[i] === b)) return { ok: false };
      return { ok: true, msg: { type: 'screenshot', data: m.data } };
    }
    case 'copy':
      if (!str(m.text, 100000)) return { ok: false };
      return { ok: true, msg: { type: 'copy', text: m.text } };
    default:
      return { ok: false };
  }
}

function ascii(bytes, n) {
  let s = '';
  for (let i = 0; i < Math.min(n, bytes.length); i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/**
 * Check the first bytes before a loader runs, so a wrong or broken file gives a plain message
 * instead of a parser stack trace. Returns { ok, reason?, detail? }.
 */
function sniff(bytes, fmt) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length === 0) return { ok: false, reason: 'The file is empty.' };
  let head = ascii(b, 512);
  if (head.startsWith('\xEF\xBB\xBF')) head = head.slice(3); // UTF-8 byte order mark before JSON
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  switch (fmt) {
    case 'glb': {
      if (head.slice(0, 4) !== 'glTF') {
        if (/^\s*\{/.test(head)) return { ok: true, detail: 'json' }; // a .glb that is really JSON glTF
        return { ok: false, reason: 'This is not a GLB file: it does not start with "glTF".' };
      }
      const version = b.length >= 8 ? dv.getUint32(4, true) : 0;
      if (version !== 2) return { ok: false, reason: `This GLB file is version ${version}. Only glTF 2.0 is supported.` };
      const len = b.length >= 12 ? dv.getUint32(8, true) : 0;
      if (len > b.length) return { ok: false, reason: `The GLB file is cut off: the header says ${len} bytes and the file has ${b.length}.` };
      return { ok: true, detail: 'binary' };
    }
    case 'gltf':
      if (head.slice(0, 4) === 'glTF') return { ok: true, detail: 'binary' };
      if (!/^\s*\{/.test(head)) return { ok: false, reason: 'This is not a glTF file: it is not JSON.' };
      return { ok: true, detail: 'json' };
    case 'stl': {
      if (b.length >= 84) {
        const n = dv.getUint32(80, true);
        if (84 + n * 50 === b.length) return { ok: true, detail: 'binary', triangles: n };
      }
      if (/^\s*solid[\s\S]*facet/i.test(ascii(b, 4096)) || /^\s*solid\b/i.test(head)) return { ok: true, detail: 'ascii' };
      if (b.length >= 84) return { ok: true, detail: 'binary', warning: 'The triangle count in the header does not match the file size.' };
      return { ok: false, reason: 'This is not an STL file: it is too short for binary STL and does not start with "solid".' };
    }
    case 'ply': {
      if (!/^ply\r?\n/.test(head)) return { ok: false, reason: 'This is not a PLY file: it does not start with "ply".' };
      const fm = /format\s+(ascii|binary_little_endian|binary_big_endian)/.exec(head);
      if (!fm) return { ok: false, reason: 'The PLY header has no known format line.' };
      if (!/end_header/.test(ascii(b, 65536))) return { ok: false, reason: 'The PLY header has no end_header line.' };
      const v = /element\s+vertex\s+(\d+)/.exec(head); const f = /element\s+face\s+(\d+)/.exec(head);
      return { ok: true, detail: fm[1], vertices: v ? Number(v[1]) : 0, faces: f ? Number(f[1]) : 0 };
    }
    case '3mf':
      if (head.slice(0, 2) !== 'PK') return { ok: false, reason: 'This is not a 3MF file: 3MF files are ZIP packages and this one does not start with "PK".' };
      return { ok: true };
    case 'obj': {
      let bin = 0;
      for (let i = 0; i < Math.min(b.length, 4096); i++) if (b[i] === 0) bin++;
      if (bin > 0) return { ok: false, reason: 'This is not an OBJ file: it contains binary data.' };
      return { ok: true };
    }
    default:
      return { ok: false, reason: 'Unknown file type.' };
  }
}

/** mtllib names from OBJ text (first 2 MB is enough, they are at the top). Plain file names only. */
function mtlLibs(text) {
  const out = [];
  const re = /^\s*mtllib\s+(.+?)\s*$/gm;
  let m;
  while ((m = re.exec(text)) && out.length < 8) {
    const name = m[1].trim();
    if (name && !/^[a-z][a-z0-9+.-]*:/i.test(name) && !name.startsWith('/') && !name.split(/[\\/]/).includes('..')) out.push(name.replace(/\\/g, '/'));
  }
  return out;
}

module.exports = { MB, FORMATS, UNITS, formatOf, fmtSize, sizePlan, validateWebviewMessage, sniff, mtlLibs };
