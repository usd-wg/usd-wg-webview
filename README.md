# USD Web View

USD Web View is a browser-based OpenUSD inspection and rendering environment.
It parses USD files entirely in-browser using a WASM build of OpenUSD, renders
meshes and Gaussian splats in Three.js, and plays back animation. No server is
required.

## Features

- **File formats** - USD, USDA, USDC, USDZ, multi-file folder drops, and
  MaterialX sidecar resources.
- **Unified mesh runtime** - one native `WebViewStageDriver` handles static
  meshes, animated transforms, skinned meshes, variants, payload edits, UVs,
  authored normals, subsets, and material bindings.
- **Materials** - UsdPreviewSurface PBR scalars and texture slots (diffuse,
  roughness, metallic, normal, occlusion, emissive, clearcoat, clearcoat
  roughness, opacity), plus MaterialX materials through upstream Three.js'
  MaterialX loader and node-material path.
- **Variant sets** - variant badges in the scene graph, dropdown selection in
  the attributes panel, and coherent geometry/material redraws after selection
  changes.
- **Payloads** - per-prim load/unload from the scene graph, bulk load/unload
  from the Stage menu, and a stage-open policy for loading payloads by default.
- **Gaussian splats** - USD-authored splat data rendered with SparkJS alongside
  mesh content, with fidelity and detail controls for spherical harmonics and
  splat scale.
- **Animation playback** - timecode scrubbing and play/pause via a minimal
  playbar, shown when the loaded stage has an animated time range.
- **Inspection UI** - scene graph, prim attributes, selection highlighting,
  payload and variant badges, stage summary, renderer stats, up-axis handling,
  and HDRI/default lighting controls.
- **USDLux lights** - authored `DomeLight`/`DomeLight_1` prims can drive HDRI
  environment lighting and visible backgrounds; distant, sphere, rect, and disk
  lights are converted to viewport lights with selectable gizmos and editable
  light attributes in the attributes panel.
- **USD 26 compatibility** - works with older USDZ files that authored
  `material:binding` before `UsdShadeMaterialBindingAPI` became a formal
  applied-API schema.
- **Dual WASM runtimes** - OpenUSD 26.08 in WASM64 on capable browsers, with
  WASM32 compatibility fallback. Only the selected native JS/WASM pair loads.
- **Memory diagnostics** - the existing **? > Stats** panel reports input
  sizes, load timings, native allocation/capacity, browser heap where available,
  and renderer resource metrics with explicit estimate/availability labels.

## Current Constraints

- **Gaussian splats + MaterialX** - SparkJS remains WebGL-only; MaterialX
  rendering uses Three's WebGPU/TSL path and can require a renderer switch.
- **USDLux fidelity** - USDLux is translated to the light types available in
  Three.js, not path-traced. WebGL and WebGPU have different area-light
  behavior; see [Lighting](docs/lighting.md).
- **Large scenes** - WASM32/WASM64 currently permit 2/8 GiB of linear memory.
  These are build ceilings, not supported scene-file sizes or available RAM.
  Input copies, JavaScript buffers, textures, and GPU resources add costs.
  Large-scene and real-mobile benchmarks remain pending.

## Light Gizmos

Light gizmos are enabled from **Settings > Lighting > Light gizmos**. Click a
light prim in the scene graph or click its wire gizmo in the viewport to select
the USD light prim; the attributes panel then exposes editable light inputs such
as intensity, exposure, color, temperature, radius, width, height, and shaping
cone values. Press `F` to frame the selected light. Gizmos are selection aids,
not transform manipulators.

## Architecture

```
C++ (OpenUSD + Emscripten)          native/usd-webview-bindings/src/*.cpp
        ↓  compiled to WASM
JS wrapper                           public/usd-webview-bindings/usdWebViewBindings.js
        ↓  installed to public/
TypeScript runtime                   src/usd/UsdWebViewRuntime.ts
        ↓
Three.js viewport + app shell        src/viewer/*  ·  src/app/*  ·  src/main.ts
```

The native side is split into translation units under
`native/usd-webview-bindings/src/` — `unifiedDriver.cpp` (the stage driver),
`materials.cpp`, `meshExtraction.cpp`, `pointInstancer.cpp`,
`skelBinding.cpp`, `splats.cpp`, `stageApi.cpp`, `stageRegistry.cpp`,
`jsInterop.cpp`, and `bindings.cpp` — sharing `webviewCommon.h`. The viewport
is a facade (`src/viewer/ThreeViewport.ts`) over focused modules:
`RendererManager`, `GeometryBuilder`, `MaterialFactory`, `TextureCache`,
`Lighting`, `Navigation`, and `Picking`. See
[Material and Geometry Strategy](docs/material-geometry-strategy.md) for the
runtime architecture.

The viewport geometry path is intentionally singular: `UsdWebViewRuntime`
creates one native `WebViewStageDriver` per loaded stage. Static meshes,
skinned meshes, animated transforms, variant changes, and payload changes all
draw through that driver. Authored material payloads and Gaussian splats are
side suppliers; they are not alternate mesh runtimes.

## Testing

```sh
npm ci                  # install the locked dependencies, as CI does
npm run test:unit        # vitest unit layer
npm run test:regression  # browser renders cases against per-case baselines
                         # runner and cases: tests/regression/
npm run test             # both
npm run test:artifacts    # native pair/hash and release-packaging tests
npm run build            # packages/verifies both native runtimes into dist/
npm run test:dist -- 32   # full corpus against the production build, forced 32
npm run test:dist -- 64   # same corpus, forced 64 (never silently downgrades)
npm run test:dist -- smoke # automatic selection, fallback and Stats checks
```

Baseline changes are re-blessed with `npm run test:regression:bless` and
reviewed against generated PNG diffs in `test-results/regression/results/`.

## Development

```sh
npm ci
npm run dev
```

Open the local URL printed by Vite. Both native pairs are supplied as prebuilt
artifacts; a native toolchain is only needed when changing the bindings.
`npm run dev` and `npm run build` package the pairs automatically.

| URL option | Behavior |
| --- | --- |
| No option, or `?wasm=auto` | Prefer WASM64 if supported; retry WASM32 once on startup failure |
| `?wasm=32` | Force WASM32 without probing Memory64 |
| `?wasm=64` | Require WASM64; unsupported or failed startup is an error |

The status-bar build name identifies the loaded pair. Chrome mobile emulation
does not disable Memory64. See [building.md](docs/building.md) for packaging/CI
and [wasm-sdk.md](docs/wasm-sdk.md#selection-verification) for fallback tests.

## Documentation

- [Building](docs/building.md) — Prerequisites and build instructions for the WASM bindings and frontend
- [WASM SDK](docs/wasm-sdk.md) — Fresh-machine setup and `npm run native:source` to build both runtimes from pinned sources, plus runtime options and memory metrics
- [Lighting](docs/lighting.md) — USDLux translation, WebGL/WebGPU behavior, gizmos, editable attributes, and limitations
- [Material and Geometry Strategy](docs/material-geometry-strategy.md) — Unified stage-driver geometry, authored-material payloads, and known rendering constraints
- [USD Material Fidelity](tools/usd-material-fidelity/README.md) — Opt-in MaterialX/USD shaderball fidelity harness, setup, and current baseline
