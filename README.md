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
- A 3D terrain model built from the ground points: a shaded surface with
  contour lines, exported as a GeoTIFF elevation model and GeoJSON contours
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
- A synthetic drone LiDAR survey as the sample: a manufacturing plant and its surroundings (as-built, expansion topography, stockpiles), made by simulating a DJI L2-style flight (70° line scan, 20% side overlap, multiple returns, intensity, georeferenced in EPSG:25830)
- Voxel-grid decimation and a precomputed LOD pyramid
- Point-budget LOD selection and transaction-safe loading session
- Three.js `Points` adapter using a custom shader material
- A UI-free `LidarViewer` composition root with one render loop and 3D-app navigation: turn around the point under the cursor, right-drag to pan, zoom to the cursor, double-click to fly to a point, WASD or arrows and Q/E to move once the view has focus
- A landing page at `#/` and a workspace at `#/app`: one side panel with the
  scan, an "Analyze scan" button that runs noise, ground, terrain and object
  detection in order, and a card per result carrying its own layer controls; a
  Display menu for point size, shape and detail; a full-window viewport with
  its own toolbar, colour menu, legend and inspector; and a status line
- Noise clean-up the way PDAL does it: isolated points (radius filter) and low
  outliers (ELM) labelled as ASPRS classes 7 and 18, hidden or highlighted in
  the view, and left out of a "cleaned" LAS export
- Light and dark themes, following the system until one is chosen

Everything runs in the browser. No scan data is uploaded.

## Development

```sh
npm install
npm run typecheck
npm test
```
