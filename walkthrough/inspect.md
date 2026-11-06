# Inspect the mesh

| Button | Key | What it shows |
|---|---|---|
| Grid | G | A ground grid under the model. The panel lists the cell size. |
| Axes | A | The model axes: X red, Y green, Z blue. |
| Wireframe | W | Triangle edges. |
| Normals | N | Vertex normals in cyan, for models up to 250,000 vertices. |
| Bounds | B | The bounding box. The status bar gives its size. |

Shading has three choices. "As stored" uses the normals in the file. "Smooth" merges shared corners and averages the normals, which helps STL and OBJ files that store each triangle on its own. "Flat" shows every triangle.
