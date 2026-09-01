# Architecture decisions

The implementation is deliberately split into a framework-independent core and
an imperative Three.js adapter. React is a control surface for these classes,
not an owner of scene state. This protects the render loop from React
reconciliation and keeps the data pipeline worker-ready.

```
PointCloud (typed arrays, metadata, bounds)
  ├─ ProceduralCloudGenerator  → development/test source
  ├─ PLY importer              → local scan source
  └─ PointCloudLodPyramid
       └─ VoxelGridDownsampler → precomputed tiers
            └─ LidarViewer → one RAF loop, camera and OrbitControls
                 └─ ThreePointCloudRenderer → GPU geometries + shader
```

## Core invariants

- One point is one xyz triplet. Optional RGB and intensity arrays have the same
  point index and are validated when a cloud is created.
- The domain layer is independent of DOM, React, and Three.js, so heavy import
  and decimation work can move to a worker without changing its contract.
- A LOD pyramid contains complete precomputed tiers. Selecting a point budget
  only swaps an existing `BufferGeometry`; it never allocates or decimates in a
  frame.
- `PointCloudSession` uses monotonically increasing request IDs. A stale import
  is unable to overwrite the newest successful load.
- `ThreePointCloudRenderer` is an explicit resource owner. It disposes geometry
  and material resources when a cloud is replaced or the host unmounts.

## Rendering approach

The renderer uses one `THREE.Points` draw call for the active tier and a custom
shader. Vertex RGB, height-gradient and intensity presentation are selected by
a uniform, while perspective-aware point sizing runs per vertex on the GPU.
Fallback attributes are allocated when a scan has no RGB or intensity data so
the shader layout stays stable across all clouds.

## Intentional next boundaries

1. Move PLY parsing and pyramid construction into a worker for million-point
   imports, transferring typed-array buffers into the existing `PointCloud`
   contract.
2. Add retained performance telemetry (FPS, frame time, GPU capability) to the
   React overlay without coupling it to Three.js scene state.
3. Add accessibility and keyboard navigation refinements to the control panel.

True octree streaming remains a separate data-source strategy; none of these
classes claim to support unbounded multi-scan datasets in memory.
