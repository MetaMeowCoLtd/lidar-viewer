# Architecture decisions

The implementation is deliberately split into a framework-independent core and
an imperative Three.js adapter. React is a control surface for these classes,
not an owner of scene state. This protects the render loop from React
reconciliation and keeps the data pipeline worker-ready.

```
PointCloud (typed arrays, metadata, bounds)
  ├─ ProceduralCloudGenerator  → development/test source
  ├─ LAS / LAZ / PLY readers   → local scan sources
  ├─ detectGround (worker)     → ground class + height above ground
  ├─ detectObjects (worker)    → buildings, trees, object ids and outlines
  └─ PointCloudLodPyramid
       └─ VoxelGridDownsampler → precomputed tiers
            └─ LidarViewer → one RAF loop, camera and OrbitControls
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

## Rendering approach

The renderer uses one `THREE.Points` draw call for the active tier and a custom
shader. Vertex RGB, height-gradient and intensity presentation are selected by
a uniform, while perspective-aware point sizing runs per vertex on the GPU.
Fallback attributes are allocated when a scan has no RGB or intensity data so
the shader layout stays stable across all clouds.

## Intentional next boundaries

1. Move file parsing into a worker for million-point imports, transferring
   typed-array buffers into the existing `PointCloud` contract. Pyramid
   construction already runs on a worker pool.
2. Add retained performance telemetry (FPS, frame time, GPU capability) to the
   React overlay without coupling it to Three.js scene state.
3. Add accessibility and keyboard navigation refinements to the control panel.

True octree streaming remains a separate data-source strategy; none of these
classes claim to support unbounded multi-scan datasets in memory.
