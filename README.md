# LiDAR Point-Cloud Viewer

UI-free foundation for a browser LiDAR viewer. The core keeps typed-array point
data, LOD creation and selection independent from Three.js; the Three adapter is
only responsible for GPU resources and draw configuration.

## Current scope

- Immutable typed-array point clouds with bounds and optional RGB/intensity data
- Deterministic procedural terrain/structure cloud generator
- Voxel-grid decimation and a precomputed LOD pyramid
- Point-budget LOD selection and transaction-safe loading session
- Three.js `Points` adapter using a custom shader material
- A UI-free `LidarViewer` composition root with one render loop and OrbitControls

React, controls, drag-and-drop and CSS are intentionally not implemented yet.

## Development

```sh
npm install
npm run typecheck
npm test
```
