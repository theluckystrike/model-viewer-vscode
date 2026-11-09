'use strict';
// STL Viewer Pro features (lane PRO4) on the shared Zovo license module (src/license, copied unchanged from
// factory/sprint/license) and the gate in src/pro-gate.js: 3 free tries per feature, no prompt on open, no network
// except what the user starts. Everything that was free in 0.1.x stays free.
const { createLicense } = require('./license');
const { createProGate } = require('./pro-gate');

const SKU = '3d-pro';
const FEATURES = {
  print: {
    title: 'Print check',
    detail: 'Checks a part before you slice it: volume, surface area and size, whether it is watertight, with open, non-manifold and flipped edges marked on the model, the number of separate parts, and the weight, filament length and material cost for PLA, PETG, ABS and other materials at your infill. Copy or save the report as Markdown or JSON. One free try covers one open file tab.',
  },
  section: {
    title: 'Section view',
    detail: 'Cuts the model with a plane along X, Y or Z that you move with a slider and shows the inside in colour, with the area and perimeter of the cut. Save the outline of the cut as an SVG drawing in millimetres. One free try covers one open file tab.',
  },
  turntable: {
    title: 'Turntable export',
    detail: 'Saves a 360 degree turn of the model as an animated GIF for a README, a pull request or a shop page, or as numbered PNG frames, with the view, lights and background you set. Each saved export uses one free try.',
  },
};
const FREE_LINE = 'Everything else in STL Viewer stays free: opening STL, OBJ, PLY, GLB, glTF and 3MF, measuring, wireframe, normals, bounds, the scene tree, animations and screenshots.';

function createPro({ vscode, context, license, enabled }) {
  return createProGate({ vscode, context, license, createLicense, sku: SKU, prefix: 'modelViewer', product: 'STL Viewer', features: FEATURES, freeLine: FREE_LINE, enabled });
}

module.exports = { createPro, FEATURES, SKU, FREE_LINE };
