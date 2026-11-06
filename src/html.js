'use strict';
// Builds the webview HTML. Kept free of the vscode module so tests can check the CSP.
const crypto = require('crypto');
const { footerHtml, FOOTER_CSS } = require('./support');

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * @param {{cspSource:string, scriptUri:string, styleUri:string, title:string, nonce?:string, showSupportLinks?:boolean}} p
 * showSupportLinks false hides the small Sponsor and More free viewers line (setting modelViewer.showSupportLinks).
 */
function buildHtml(p) {
  const n = p.nonce || crypto.randomBytes(24).toString('base64url');
  // The webview script moves this line into the status bar once the viewer is built.
  const footer = footerHtml('modelViewer', p.showSupportLinks !== false, 'zovo-support-fixed');
  // connect-src: the model file and its .bin/.mtl/texture neighbours (webview resource origin), plus data: and blob:
  // URLs that glTF uses for embedded buffers and images. No remote origin is allowed anywhere.
  const csp = [
    "default-src 'none'", `style-src ${p.cspSource} 'nonce-${n}'`, `script-src 'nonce-${n}'`,
    `img-src ${p.cspSource} data: blob:`, `connect-src ${p.cspSource} data: blob:`, `font-src ${p.cspSource}`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${escapeAttr(p.styleUri)}">
${footer ? `<style nonce="${n}">${FOOTER_CSS}</style>` : ''}
<title>${escapeAttr(p.title)}</title>
</head>
<body>
<div id="app"><p class="loading">Opening the model...</p></div>
${footer}
<script nonce="${n}" src="${escapeAttr(p.scriptUri)}"></script>
</body>
</html>`;
}

module.exports = { buildHtml, escapeAttr };
