# LiDAR Point-Cloud Viewer

UI-free foundation for a browser LiDAR viewer. The core keeps typed-array point
data, LOD creation and selection independent from Three.js; the Three adapter is
only responsible for GPU resources and draw configuration.

## Current scope

- LAS, LAZ and PLY readers, dispatched on the file's own leading bytes
- Large scans load on a worker, read from disk in slices with progress, so the
  page stays responsive and a file is never held in memory whole. Scans over
  `maxImportPoints` (60 million by default) are thinned evenly to fit rather
  than refused; LAZ files are limited to 1.9 GB by the decoder's memory
- Georeferenced scans held in a local frame with a double-precision origin
- ASPRS classification and per-pulse return fields, carried through decimation
- Ground detection on a worker: classifies ground and low noise, and measures
  every point's height above ground, without overwriting existing classes
- Building and tree counting on a worker: finds each building and tree,
  labels its points, traces its footprint or crown, and draws the outlines
- Colour by height, RGB, relief, ASPRS class, height above ground or object
- Click any point to read its map coordinates, class, height above ground and
  the building or tree it belongs to; click two points to measure the
  straight-line, horizontal and vertical distance and slope between them
- Export, made on the device: a CSV inventory of buildings and trees, a GeoJSON
  map layer of footprints and treetops, a CSV class summary, and a classified
  LAS 1.4 file carrying heights above ground and object ids as extra bytes.
  Positions stay in the scan's own coordinate system, whose definition is
  carried from the source file into the LAS export. LAS output is uncompressed:
  the bundled laz-perf can read LAZ but not write it
- Immutable typed-array point clouds with bounds and optional RGB/intensity data
- Deterministic procedural terrain/structure cloud generator
- Voxel-grid decimation and a precomputed LOD pyramid
- Point-budget LOD selection and transaction-safe loading session
- Three.js `Points` adapter using a custom shader material
- A UI-free `LidarViewer` composition root with one render loop and OrbitControls
- A React control surface with drag-and-drop import, held outside scene state

Everything runs in the browser. No scan data is uploaded.

## Development

```sh
npm install
npm run typecheck
npm test
```
