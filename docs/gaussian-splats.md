# Gaussian splats

The viewer uses Spark Radix 0.0.1 with Three.js 0.186.0. One asynchronously
initialized `WebGPURenderer` handles meshes, MaterialX and USD Gaussian splats.
WebGPU is preferred; Three's WebGL2 backend remains available when WebGPU is
unavailable or `?forceWebGL=1` is selected. `?gpu=webgpu` requests WebGPU but
Radix can still fall back with a warning; the regression runner rejects this
fallback when `--backend webgpu` is selected.
The Stats panel reports the actual backend and GPU/worker sorting mode.

## Data and rendering

Native OpenUSD extraction and both WASM runtimes are unchanged. The adapter
converts `RenderableGaussianSplat` arrays to Radix packed splats, keeping USD
positions, anisotropic scale, xyzw rotation, opacity, prim transforms and
view-up-axis handling. DC coefficients become RGB with the same clamping as
the previous Spark adapter. Higher SH coefficients retain coefficient-major
RGB order and use Radix's packed SH encoding through degree 3.

Base storage is 16 bytes per splat. SH3 adds 48 bytes, totaling 64 bytes per
splat versus the previous adapter's 56 bytes. Allocation capacity can exceed
the authored count. Stats show the encoded payload, not total memory: input
arrays, sort/project buffers, textures, render targets and retained CPU data
add costs. SH degree and scale controls update renderer parameters/uniforms
without repacking or uploading the source splats.

On WebGPU, Radix projects, compacts and sorts splats on the GPU in the same
frame. The WebGL2 backend sorts with a worker. Automation explicitly waits for
that worker before capturing; interactive fallback sorting remains asynchronous.
Collection replacement uses Radix's release callbacks. Clearing a payload also
disposes views so pending/retained worker orders can release their old data.

## Mixed mesh and splat composition

Gaussian color is intended for sRGB alpha blending; MaterialX and other lit
meshes need linear shading. `SplatCompositor` therefore:

1. Renders geometry into a linear half-float color/depth target.
2. Applies the selected output transform to its color and copies its depth to
   the canvas using a fullscreen triangle.
3. Blends Radix splats over that image with the copied depth.

All three passes run on the same graphics device without CPU pixel readback.
They preserve the canvas sample count: switching MSAA between the copy and
splat passes would discard the WebGPU canvas attachments. Scenes with no
splats render directly without these additional passes.

## Tradeoffs and remaining work

- MaterialX no longer replaces the renderer and removes splats. GPU sorting
  removes worker-sort latency on WebGPU, but speedups have not been benchmarked
  against Spark on representative production scenes.
- Radix 0.0.1 is an early release. Its published manifest incorrectly requires
  macOS-only `fsevents`; a reproducible manifest-only repack is pinned under
  [vendor/](../vendor/README.md). Runtime code and license are unchanged.
- Packed SH3 costs eight more bytes per splat than the old adapter. Mixed
  scenes also need an offscreen target and two additional render passes.
- Opaque mesh depth works with splats. Arbitrarily intersecting transparent
  meshes and splats do not share a global transparency sort.
- The unified TSL path retains spot approximations for rect/disk USDLux lights,
  including on WebGL2; the old classic WebGL path used area-light approximations.
- LoD/streaming, splat picking, XR and large-scene/mobile tuning are not added
  by this integration. The previous adapter did not expose those Spark features.
- This advances GPU rendering; OpenUSD parsing, data conversion and orchestration
  still run on the CPU/WASM, and the compatibility backend still uses WebGL2.

## Validation

Unit tests cover packed base data, quaternion conventions, SH degrees 0–3,
coefficient ranges, and defaults. The original `splats-minimal` baseline is
retained. `splats-materialx` adds a MaterialX cube with front/behind splats,
a transformed anisotropic SH3 splat, SH/scale changes and payload unload/reload.
The regression runner records actual backend, adapter and sort mode and fails
on browser exceptions or an unexpected backend/runtime.

```sh
npm run test:unit
npm run build
npm run preview -- --port 8002
# In a second terminal, against the same built application:
npm run test:regression -- --base-url http://127.0.0.1:8002 --backend webgl2 --wasm 32
npm run test:regression -- --base-url http://127.0.0.1:8002 --backend webgpu --wasm 64
```

The WebGPU run uses full Chromium headless. Set `USD_WEBVIEW_BROWSER_CHANNEL`
to `msedge` or `chrome` to use that installed Playwright browser channel. On a
Windows/WSL setup, run Node in Windows with an installed browser to exercise
the native GPU driver; WSL graphics support can differ. A WebGPU assertion
proves the API/backend, not hardware acceleration; inspect the recorded adapter.

For a larger adapter check, start the development server and run
`node tests/splats/run.mjs http://127.0.0.1:8000 webgpu` (or `webgl2`). This
exercises 70,001 SH3 splats, a tail beyond the sorting workgroup boundary,
control changes, transformed Z-up content, collection replacement and repeated
clear/reload. It checks Radix's visible count and source-array release callbacks;
it is a correctness smoke test, not a performance benchmark. Both modes were
validated in native Windows Edge on NVIDIA Blackwell. WSL Chromium hit a
`clientWaitSync failed` graphics synchronization error on the larger fallback
test; use native Windows for that test on this host.

Initial migration validation (2026-11-02):

| Production backend | Runtime | Visual captures |
| --- | --- | --- |
| WebGL2, WSL Chromium | WASM32 | 28/28 pass |
| WebGL2, WSL Chromium | WASM64 | 28/28 pass |
| WebGPU, Windows Edge / NVIDIA Blackwell | WASM32 | 28/28 pass |
| WebGPU, Windows Edge / NVIDIA Blackwell | WASM64 | 28/28 pass |

The 23 existing captures retain their original baselines and gates; five new
captures cover mixed MaterialX/splat rendering. Also passed: 80 unit tests,
10 native-artifact tests, seven runtime-selection scenarios, Stats checks on
both runtimes, the 70,001-splat check on both native Windows backends, a clean
Linux `npm ci`, archive reproducibility, TypeScript and the production build.
Local JSON reports are in the ignored `test-results/radix-validation/` folder.
