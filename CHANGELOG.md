# Changelog

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
