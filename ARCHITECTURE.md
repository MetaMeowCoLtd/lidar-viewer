# Architecture decisions

The implementation is deliberately split into a framework-independent core and
an imperative Three.js adapter. React is a control surface for these classes,
not an owner of scene state. This protects the render loop from React
reconciliation and keeps the data pipeline worker-ready.

```
PointCloud (typed arrays, metadata, bounds)
  ├─ ProceduralCloudGenerator   → simulated drone survey (sample and tests)
  ├─ LAS / LAZ / PLY readers    → local scan sources
  ├─ detectNoise (worker)       → noise classes 7 and 18
  ├─ detectGround (worker)      → ground class + height above ground
  ├─ detectObjects (worker)     → buildings, trees, object ids and outlines
  ├─ buildTerrainModel (worker) → terrain grid and contour lines
  ├─ buildQualityReport (worker) → USGS density, voids, precision, strips, accuracy
  ├─ gpu/ (WebGPU, optional)    → noise search and ground openings as compute shaders
  ├─ writeLas / inventory       → LAS 1.4, CSV, GeoJSON, GeoTIFF and HTML report
  └─ PointCloudLodPyramid
       └─ VoxelGridDownsampler → precomputed tiers
            └─ LidarViewer → one RAF loop, camera and NavigationControls
                 └─ ThreePointCloudRenderer → GPU geometries + shader
```

## Core invariants

- One point is one xyz triplet. Optional RGB and intensity arrays have the same
  point index and are validated when a cloud is created.
- Channels split into two kinds. Position, colour, intensity and height
  above ground are continuous and are averaged when a tier is decimated. Classification and the
  return fields are categorical: a voxel holding ground and building points has
  no meaningful mean class, and rounding one would invent a code describing
  neither, so those take a streaming majority vote that can only return a value
  the voxel actually contained.
- A cloud's `bounds` must bracket its own points. Readers measure the stored
  `Float32`, not the double that produced it, because that narrowing can move a
  coordinate just outside its own source value and spatial indexing then
  addresses a cell that was never counted.
- Positions are local coordinates, offset from a double-precision `origin`.
  Projected survey coordinates do not survive a narrowing to `Float32`, so the
  frame is established by the reader while values are still doubles, and every
  stage downstream works in small numbers. Readers also convert to the viewer's
  Y-up axes, negating north so the frame stays right-handed.
- The domain layer is independent of DOM, React, and Three.js, so heavy import
  and decimation work can move to a worker without changing its contract.
- A LOD pyramid contains complete precomputed tiers. Selecting a point budget
  only swaps an existing `BufferGeometry`; it never allocates or decimates in a
  frame.
- `PointCloudSession` uses monotonically increasing request IDs. A stale import
  is unable to overwrite the newest successful load.
- `ThreePointCloudRenderer` is an explicit resource owner. It disposes geometry
  and material resources when a cloud is replaced or the host unmounts.

## Ground detection

`detectGround` implements the Simple Morphological Filter (Pingel, Clarke and
McBride, 2013) with PDAL's `filters.smrf` defaults, so results are directly
comparable with the standard desktop tooling. It lowest-surfaces the scan onto
a grid, opens that surface with a window growing one cell at a time to strip
off anything narrower than the window, rebuilds terrain under what was removed,
and accepts points within a slope-scaled tolerance of it.

Three departures from the paper, each for real scan data:

- The window is square. Openings then separate into row and column passes
  using the van Herk / Gil-Werman method, so each costs the same at every
  radius instead of growing with its square.
- Openings extend the terrain past the edge of the grid instead of clipping.
  A clipped window cannot see a slope rising beyond the uphill edge of a tile
  and marks real ground there as an object.
- Pits of one or two cells are lifted from the lowest surface before filtering,
  because an opening removes bumps but not pits, and a single low outlier would
  otherwise crater the ground around it. Candidates are grouped into connected
  patches first so a ditch or a hollow is never mistaken for one.

Only points that are unclassified, never classified, or already ground are
reassigned; a class someone else assigned is never overwritten. Detection runs
on its own worker with the positions copied rather than transferred, so the
cloud stays drawable while it works, and `LidarViewer.replaceCloud` swaps the
enriched cloud in without moving the camera.

On a synthetic 240 m suburb with rolling terrain, buildings, trees and deep
outliers, the filter rejects no ground, accepts under 0.5% of object points as
ground, and labels every outlier as noise. A square kilometre at eight points
per square metre takes about 2.5 seconds. Synthetic scores are an upper bound:
real scans with dense vegetation, embankments and very large flat roofs will do
worse, and roofs wider than twice the largest window are indistinguishable from
terrain to any filter of this kind.

## Building and tree detection

`detectObjects` works top-down, on a grid of everything standing more than two
metres above the ground, sized so each cell holds about four points. No trained
model is involved; three measurable signals separate a roof from a canopy:

- Roughness: the fit of each 3 by 3 neighbourhood to a plane. A pitched roof
  fits as well as a flat one. The fit may set aside two samples lying below the
  plane, because a neighbour below a roof is its wall or eave; samples above are
  never set aside, so a canopy stays rough.
- Depth: the share of a cell's points more than a metre below its top. A laser
  returns from inside a canopy, never from inside a roof.
- Returns: when the file records them, the share of pulses that came back more
  than once.

Existing building and vegetation classes override the geometry for their cells.

Buildings are connected roof-like patches, opened first to remove anything
under three cells wide and then closed to rejoin a roof split by its ridge. They
then grow back into rim cells whose top matches the roof, recovering edges that
wall points made look deep, and absorb any connected structure taller than any
tree, so a rough tower top is part of its tower rather than a stand of trees.
Footprint area counts each rim cell for the share of it the roof covers,
measured from its point count against the building's interior cells.

Trees follow the method forestry tools use. Canopy excludes cells beside a
building that reach most of its height, which are walls seen from the street,
and stretches narrower than 2.5 m along their own narrowest direction, which
are hedges. Treetops are local maxima within a window that widens with height;
crowns grow from them as a watershed that never climbs above its own treetop,
and a point far above a crown's top is not part of it. Crowns that are too
small, too elongated, too slender for their height or taller than any tree are
dropped.

On a synthetic 300 m aerial neighbourhood with flat, pitched and L-shaped
buildings, a terrace, overlapping crowns and decoys - a shed, hedges, a wall,
lamp posts, cars - detection counts every building and every tree across three
random scenes, at up to 95% tree precision, with footprints within 12%. On the
real Shinjuku scan it counts 64 buildings and 728 trees in under two seconds,
and reports the tallest building at 243 m, the height of the Tokyo Metropolitan
Government Building.

Known limits: buildings sharing a wall and a roofline count as one; two trees
whose crowns merge without a dip between them count as one; a tree pressed
against a wall can be absorbed by the building; and scans that see walls but
not roofs, such as purely street-level ones, are outside what a top-down method
can separate.

## Terrain

`buildTerrainModel` turns classified ground into a digital terrain model: a
grid, one metre by default, holding the mean height of the ground points in
each cell - the same surface height above ground is measured from, so the two
never disagree. Cells without ground points of their own, under a building or
a dense canopy, are filled by the push-pull inpainting ground detection uses,
which blends a hole smoothly from its rim. Filling stops at the edge of the
scan: only cells within one cell of some point have a height, so the model
never invents ground outside what was surveyed. On the synthetic neighbourhood
the rebuilt ground under every building and tree is within a quarter of a metre
of the true terrain (root mean square).

`traceContours` runs marching squares over the model after two passes of a 3
by 3 mean, which removes the kerbs and bumps that would otherwise break a
one-metre grid's contours into a litter of rings; rings too small to be a
landform are dropped too. Levels fall on round elevations of the scan, not of
the viewer's local frame, and the interval is picked from the relief so there
are about 25 lines, with an index contour every fourth or fifth. Saddles are
resolved by the mean of the square's corners. Segments are chained into
polylines through the grid edges they cross, so the export holds whole lines
rather than fragments.

Both run on a worker. The surface is drawn as a mesh in the points' own scene
at up to a million vertices, pushed back a hair in depth so ground points lying
on it do not flicker, with hypsometric tints and a north-west hillshade.
Contours are wide lines depth tested like the building outlines.

Exports: the model as a single-band 32-bit float GeoTIFF, north up, with pixel
scale, tie point, GeoTIFF keys naming the EPSG system when known, and a GDAL
no-data value for cells outside the scan - written without a library and
checked against Pillow's reader; and the contours as GeoJSON LineStrings with
their elevation and index flag. A contour's elevation and the GeoTIFF's values
are in the scan's own vertical units.

## Inspecting and measuring

A click is answered on screen rather than with a ray, because points have no
surfaces for a ray to hit. `pickPoint` projects points with the camera's own
view-projection matrix and takes, of the points whose drawn dot covers the
cursor, the nearest to the camera - the one the depth test left visible. Dot
size is computed by the same formula as the vertex shader, so the pick agrees
with the picture. When the cursor falls in a gap, the closest point within
eight pixels is taken instead. Tiles whose bounds project clear of the cursor
are skipped, and points always come from each tile's full-resolution tier, so a
reading is a real measured point, never a decimated average.

A press counts as a click only if it moves less than five pixels and lasts less
than 600 ms, so orbiting and panning never pick. `describePoint` reports the
point in map coordinates (east, north, elevation) with the channels the cloud
carries; `measureBetween` gives straight-line, horizontal and vertical distance
and slope, computed from map coordinates so "vertical" is elevation. Markers
and the measured line - drawn with its horizontal and vertical legs - are a
separate overlay pass that ignores depth. The distance label is HTML,
positioned from the viewer's per-frame callback without going through React
state. An inspected point is dropped when an analysis replaces the cloud,
because its class and height may have changed; a measurement is only positions
and survives.

## Export

Exports are generated in the browser and handed to it as downloads; nothing is
uploaded. Every position is written in the scan's own world coordinates, in LAS
axes (east, north, up), resolved in double precision from the local frame.

- **Classified LAS.** LAS 1.4, point format 6, or 7 with colour: the first
  formats with a full classification byte and fifteen returns. Height above
  ground and object id have no standard field, so they are written as extra
  bytes named `HeightAboveGround` and `ObjectId` and described in an extra-bytes
  record, which PDAL, LAStools, CloudCompare and laspy read as dimensions. The
  offset is the cloud's local origin and the scale a millimetre, coarsened only
  when a scan is too wide for 32-bit integers at that step. Output is a list of
  one-million-point chunks, so a large file is never one contiguous buffer;
  writing four million points takes about half a second. The file was checked
  against laspy, which reads back coordinates, colour, classes, returns, both
  extra dimensions and the CRS unchanged.
- **Coordinate system.** A LAS reader keeps the source's CRS records (GeoTIFF
  keys and WKT, from the variable-length records or LAS 1.4's extended records
  after the points) on the cloud byte for byte, and the LAS export writes them
  back. The EPSG code is read from the root of a WKT definition, or the
  horizontal half of a compound one, or from GeoTIFF's projected or geographic
  key. A source that only carried GeoTIFF keys has them passed through, though
  LAS 1.4 formally asks for WKT; the major readers accept both.
- **Inventory CSV and GeoJSON.** One row or feature per building and tree.
  Buildings are footprint polygons, wound anticlockwise; trees are treetop
  points with a crown radius. RFC 7946 GeoJSON is longitude and latitude, and
  reprojecting would need a projection library and database, so the layer
  keeps projected coordinates and names the system with the legacy `crs`
  member, which QGIS and GDAL read. Without a known EPSG code the member is
  omitted.
- **Class summary CSV.** Points per ASPRS class, for any classified scan.

Not supported: writing LAZ, since the laz-perf build decompresses only, and
fields the viewer does not load - GPS time, scan angle, point source id and
other extra bytes - are not carried into the LAS export.

## Loading large scans

The file-size cap is gone; what bounds a load now is memory for the points
themselves.

- **Off the page's thread.** `startScanImport` hands the `File` - a handle, not
  its bytes - to a worker, which reads it and transfers the finished arrays
  back without copying. Progress is reported per percent; picking another scan
  terminates the worker, and with it everything it held.
- **In slices.** Readers work through a `ByteSource` and ask only for what they
  are about to decode: headers, coordinate-system records, and 16 MB blocks of
  point records. The file is never in memory whole, next to the arrays being
  built from it. LAZ is the exception by necessity: laz-perf decompresses from
  its own WebAssembly heap, so the compressed file is copied in - block by
  block, never as one JavaScript buffer - and the 2 GB cap on that heap limits
  LAZ files to about 1.9 GB.
- **Thinned, not refused.** Every loaded point costs memory several times over:
  the cloud, its tiles and their detail levels. Scans with more than
  `maxImportPoints` points keep every n-th point, which spreads the kept points
  across the whole scan because writers store points in acquisition or spatial
  order. The side panel says when this happened and by how much, and the
  quality report rates the file it came from. The default of 60
  million loads the 900 MB, 60-million-point Shinjuku sample in about 20
  seconds.
- **Tiling in slices.** Partitioning tens of millions of points into tiles takes
  seconds and runs on the page's thread, because the tiles are what the page
  draws. `PointCloudTiler.tileInSlices` runs the same partition as a generator
  and yields to the browser every 30 ms, through a message channel rather than
  a timer, which background tabs throttle. On a 10-million-point scan the
  longest stall during a load fell from 1.4 s to about 0.1 s.

## The interface

Two pages behind a hash route, which GitHub Pages serves without rewrites: a
landing page, and the workspace at `#/app`.

`useWorkspace` holds the whole working state - the scan, the analyses, what was
clicked, how it is drawn - and is the only place that talks to the imperative
viewer. Components below it are presentational, which is what keeps the layout
free to change: the side panel, the viewport overlays and the status line all
read the same hook.

The workspace has no tabs. One side panel holds the workflow: an "Analyze scan"
button that runs noise, ground, terrain, objects and the quality report in
order, and a card per result carrying its own controls - noise visibility
beside the noise, terrain layers beside the terrain, outlines beside the count.
Each fact is shown once: what the scan is sits in the top bar, what was found
on the cards, and the status line only says what is happening now. Things that
belong to the scan sit over it - the click tools, the colour menu with its
legend, and an inspector for whatever was last clicked. Exports live in one
menu in the top bar, each item saying why it is unavailable when it is; how the
scan is drawn lives in the Display menu.

## Rendering approach

The renderer uses one `THREE.Points` draw call for the active tier and a custom
shader. Vertex RGB, height-gradient and intensity presentation are selected by
a uniform, while perspective-aware point sizing runs per vertex on the GPU.
Fallback attributes are allocated when a scan has no RGB or intensity data so
the shader layout stays stable across all clouds.

## Intentional next boundaries

1. Stream scans beyond memory - an out-of-core octree - for datasets larger
   than any single tab can hold. Parsing, tiling and pyramid construction
   already stay off the page's thread or yield to it.
2. Add retained performance telemetry (FPS, frame time, GPU capability) to the
   React overlay without coupling it to Three.js scene state.
3. Add accessibility refinements to the side panel and the report dialog.

True octree streaming remains a separate data-source strategy; none of these
classes claim to support unbounded multi-scan datasets in memory.
