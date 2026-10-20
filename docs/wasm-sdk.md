# OpenUSD + MaterialX WASM Build Notes

## Purpose

This document records the full OpenUSD + MaterialX + WebAssembly build pipeline used by `usd-wg-webview`.

The goal is to make it possible to recreate the entire WASM SDK from scratch on a new machine without reverse-engineering old build artifacts.

## Current runtime contract

Both variants use OpenUSD **26.08**, already introduced on `main` by PR #31.
The dual-runtime feature adds Memory64 support and selection, not a new USD
version. Canonical prebuilt pairs, hash verification, release packaging and
CI are described in [building.md](building.md#dual-runtime-packaging-and-deployment).
A normal checkout packages both variants automatically for development/build.

| Browser option | Selection | Startup fallback |
| --- | --- | --- |
| absent / `wasm=auto` | Validate Memory64, prefer 64 when available | Retry 32 once if 64 initialization fails |
| `wasm=32` | Always 32; no Memory64 probe | None |
| `wasm=64` | Require Memory64 and packaged 64 pair | None; fail explicitly |

Current compiled linear-memory ceilings are 2 GiB (32) and 8 GiB (64).
These are not file-size limits or guarantees of available memory. Fallback
happens only before stage loading; a later allocation/scene-load failure does
not restart the stage in another runtime. Ordinary successful startup fetches
one generated JS/WASM pair, with no speculative download of the other pair.
The small manifest and shared wrapper load separately.

The experiment chronology below retains historical hashes/results; current
artifact identities and sizes come from the generated manifests and Stats.
Full-island/high-residency USD and actual mobile-device benchmarks remain
pending. Automated Chromium checks establish functional compatibility, not
production-scale scene capacity.

## Isolated local SDK experiment

As checked on 2026-10-20, the latest stable upstream release is `v26.08`
(`ee47c679abde5b467a7b6a41f3b2285564a4222e`). `v26.11-rc1` is a release
candidate and is not the baseline for this experiment.

The existing local `USD_WASM_Build` was built from OpenUSD 26.05; the release
named in repository documentation does not establish the version of a local
SDK. Inspect its source revision and CMake cache before reusing it.

The local experiment began on `experiment/wasm64`; release preparation now
uses `feat/wasm64-runtime` in that same isolated viewer worktree.
Its sibling directories are:

```text
wasm64-lab/
  viewer/                         # isolated Git worktree
  sources/
    OpenUSD-v26.08/                # pinned release checkout
    MaterialX-22f1c433/            # pinned 1.39.6 development revision
    OpenSubdiv-3_6_1/
    oneTBB-2021.12.0/
  build/wasm32/                   # per-component CMake directories
  install/wasm32/materialx/
  install/wasm32/usd/
  emscripten-cache/
  ccache/
```

`wasm64` builds use separate `build/wasm64` and `install/wasm64` directories.
First establish a working WASM32 baseline from the current stable OpenUSD;
only then run WASM64 comparisons. The script supports both architectures,
but that alone does not establish that the WASM64 SDK builds or runs.

Sources are OpenUSD at the revision above, MaterialX at
`22f1c433e71f49a541a15c4b1f5f9084b97be226`, and the unmodified upstream archives
for OpenSubdiv 3.6.1 and oneTBB 2021.12.0. The local archive SHA-256 values are:

| Archive | SHA-256 |
| --- | --- |
| `OpenSubdiv-v3_6_1.zip` | `f2a42d8af5b3e1d51b9d6b243c1c3bac9d6044e3715cd19968723b49231039cc` |
| `v2021.12.0.zip` | `fe6ca052b5bdd2c6e0616b360c9b0dcbcc46e01bbd0aa8fd0517c17fc58931db` |

Apply the two source adjustments documented below: MaterialX's generated
config must skip X11 under Emscripten, and OpenUSD HGI needs the no-backend
Emscripten branch. Keep these in the isolated checkouts; do not modify the
working SDK sources.

From the isolated viewer worktree, with Emscripten 6.0.0 installed:

```sh
EMSDK_ROOT=/path/to/emsdk BUILD_JOBS=8 \
  bash tools/native-build/build-local-sdk.sh wasm32
```

The script verifies both Git revisions, builds all four components, and
installs only into the experiment. `USD_WASM_LAB_ROOT` can override the
default parent of the viewer worktree. Set `EM_CACHE` **after** sourcing
`emsdk_env.sh`, which clears existing Emscripten variables. Keep `CCACHE_DIR`
inside the experiment as well.

For WASM32, omit `-sMEMORY64` entirely. Emscripten 6.0.0's CMake toolchain
matches the presence of `MEMORY64` rather than its value: `-sMEMORY64=0`
incorrectly marks generated CMake package metadata as 64-bit even though the
compiler produces WASM32 objects. This makes TBB package-version checks fail
in the viewer configure. WASM64 uses `-sMEMORY64=1` in both C and C++ flags.

Configure viewer bindings against that new SDK using the workflow in
[building.md](building.md), install into the isolated viewer's `public/`, and
run `npm run native:build` so artifact IDs are derived from actual content.
For the fresh 26.08 SDK, also pass
`-DOpenSubdiv_DIR=<lab>/install/wasm32/usd/lib/cmake/OpenSubdiv`:
`pxrConfig.cmake` now resolves OpenSubdiv as a config dependency, and the
Emscripten package search does not automatically search an arbitrary sibling
SDK prefix.
Do not replace the active MaterialX editor's binaries while validating this
baseline.

For subsequent memory testing, distinguish a >2 GiB file from >2 GiB runtime
memory. A useful WASM64 test must allocate and access addresses above 4 GiB,
in addition to realistic scene tests that measure native, JavaScript, and
GPU memory. Large files should be local generated assets, not Git fixtures.

### Baseline comparison and Memory64 probe

Before installing the newly built viewer binary, the existing upstream WASM32
artifact passed all 22 original captures in local Chromium. The additional
`usdpreview-uv` fixture was copied from the uncommitted material graph editor
work for diagnostic comparison: upstream already fails that fixture
(`mismatchRatio=0.051581`). Do not bless that failure or interpret it as a
new SDK regression. Keep the pre-rebuild report and images outside the
runner's output directory, since the runner replaces its results each run.

`tools/native-build/memory64-probe.cpp` is a standalone address-width and
Embind test, separate from OpenUSD. After establishing the upgraded WASM32
baseline, compile it with the same Emscripten toolchain:

```sh
# Set EM_CACHE after sourcing emsdk_env.sh, as above.
mkdir -p public/localAssets/wasm64-probe
em++ tools/native-build/memory64-probe.cpp \
  --bind --no-entry -O2 -sMEMORY64=1 -sWASM_BIGINT=1 \
  -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=8589934592 \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web \
  -o public/localAssets/wasm64-probe/probe.mjs
npm run dev -- --port 8001
# In another shell:
node tools/native-build/run-memory64-probe.mjs http://127.0.0.1:8001
```

The test accesses both sides of 4 GiB, checks for truncated-pointer aliasing,
copies a typed array from an address above 4 GiB through Embind, explicitly
grows memory, and checks that the JavaScript-owned copy survives. It touches
one byte per 64 KiB plus boundary sentinels: this verifies addressing but does
not establish multi-gigabyte physical residency or a supported scene-size
limit. It must pass before treating a successful WASM64 compile as useful
browser support.

Local results on Chromium 149.0.7827.55:

- Fresh OpenUSD 26.08 WASM32 viewer: `wasm-4fd717ab0650`; all 22 original
  visual captures pass, with the same mismatch ratios as the upstream
  artifact. The additional editor UV fixture retains its pre-existing
  `0.051581` mismatch.
- Standalone Memory64 probe: 8-byte pointers, high address `4295038400`,
  heap growth from `4295163904` to `4462936064` bytes, correct boundary
  sentinels and sparse reads, and the copied array survives growth.

For a full SDK experiment, run `build-local-sdk.sh wasm64`. Configure the
viewer bindings into a separate build directory with
`-sMEMORY64=1` in C/C++ and linker flags, and an explicit 8 GiB
`MAXIMUM_MEMORY`. Install the generated glue and WASM under
`public/localAssets/wasm64-runtime/`.

The companion binding script supplies those settings:

```sh
EMSDK_ROOT=/path/to/emsdk bash tools/native-build/build-local-bindings.sh wasm32
EMSDK_ROOT=/path/to/emsdk bash tools/native-build/build-local-bindings.sh wasm64
```

WASM32 uses the normal mandatory `native:build`/stamp workflow. WASM64 writes
a content-derived `build.json` identifying both generated files, without
changing the normal viewer's cache IDs.

After rebuilding, import the 64-bit pair into its canonical release location:

```sh
npm run native:package -- public/localAssets/wasm64-runtime
npm run native:verify
npm run build
```

Keep both SDKs/build directories separate. After a C++ or dependency change,
rebuild both variants before publishing. Include `native/artifacts/wasm64/`
and the WASM32 pair/hash record with the source change; do not hand-edit hashes.

The visual runner has a **test-only** `--runtime-assets` override:

```sh
npm run test:regression -- --base-url http://127.0.0.1:8001 \
  --runtime-assets /localAssets/wasm64-runtime/
```

This redirects requests for generated glue and WASM to the experimental
pair while reusing the same maintained wrapper and frontend. It records the
replacement URLs in its report and disallows baseline updates. Normal
viewer startup without a packaged manifest loads the freshly rebuilt WASM32
runtime. This legacy test override does not exercise architecture selection;
its on-screen identity still identifies the redirected WASM32 request, so use
the test report and artifact hashes for the experimental runtime's identity.
For selection-aware testing, use the package and `--wasm` commands below.

### Historical full SDK experiment results (before Stats instrumentation)

Both complete SDKs and viewer bindings build with the pinned sources and
Emscripten 6.0.0. No additional OpenUSD source patches were needed for WASM64
beyond the HGI adjustment shared with WASM32.

| Artifact | WASM32 | WASM64 |
| --- | ---: | ---: |
| WASM bytes | 19,904,761 | 20,554,061 |
| Gzip bytes (Node default compression) | 4,148,438 | 4,303,444 |
| Declared maximum linear memory | 2 GiB | 8 GiB |

The experimental WASM64 pair is `experiment-c55dd244a25b`, with WASM SHA-256
`8f88507689b3257032df9b5690db72bc9e8b80559541ae4b434b5129b14e4e46`.
Binary inspection confirms a Memory64 declaration (memory flags `5`), versus
flags `1` for the WASM32 baseline.

In Chromium 149.0.7827.55, all 22 original captures pass for WASM64. All 23
captured images, including the pre-existing editor UV fixture failure, are
pixel-identical between the rebuilt WASM32 and WASM64 runtimes. The report
records requests redirected to the experimental glue and WASM, and includes
the pair's build manifest. No baselines were updated.

That historical expanded gate reported failure because `usdpreview-uv` was
deliberately retained as a diagnostic fixture. It was not a fully green
expanded suite. Its failure was unchanged across the original upstream
WASM32 binary, the rebuilt 26.08 WASM32 binary, and WASM64.

Local evidence resides beside the isolated viewer:

- `wasm32-sdk-rebuild.log`, `wasm64-sdk-build.log`
- `wasm32-bindings-build.log`, `wasm64-bindings-build.log`
- `wasm32-upstream-regression/`, `wasm32-rebuilt-regression/`,
  `wasm64-regression/` (reports and captured images)
- `memory64-probe-result.log`

The then-current 55 unit tests and production frontend build also passed. Those checks
establish local build/render feasibility, not a supported large-scene limit:
the >4 GiB address test uses a standalone Embind module, and the full USD
runtime has so far rendered the small regression scenes. Realistic
high-residency USD tests and other browsers remain future work. The following
section records the subsequent selection/fallback implementation.

The editor-dependent `usdpreview-uv` diagnostic fixture is preserved outside
the viewer at `<lab>/diagnostics/usdpreview-uv-editor/`, alongside the saved
reports. It is not part of the experiment's default regression gate: its
native graph-translation prerequisites belong to the separate editor work.

### Selective loading and manual testing

#### Large-scene metrics in ? → Stats

The existing Stats panel includes live load/runtime/resource sections; there
is no separate diagnostics window. Open it on the isolated viewer (port 8001).
It samples once per second while visible, plus native load checkpoints.
Synchronous native work blocks the browser thread, so UI samples cannot expose
every temporary allocation peak.

- Input: selected file count, total bytes, root and largest-file sizes. These
  are the files supplied to the importer, not only composed layers. A USDZ
  input is measured at its archive size, not its uncompressed content size.
- Timings: file import, USD open, extraction/material handoff, total runtime
  load, and application load-to-ready (including texture decode/viewport setup;
  excluding the file picker or automation's preceding HTTP downloads).
- Native: actual linear-memory capacity and compiled maximum from Emscripten;
  allocated/free allocator bytes from `mallinfo`; sampled allocated peak since
  the most recent load; remaining permitted linear-memory growth. Capacity
  includes stack/static data and free space and does not shrink on scene unload.
  It is not physical resident RAM. Allocator free bytes are not all unused
  linear-memory bytes. Peak sampling can miss transients within native calls.
- Imported files: logical MEMFS byte size and retained original byte copies,
  excluding embedded SDK files. These are JavaScript-backed resources, not
  extra native allocations. Original copies remain necessary for existing edit
  behavior; instrumentation does not remove them.
- Browser: optional `performance.memory` JS used/capacity/limit values.
  These are approximate, browser-dependent, and may omit external buffers.
  Unsupported browsers say “Unavailable”, never zero.
- Renderer: backend, drawing-buffer resolution, frame interval/FPS, draw calls,
  frame triangles, registered texture/geometry counts, mesh instance count,
  deduplicated CPU geometry backing-buffer bytes, and known texture dimensions
  expressed as an RGBA8 base-level byte estimate. The latter is not actual GPU
  texture storage (float/compressed formats, mipmaps, private MaterialX resources,
  render targets, environment maps, and splat resources can differ or be absent).
  WebGPU's renderer-tracked memory bytes are shown when exposed by Three.js.
  Neither these tracked estimates nor CPU inventories measure physical VRAM.

Do not add these overlapping categories into a supposed total process-memory
figure. Neither physical browser-process RAM nor total GPU VRAM is available.
Frame interval is CPU frame cadence, not GPU execution time. Scene replacement
resets input/timing/peak metrics; native capacity can remain high by design.

The `GetMemoryStats` native binding returns byte counts as JavaScript Numbers,
without narrowing WASM64 `size_t` to 32 bits. Its translation unit uses the
Emscripten compatibility `malloc.h` declaration matching dlmalloc. Rebuild and
stamp both architectures after changes to this binding.

Validation:

```sh
npm run test:unit
npm run build
npm run test:stats -- http://127.0.0.1:8001
```

The browser test checks both architectures, positive allocator counters,
2/8 GiB ceilings, file accounting, replacement reset, unavailable browser heap
reporting, and existing-panel open/close/narrow-width behavior. Screenshots
are saved to `/tmp/usd-stats-wasm32.png` and `/tmp/usd-stats-wasm64.png`.

#### Selection verification

After merging the main-branch UV fallback fix, the experiment's default
corpus has 23 captures (including `materialx-fallback-uv`). Both forced
WASM32 and forced WASM64 pass all 23 without baseline changes. Historical
diagnostic results above are retained separately.

`npm run dev` packages both canonical runtimes automatically. Start the
isolated viewer on port 8001. See [building.md](building.md)
for packaging, cache identity, and deployment requirements.

```sh
npm run dev -- --port 8001
# Other terminal, from the isolated viewer:
npm run test:runtime-selection -- http://127.0.0.1:8001
npm run test:regression -- --base-url http://127.0.0.1:8001 --wasm 32
npm run test:regression -- --base-url http://127.0.0.1:8001 --wasm 64
```

The selection browser test checks seven fresh contexts: auto 64, forced 32,
forced 64, simulated unavailable Memory64, mobile emulation, failed 64-bit
download, and an ordinary 32-only package. It loads a real USD scene, checks
the selected build label, and asserts that unused module pairs are not
requested. All seven pass locally in Chromium 149.0.7827.55. A failed 64-bit
download is the intentional exception: its failed JS request precedes the
32-bit pair. Forced-mode unit tests also ensure errors are not hidden by
fallback.

Manual checks:

- `http://localhost:8001/`: auto; a capable browser should show `wasm64-<hash>`.
- `http://localhost:8001/?wasm=32`: compatibility rendering, `wasm32-<hash>`.
- `http://localhost:8001/?wasm=64`: strict 64-bit rendering, or an explicit
  error if unsupported/unpackaged.
- In DevTools Network, filter `usdWebViewBindingsModule`, disable cache,
  clear the log, and reload. Normal startup requests exactly one generated
  JS file and one WASM file for the selected variant.
- To exercise startup failure fallback, block
  `http://localhost:8001/usd-webview-bindings/wasm64/*` in Chrome's Request
  conditions drawer and reload the auto URL (no `wasm=64`). This drawer uses
  URLPattern syntax; the old leading `*/` glob fails to parse. Match the actual
  host/port if different. Alternatively right-click the WASM64 module request
  in Network and choose Block request. Enable blocking, keep DevTools open,
  and clear unrelated Network filters. Expect a 32-bit build label and a
  fallback reason on hover or in Stats.
  Remove the block afterwards. This tests startup failure, not an unsupported
  engine; the automated test separately simulates the feature probe failure.

Chrome Device Mode changes viewport/input/device characteristics, not the
WebAssembly engine; it does **not** imply WASM32 fallback. The automated mobile
emulation case therefore still selects WASM64 on this browser. Consult
[Chrome's Device Mode limitations](https://developer.chrome.com/docs/devtools/device-mode)
and use real devices to test actual browser support and memory pressure.
Mobile hardware might support Memory64 yet still have little available RAM.

Large real-world USD memory residency and actual mobile-browser coverage are
still unverified; the 8 GiB WASM64 maximum is a build ceiling, not a promised
scene size.

---

# Repository Layout

The original workspace looked roughly like:

```text
USD/
├── OpenUSD/
├── MaterialX/
├── MaterialX_WASM_Build/
├── USD_WASM_Build/
├── emsdk/
└── usd-wg-webview/
```

---

# Source Revisions

## OpenUSD

Release: `v26.08`

Commit:

```text
ee47c679abde5b467a7b6a41f3b2285564a4222e
```

## usd-wg-webview

Use the source revision being built and preserve the generated artifact hash
records with it. Old source-revision examples are not provenance for new pairs.

## MaterialX

MaterialX is built from the standalone checkout at
`22f1c433e71f49a541a15c4b1f5f9084b97be226` (1.39.6 development revision).
This native dependency is distinct from the separately vendored ASWF
JavaScript/WASM validation runtime.

---

# Architecture

The WASM stack is built in layers:

```text
MaterialX source
    ↓
MaterialX_WASM_Build/install
    ↓
OpenUSD WASM build
    ↓
USD_WASM_Build
    ↓
native/usd-webview-bindings
    ↓
public/usd-webview-bindings
    ↓
browser runtime
```

---

# Emscripten

All native WASM builds use the Emscripten SDK.

Example:

```bash
source /path/to/emsdk/emsdk_env.sh
```

MaterialX and OpenUSD both target:

```text
Emscripten.cmake
```

---

# MaterialX WASM Build

MaterialX is built separately from OpenUSD.

This is important because the OpenUSD WASM build path does **not**
build MaterialX automatically.

## Key Configuration

Observed from:

```text
MaterialX_WASM_Build/build/CMakeCache.txt
```

```text
MATERIALX_BUILD_SHARED_LIBS=OFF

MATERIALX_BUILD_GEN_GLSL=ON

MATERIALX_BUILD_RENDER=OFF
MATERIALX_BUILD_VIEWER=OFF
MATERIALX_BUILD_TESTS=OFF
MATERIALX_BUILD_DOCS=OFF

MATERIALX_BUILD_OIIO=OFF
MATERIALX_BUILD_OCIO=OFF

MATERIALX_BUILD_JS=OFF
MATERIALX_BUILD_PYTHON=OFF
```

Install prefix:

```text
MaterialX_WASM_Build/install
```

Toolchain:

```text
emsdk/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake
```

### Representative Configure Command

```bash
emcmake cmake \
  -S MaterialX \
  -B MaterialX_WASM_Build/build \
  -DCMAKE_INSTALL_PREFIX=$(pwd)/MaterialX_WASM_Build/install \
  -DMATERIALX_BUILD_SHARED_LIBS=OFF \
  -DMATERIALX_BUILD_GEN_GLSL=ON \
  -DMATERIALX_BUILD_RENDER=OFF \
  -DMATERIALX_BUILD_VIEWER=OFF \
  -DMATERIALX_BUILD_TESTS=OFF
```

Build:

```bash
cmake --build MaterialX_WASM_Build/build --target install
```

---

# OpenUSD WASM Build

The webview WASM artifacts are built against OpenUSD `v26.08` (commit above).
The stock WASM target disables imaging and MaterialX, so this build enables
those components through USD CMake arguments. Build OpenSubdiv into the same
install prefix first, following the manual build below.

With `EMSDK` active and `MATERIALX_WASM_INSTALL` pointing at the MaterialX WASM
install, configure the WASM SDK with:

```bash
python3 build_scripts/build_usd.py \
  --build-target wasm \
  --no-imaging --no-materialx \
  --no-python --no-tests --no-tools --no-examples --no-tutorials --no-docs \
  --no-usdview --no-alembic --no-draco --no-openimageio --no-opencolorio \
  --no-openvdb --no-ptex --no-embree --no-prman \
  --build-args "USD,-DCMAKE_HAVE_LIBC_PTHREAD=1 -DTHREADS_HAVE_PTHREAD_ARG=ON -DPXR_BUILD_IMAGING=ON -DPXR_BUILD_USD_IMAGING=ON -DPXR_ENABLE_MATERIALX_SUPPORT=ON -DPXR_ENABLE_GL_SUPPORT=OFF -DPXR_ENABLE_PYTHON_SUPPORT=OFF -DPXR_ENABLE_PRECOMPILED_HEADERS=OFF -DMaterialX_DIR=${MATERIALX_WASM_INSTALL}/lib/cmake/MaterialX" \
  -j 8 \
  <install_dir>
```

For restricted build environments, point `EM_CACHE` at a writable directory
before building. `CMAKE_HAVE_LIBC_PTHREAD=1` and
`THREADS_HAVE_PTHREAD_ARG=ON` let CMake configure Emscripten's pthread support
without its compile probe.

OpenUSD 26.08's `hgi.cpp` also needs the documented Emscripten unknown-platform
branch below so the no-GPU WASM build returns `nullptr` instead of triggering
`#error Unknown Platform`.

The resulting install directory is:

```text
USD_WASM_Build
```

---

# OpenUSD WASM Configuration

Observed from:

```text
USD_WASM_Build/build/OpenUSD/CMakeCache.txt
```

## Core

```text
BUILD_SHARED_LIBS=OFF

CMAKE_FIND_ROOT_PATH=<USD_WASM_Build>

CMAKE_CXX_FLAGS=-pthread --use-port=zlib
CMAKE_EXE_LINKER_FLAGS=-pthread
```

## Imaging

```text
PXR_BUILD_IMAGING=ON
PXR_BUILD_USD_IMAGING=ON
```

## MaterialX

```text
PXR_ENABLE_MATERIALX_SUPPORT=ON

MaterialX_DIR=
<MaterialX_WASM_Build/install/lib/cmake/MaterialX>
```

This is the most important customization in the build.

The stock OpenUSD WASM build path explicitly disables MaterialX support.

MaterialX was enabled by pointing OpenUSD at a separately-built WASM MaterialX installation.

---

# Included Dependencies

Confirmed from build artifacts and generated package configs.

## oneTBB

```text
oneTBB 2021.12.0
```

Built automatically by the WASM target.

Libraries:

```text
libtbb.a
libtbbmalloc.a
```

---

## OpenSubdiv

```text
OpenSubdiv 3.6.1
```

Libraries:

```text
libosdCPU.a
libosdGPU.a
```

---

# Enabled USD Components

Confirmed from:

```text
USD_WASM_Build/pxrConfig.cmake
```

## MaterialX

```text
usdMtlx
hdMtlx
```

## Hydra

```text
hd
hdar
hdGp
hdsi
usdHydra
```

## USD Imaging

```text
usdImaging
usdProcImaging
usdSkelImaging
usdVolImaging
```

## Image IO

```text
hioOpenEXR
hioAvif
```

---

# WASM Bindings

Bindings are built from:

```text
usd-wg-webview/native/usd-webview-bindings
```

Browser-facing wrapper:

```text
usd-wg-webview/public/usd-webview-bindings/usdWebViewBindings.js
```

---

# Binding Build

Configure:

```bash
source /path/to/emsdk/emsdk_env.sh

emcmake cmake \
  -S native/usd-webview-bindings \
  -B build/usd-webview-bindings \
  -Dpxr_DIR=/path/to/USD_WASM_Build \
  -DTBB_DIR=/path/to/USD_WASM_Build/lib/cmake/TBB \
  -DUSD_WEBVIEW_OPENUSD_SOURCE_DIR=/path/to/OpenUSD
```

Build:

```bash
cmake --build build/usd-webview-bindings --target install
```

---

# Why OpenUSD Source Is Required

The bindings depend on OpenUSD private headers that are not installed into the WASM SDK.

Example:

```text
pxr/usd/sdf/usdzResolver.h
```

Because of this:

```text
USD_WASM_Build alone is insufficient.
An OpenUSD source checkout is also required.
```

---

# Native Rebuild Loop

After modifying native bindings:

```bash
source /path/to/emsdk/emsdk_env.sh

cmake --build build/usd-webview-bindings \
  --target install
```

Then run `npm run native:stamp` to derive cache identities from the generated
pair and wrapper. Never edit generated IDs manually. `npm run native:build`
combines install and stamping; repackage the 64-bit pair after rebuilding it.

---

# Newer OpenUSD WASM Fixups

When using newer OpenUSD / MaterialX checkouts, the stock OpenUSD WASM target
still disables imaging and MaterialX at the `build_usd.py` option layer. If
those features are forced back on with `--build-args USD,...`, expect these
additional fixups.

## MaterialX config may request X11

MaterialX 1.39.x can install a `MaterialXConfig.cmake` that unconditionally
requests X11 on Linux, even when consumed by an Emscripten build. Patch the
installed WASM MaterialX config to skip X11 under Emscripten:

```cmake
if(UNIX AND NOT APPLE AND NOT EMSCRIPTEN)
    find_dependency(X11 REQUIRED COMPONENTS Xt)
    ...
endif()
```

## OpenSubdiv may need a manual WASM build

If imaging is enabled only through USD CMake overrides, `build_usd.py` may not
schedule OpenSubdiv as a dependency. Build OpenSubdiv v3.6.1 into the same USD
WASM install prefix before building OpenUSD imaging:

```bash
emcmake cmake -S OpenSubdiv-3_6_1 -B USD_WASM_Build/build/OpenSubdiv-3_6_1 \
  -G Ninja \
  -DCMAKE_INSTALL_PREFIX=$PWD/USD_WASM_Build \
  -DNO_EXAMPLES=ON -DNO_TUTORIALS=ON -DNO_REGRESSION=ON -DNO_DOC=ON \
  -DNO_OMP=ON -DNO_CUDA=ON -DNO_OPENCL=ON -DNO_DX=ON \
  -DNO_TESTS=ON -DNO_GLEW=ON -DNO_GLFW=ON -DNO_PTEX=ON -DNO_TBB=ON \
  -DNO_METAL=ON -DNO_OPENGL=ON -DBUILD_SHARED_LIBS=OFF \
  -DOSD_PATCH_SHADER_SOURCE_GLSL=ON

cmake --build USD_WASM_Build/build/OpenSubdiv-3_6_1 --target install -j 8
```

## HGI unknown platform with GPU support off

With `PXR_ENABLE_GL_SUPPORT=OFF` / GPU support off, current OpenUSD can still
compile the base `hgi` library. Under Emscripten, `pxr/imaging/hgi/hgi.cpp` may
hit:

```text
#error Unknown Platform
```

For a no-GPU web extraction build, add an Emscripten branch before the unknown
platform fallback:

```cpp
#elif defined(__EMSCRIPTEN__)
    "";
    return nullptr;
```

This lets HGI compile without manufacturing a fake GL/Metal/Vulkan backend.

---

# Repro Checklist

To recreate the WASM environment on a new machine:

- Install emsdk
- Build MaterialX for WASM
- Build OpenUSD for WASM
- Enable MaterialX support in OpenUSD
- Build usd-webview-bindings for both architectures
- Run content-derived stamping and import the WASM64 release pair
- Verify both pairs and build the production package
- Run forced 32/64 visual suites and selection/fallback/Stats checks

Required source trees:

```text
OpenUSD/
MaterialX/
usd-wg-webview/
```

Required generated artifacts:

```text
MaterialX_WASM_Build/
USD_WASM_Build/
```
