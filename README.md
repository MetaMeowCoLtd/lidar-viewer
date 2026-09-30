# Vertex LiDAR

Open, analyse and measure LiDAR scans in the browser. Everything runs on your
device: no upload, no account.

**Live:** https://metameowcoltd.github.io/lidar-viewer/

## Features

**Open**
- LAS, LAZ and PLY, recognised from the file itself. Large scans stream on a
  worker with progress; scans over 60 million points are thinned evenly to fit.
- Georeferenced scans keep their coordinate system from import to export.

**Analyse** – one "Analyze scan" button runs every step; each can also run on its own.
- **Noise**: stray and low points found the way PDAL does, labelled as ASPRS
  classes 7 and 18, hidden or highlighted, and left out of a cleaned export.
- **Ground and terrain**: ground classified, every point's height above ground
  measured, and a shaded terrain surface with contour lines.
- **Buildings and trees**: each one found, outlined and measured: footprint,
  height and crown.
- **Survey quality**: density against the USGS quality levels, data voids,
  flat-surface precision, flight-strip alignment and, with checkpoints from a
  CSV, vertical accuracy. A pass/fail verdict per check, viewable in the app or
  downloadable as a self-contained HTML report.
- **WebGPU**: noise and ground detection and voxel thinning run as compute
  shaders when available, with a CPU fallback and a benchmark page at
  `#/benchmark`.

**Measure** – tools work the way a DCC or survey package does: the cursor
shows where a click will snap before it is made, what is being drawn follows
it live, handles light up under the cursor, and every change can be undone.
- **Inspect** (I) a point for its coordinates, class, height above ground,
  return and flight line, and the building or tree it belongs to.
- **Rulers** (M): as many as needed, each giving distance, height difference and
  slope; drag an end to adjust it and it snaps to the scan. While placing the
  end, X, Y or Z holds it to east, north or the vertical and Shift+Z keeps it
  level, as in Blender: from a point on the street, Z and a hover over the
  eaves gives a building's height.
- **Area and volume** (P): click a polygon corner by corner and finish with
  Enter, a right click or a click on the first corner. It reports plan and
  surface area and perimeter, and the volume between the scan and a base -
  through the corners, a fitted plane, the lowest, mean or highest corner, or
  an elevation - as cut, fill and net, like stockpile tools. Drag the blue
  arrow to extrude it into a prism (volume, and how much the scan fills), the
  grey one to move its base; Ctrl snaps to whole metres, and a number typed
  after a drag sets the value exactly. Drag corners, drag a midpoint to add
  one, Delete to remove one.
- **Pick a surface** (R): click a roof, a yard or a road to outline the
  continuous surface under the click, with its plan area, sloped area and
  pitch. Surfaces that overlap or touch can be merged.
- Ctrl+Z and Ctrl+Shift+Z undo and redo, F frames what is selected, and
  measurements stay on the scan whichever tool is in hand.

**View**
- Colour by RGB, intensity, height, relief, class, height above ground, object
  or flight line. Flight lines can be shown one at a time from the legend.
- Unreal Engine-style navigation: left-drag walks, right-drag looks (WASD/QE to
  fly, wheel for speed), middle-drag pans, Alt + left orbits, double-click flies
  to a point. The cursor is locked while dragging.
- Precomputed levels of detail and an adjustable point budget keep tens of
  millions of points fluid.
- Light and dark themes.

**Export**
- Classified LAS 1.4 (with heights above ground and object ids), cleaned LAS,
  class summary CSV, building and tree inventory CSV, GeoJSON footprints and
  treetops, GeoTIFF elevation model, GeoJSON contours, and the measurements as
  GeoJSON - rulers, polygons with their areas and volumes, and surfaces.

## Sample surveys

Real, openly licensed scans in the Samples menu, each with an About note on
where it comes from and what it is useful for. They are cropped (and some
thinned evenly) for the web; flight lines are recovered from GPS time where the
source lacks them.

| Sample | Scan | Source and licence |
|---|---|---|
| Tokyo Tower (default) | Aircraft, 920 × 610 m, 5.6M points | Tokyo Metropolitan Government, [Digital Twin Project point cloud](https://www.geospatial.jp/ckan/dataset/tokyopc-23ku-2024) (2024), CC BY 4.0 |
| Sheffield Hallam University | Aircraft, 1,200 × 1,000 m, 3.4M points | Environment Agency, [National LIDAR Programme](https://environment.data.gov.uk/dataset/2e8d0733-4f43-48b4-9e51-631c25d1b0a9) (2021), Open Government Licence v3.0 |
| Tree wheel, British Columbia | DJI L3, 85 × 85 m, 3.2M points | McGlade, Irwin, Russell, Coops (2026), [doi:10.5281/zenodo.19006903](https://doi.org/10.5281/zenodo.19006903), CC BY 4.0 |
| Stream corridor, Virginia | DJI L1, 230 × 150 m, 4.1M points | Hession, Lehmann, Resop, Kobayashi (2026), [doi:10.5069/G9J67F57](https://doi.org/10.5069/G9J67F57), CC BY 4.0 |
| Vineyard, Galicia | DJI L1, 94 × 127 m, 3.5M points | Vélez, Ariza-Sentís, Valente (2023), [doi:10.5281/zenodo.8113105](https://doi.org/10.5281/zenodo.8113105), CC BY 4.0 |
| City campus, Munich | DJI L2, 250 × 190 m, 4.1M points | Anders, Wang, Wysocki, Huang, Liu (2025), [doi:10.5281/zenodo.15282970](https://doi.org/10.5281/zenodo.15282970), CC BY 4.0 |

## Development

```sh
npm install
npm run dev        # local server
npm test           # unit tests
npm run typecheck
npm run build      # static site in dist/
```

Pushes to `main` are built, tested and deployed to GitHub Pages. The design and
module boundaries are described in [ARCHITECTURE.md](ARCHITECTURE.md).
