# Changelog

## 0.2.0 (2026-11-09)

- New, optional Zovo Pro tools, each with 3 free tries on your computer:
  - Print check: size, volume, surface area, watertight or not (open, non-manifold and flipped edges, zero-area triangles, separate parts), problem edges marked on the model, and weight, filament length and material cost for 8 materials at your infill. Copy, or save as Markdown or JSON.
  - Section view: cut the model along X, Y or Z with a slider, see the cut face, read its area and perimeter, and save the outline as an SVG in millimetres.
  - Turntable export: a 360 degree GIF (480 to 800 pixels) or 72 PNG frames, with your view and background.
- Everything that was free stays free: opening all six formats, measuring, the helpers, shading, the scene tree, animations, Copy and Screenshot. Nothing about Pro shows when a file opens. `modelViewer.showProFeatures: false` hides the Pro tools.
- Zovo Pro is USD 19 once for every Zovo viewer: GitHub Sponsors, or PayPal for a license key. New commands: Get Zovo Pro, Unlock Zovo Pro with GitHub Sponsors, Enter Zovo Pro License Key, Remove Zovo Pro from This Editor.
- The rating question now counts 2 models in 2 sessions at least 4 hours apart, also in a window that stays open, and "Rate it" opens Open VSX in Cursor, Windsurf and VSCodium. Rate comes first in the footer.
- STL files whose facet normals are all zero (many exporters write them that way) no longer draw black: the normals are computed, and the status line says so.
- "More free viewers" starts with the Zovo extensions most related to this one. The README names the custom format work offer.

## 0.1.8 (2026-11-09)

- PayPal is now in the footer links and in the README "Support Zovo" section, next to GitHub Sponsors. Both are optional; the viewer works the same without them.
- README: a short "Free and Zovo Pro" note. This viewer stays free and complete; nothing in it becomes paid.
- No change to how files open or look.

## 0.1.6 (2026-11-08)

- The rating question now comes after 3 models that opened without an error, on 2 different days, and never after an error. "Later" asks one more time after 7 days, "No thanks" ends it, and it never asks more than 2 times. `modelViewer.askForRating: false` turns it off. Nothing else changed.

## 0.1.5 (2026-11-08)

- The "More free viewers" list and the README now use the current Marketplace names and include the newest Zovo extensions: ZIP, GCode, EPUB, HAR, font and audio viewers.

## 0.1.4 (2026-11-07)

- The Marketplace name is now "STL Viewer, OBJ Viewer, GLB & glTF Viewer" (it was "STL Viewer, OBJ Viewer & glTF 3D Model Viewer"). The extension id, commands and settings stay the same.

## 0.1.3 (2026-11-07)

- The Marketplace name is now "STL Viewer, OBJ Viewer & glTF 3D Model Viewer" (it was "3D Model Viewer (GLB, glTF, STL, OBJ, PLY)"), so it matches what people type in the Extensions search. The extension id, commands and settings stay the same.
- The Marketplace description now starts with "STL viewer, OBJ viewer, GLB viewer and glTF viewer for 3D models in VS Code".
- Marketplace search keywords updated, with the phrases people search for first.

## 0.1.2 (2026-11-07)

- "More free viewers" now starts with the Zovo extensions most related to this one. Picking one opens its Marketplace page, where you choose to install it.
- The README has a "Support Zovo" section with GitHub Sponsors and the developer's GitHub profile, and "More tools by Zovo" lists related extensions.

## 0.1.1 (2026-11-06)

- The status line at the bottom of the viewer has two small links, "Sponsor" (GitHub Sponsors) and "More free viewers". The new setting `modelViewer.showSupportLinks` (default `true`) hides them, and so does the "Hide" link next to them. There is no popup, and nothing is sent anywhere.
- New commands "3D Model Viewer: Support the developer" and "3D Model Viewer: More free viewers". The second one lists the other Zovo extensions and installs only the one you pick. Ones that are not on the Marketplace yet open their GitHub page.
- The listing gets a Sponsor button. The README has a short Support section and lists all Zovo extensions.
- The "More free viewers" list and the README list now show the 15 Zovo extensions on the Marketplace under their current names, and 11 that are coming soon.
- Extensions for related files now come first, starting with DXF Viewer & CAD Viewer for 2D Drawings.

## 0.1.0

- First release. Opens .glb, .gltf, .stl, .obj (with its .mtl), .ply and .3mf files as a read-only custom editor.
- Orbit, pan, zoom and fit to view, with grid, axes, wireframe, vertex normals and bounding box toggles, smooth or flat shading and a theme, dark or light background.
- glTF animations with a clip picker, play and pause, and a time slider. A scene tree with visibility toggles.
- Model stats (vertices, triangles, materials, textures and size), a two-point distance measure and PNG screenshots.
- Files over 1 GB show a message and are not read.
