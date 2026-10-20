# Material And Geometry Strategy

## Summary

The viewer has **one geometry authority**: the native `WebViewStageDriver`
(`native/usd-webview-bindings/src/unifiedDriver.cpp`). The four competing mesh paths that
previously handed off mid-session (reference Hydra driver, Hydra sync driver,
legacy extraction, and the mid-session driver swap) were removed in the
geometry-runtime unification refactor. `git grep ReferenceHydra` returning
nothing is an invariant.

## Architecture

### The unified stage driver

One driver exists per loaded stage path. It composes a **private driver
stage**:

- The **root layer is shared** with the inspection stage (the one the scene
  graph and attribute panels read, and the one that receives variant/payload
  edits).
- An **anonymous driver session layer** sublayers the inspection stage's
  session layer, so edits authored there propagate to the driver stage by
  composition — never by copying.
- Load rules are mirrored from the inspection stage and re-mirrored on every
  `NotifyStageEdited`.

All skeleton work happens only in the driver session:

1. Missing skel bindings are inferred (`skel:skeleton` / `skel:animationSource`
   relationships) and `SkelBindingAPI` is applied where needed.
2. `UsdSkelBakeSkinning` bakes skinned points as time samples.
3. Diagnostics assert the shared root layer stayed clean after the bake.

The shared stage is therefore never mutated; the old double-deformation and
payload-divergence bugs are structurally impossible.

### Routing by capability, not animation range

`GetCapabilities()` probes the composed stage (`hasSkelContent`,
`skelBindingsInferred`, `hasTimeVaryingPoints/Xforms`, `hasAnimationRange`,
`hasPointInstancers`, `hasMaterialX`, `hasGaussianSplats`). Nothing routes on
"endTimeCode > startTimeCode" anymore — a skinned stage without an authored
range still animates.

### Draw pipeline (contract v2)

`Draw(full)` enumerates imageable meshes on the driver stage and triangulates
each mesh **once** with `HdMeshUtil::ComputeTriangleIndices` (topology cached
per prim). Per mesh it emits triangle-corner-expanded typed arrays:

- `positions` — corners at the current time code (baked skinning arrives as
  plain time samples).
- `normals` — authored primvars/attribute first (faceVarying/vertex/uniform
  respected via `ComputeTriangulatedFaceVaryingPrimvar`), with natively
  computed `Hd_SmoothNormals` as the fallback. TS position-welding remains only
  as a last resort in `GeometryBuilder`.
- `uvs` — `primvars:st`, same corner stream. No UV/vertex-count handshake
  exists anymore.
- `subsets` — GeomSubset triangles grouped into contiguous `[start,count)`
  ranges, each carrying a `materialPath`.
- `materialPath` — resolved bound-material path (string only).

`Draw(full=false)` returns only the time-varying set (varying points or a
time-varying xform anywhere up the prim's ancestor chain); the app uses it for
scrubbing/playback. Point instancers reuse the legacy extraction shape
(`points`+`indices`+`instanceMatrices`) and are expanded viewer-side.

### Materials

Geometry never carries material payloads. `ExtractMaterialPayloads(stagePath)`
returns authored materials keyed by material prim path;
`UsdWebViewRuntime` resolves `materialPath` → payload when converting
`MeshUpdate`s to renderables. MaterialX materials are delivered as raw `.mtlx`
bytes (via `info:mtlx:sourceAsset` on the bound shader), then parsed by
upstream Three.js' MaterialX loader into node materials. The checked-in
official ASWF MaterialX JavaScript/WASM runtime remains available for
validation/reference tests, but is not the interactive rendering path.

The MaterialX UV `V` flip lives in exactly one place:
`GeometryBuilder.applyMaterialXUvOptions`. The `materialx-tiled` regression
case (orientation-asymmetric letter texture) gates it. Meshes using the
MaterialX EXR texture fallback keep authored UVs instead, because they render
through standard texture slots rather than Three's MaterialX image nodes; see
`src/viewer/materialXCompatibility.ts`.
Compilation-failure and unavailable-renderer fallbacks also keep authored UVs.
Orientation follows the selected render material rather than the existence of
an authored MaterialX payload. Mixed subsets flip only MaterialX corner ranges;
material refresh regenerates UVs and matching tangents from authored data.

### Stage edits

Every composition-changing edit (variant selection, payload load/unload)
funnels through `applyStageEdit`: native edit → `NotifyStageEdited` (re-mirror
load rules, re-infer, re-bake) → full `Draw` + material payloads → viewport
diff → panels refresh. There is no variant-name keyword sniffing; geometry and
materials arrive coherently by construction.

## Known degradations and constraints

- **Gaussian splats + MaterialX**: SparkJS renders splats on the WebGL path
  only. MaterialX uses Three's WebGPU/TSL path, so the viewport may switch to
  `WebGPURenderer` and drop splat rendering.
- **Headless automation** cannot present real-WebGPU canvases; the regression
  runner passes `?forceWebGL=1` for cases that explicitly require WebGPU.

## Remaining performance opportunities

- Persistent JS-side geometry buffers when vertex counts match between draws
  (today each draw copies fresh typed arrays out of the WASM heap).
- A transforms-only fast path (partial draws currently re-emit full corner
  streams for meshes whose only variation is an ancestor xform).
- `matrix`/`instanceMatrices` still marshal as `number[]`.
