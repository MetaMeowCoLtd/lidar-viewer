# LiDAR Point-Cloud Viewer

UI-free foundation for a browser LiDAR viewer. The core keeps typed-array point
data, LOD creation and selection independent from Three.js; the Three adapter is
only responsible for GPU resources and draw configuration.

## Current scope

- LAS, LAZ and PLY readers, dispatched on the file's own leading bytes
- Georeferenced scans held in a local frame with a double-precision origin
- ASPRS classification and per-pulse return fields, carried through decimation
- Ground detection on a worker: classifies ground and low noise, and measures
  every point's height above ground, without overwriting existing classes
- Colour by height, RGB, relief, ASPRS class or height above ground
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
