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
- Colour by height, RGB, intensity, relief, ASPRS class, height above ground, object or flight line (LAS point source ID), the last to see each pass of the aircraft and where passes overlap
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
- Real drone LiDAR surveys as samples, picked from the Samples menu, each with an "About this sample" note on where it comes from and the work it stands for. All are CC BY 4.0, cropped and thinned evenly for the web (`public/samples/`), with flight lines recovered from GPS time where the source files lack them:
  - Stream corridor, Virginia (default): a 230 × 150 m patch of Virginia Tech's StREAM Lab, DJI Matrice 350 RTK with a Zenmuse L1, August 2024, 4.1 million points. Hession, W., Lehmann, L., Resop, J., Kobayashi, Y. (2026), Virginia Tech StREAM Lab Summer 2024 Drone Lidar Survey, OpenTopography, https://doi.org/10.5069/G9J67F57
  - Vineyard, Galicia: a 94 × 127 m vineyard block in Tomiño, Spain, DJI Matrice 300 RTK with a Zenmuse L1 at 30 m, July 2022, 3.5 million points, unclassified. Vélez, S., Ariza-Sentís, M., Valente, J. (2023), VineLiDAR, Zenodo, https://doi.org/10.5281/zenodo.8113105
- Flight lines: colour by LAS point source ID and pick lines from the legend (click to hide, Alt+click to see one alone) to inspect a pass and its overlap with its neighbours
- A simulated drone survey of a factory site, kept for the benchmark page and tests (a DJI L2-style flight: 70° line scan, 20% side overlap, multiple returns, intensity, EPSG:25830)
- Voxel-grid decimation and a precomputed LOD pyramid
- Point-budget LOD selection and transaction-safe loading session
- Three.js `Points` adapter using a custom shader material
- A UI-free `LidarViewer` composition root with one render loop and Unreal Engine-style navigation: left-drag walks, right-drag looks (with WASD/QE to fly and the wheel for speed), middle-drag pans, Alt + left orbits the point under the cursor, the wheel zooms to the cursor and double-click flies to a point
- A landing page at `#/` and a workspace at `#/app`: one side panel with the
  scan, an "Analyze scan" button that runs noise, ground, terrain and object
  detection in order, and a card per result carrying its own layer controls; a
  Display menu for point size, shape and detail; a full-window viewport with
  its own toolbar, colour menu, legend and inspector; and a status line
- Noise clean-up the way PDAL does it: isolated points (radius filter) and low
  outliers (ELM) labelled as ASPRS classes 7 and 18, hidden or highlighted in
  the view, and left out of a "cleaned" LAS export
- Light and dark themes, following the system until one is chosen
- A survey quality report: first-return density against the USGS quality
  levels, coverage gaps, vertical offsets between overlapping flight strips
  (from LAS point source IDs), noise share, and RMSEz / 95% vertical accuracy
  at checkpoints loaded from CSV; viewed in the app or downloaded as HTML
- WebGPU compute: the noise filter's neighbour search, the ground filter's
  surface openings and voxel thinning as WGSL shaders, used by the analyses
  when WebGPU is available (CPU fallback), and a benchmark page at
  `#/benchmark` comparing both paths for speed and agreement

Everything runs in the browser. No scan data is uploaded.

## Development

```sh
npm install
npm run typecheck
npm test
```
