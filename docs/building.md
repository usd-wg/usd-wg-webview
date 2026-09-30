Note:
This document assumes a prebuilt OpenUSD WASM SDK exists.
For details on recreating the OpenUSD + MaterialX WASM toolchain from scratch, see [wasm-sdk.md](wasm-sdk.md).

# Building USD Web View

## Prerequisites

- [Emscripten SDK (emsdk)](https://emscripten.org/docs/getting_started/downloads.html)
- An OpenUSD WASM build (see below)
- A native OpenUSD source checkout (needed for private headers not installed by the WASM SDK)
- CMake 3.20+
- Node.js + npm

## 1. Build OpenUSD for WASM

The current webview WASM module targets OpenUSD `v26.08` at commit
`ee47c679abde5b467a7b6a41f3b2285564a4222e`. Follow the version-specific
toolchain and component settings in [wasm-sdk.md](wasm-sdk.md); the stock WASM
target disables imaging and MaterialX, which this project enables.

Build OpenUSD using the version-specific command in [wasm-sdk.md](wasm-sdk.md).
It includes the imaging and MaterialX settings required by this viewer.

This produces static libraries and CMake config files under `/path/to/USD_WASM_Build`.

## 2. Build the WASM bindings

From the repository root:

```sh
source /path/to/emsdk/emsdk_env.sh

# Override CMAKE_BIN when `cmake` is not already on PATH.
export CMAKE_BIN="${CMAKE_BIN:-cmake}"

emcmake $CMAKE_BIN -S native/usd-webview-bindings -B build/usd-webview-bindings \
  -DCMAKE_BUILD_TYPE=Release \
  -Dpxr_DIR=/path/to/USD_WASM_Build \
  -DTBB_DIR=/path/to/USD_WASM_Build/lib/cmake/TBB \
  -DUSD_WEBVIEW_OPENUSD_SOURCE_DIR=/path/to/OpenUSD \
  -DCMAKE_INSTALL_PREFIX=$(pwd)/public/usd-webview-bindings

$CMAKE_BIN --build build/usd-webview-bindings --target install -- -j$(sysctl -n hw.logicalcpu)
```

`USD_WEBVIEW_OPENUSD_SOURCE_DIR` points at the OpenUSD **source** checkout. It is needed for private headers (e.g. `pxr/usd/sdf/usdzResolver.h`) that the WASM install does not include.

This installs the generated module artifacts into `public/usd-webview-bindings/`:

| File                            | Description                           |
| ------------------------------- | ------------------------------------- |
| `usdWebViewBindingsModule.js`   | Emscripten-generated JS glue          |
| `usdWebViewBindingsModule.wasm` | Compiled OpenUSD WASM binary (~19 MB) |

The browser-facing wrapper is currently maintained separately at:

```text
public/usd-webview-bindings/usdWebViewBindings.js
```

## 3. Run the frontend

```sh
npm install
npm run dev
```

Open the URL printed by Vite. The runtime panel should report **ready** once the WASM module loads.

Plain `npm install` is enough for the frontend dependencies, including the
pinned upstream Three.js dev snapshot and the checked-in official MaterialX
JavaScript/WASM validation runtime.

## Rebuilding after C++ changes

Re-run the `cmake --build` and install step from section 2. The `emcmake cmake` configure step only needs to be re-run when CMake variables change.

```sh
source /path/to/emsdk/emsdk_env.sh
export CMAKE_BIN="${CMAKE_BIN:-cmake}"
$CMAKE_BIN --build build/usd-webview-bindings --target install -- -j$(sysctl -n hw.logicalcpu)
```

Then stamp the browser cache-bust ids before reloading the app:

```sh
npm run native:stamp
```

This is required after every native rebuild, or the browser can keep serving an
older wrapper or WASM binary and make a native fix look like it failed.
`npm run native:build` runs the cmake install step and the stamp in one go.

## Rebuilding after JS wrapper changes

The browser-facing wrapper currently lives directly in:

```text
public/usd-webview-bindings/usdWebViewBindings.js
```

Editing that file does not require a native rebuild. The Vite dev server picks
up changes in `public/` automatically.

## Binding Version Bumps

Cache-bust ids are content-derived and stamped automatically — never edit them
by hand. `node tools/native-build/stamp-build.mjs` (or `npm run native:stamp`)
hashes the wasm and rewrites:

- `public/usd-webview-bindings/usdWebViewBindings.js` (`_wasmBuildId`,
  `_wrapperBuildId`)
- `src/usd/generated/buildId.ts` (`WASM_BUILD_NAME`, imported by
  `UsdWebViewRuntime.ts`)

Recommended rebuild loop:

```sh
source /path/to/emsdk/emsdk_env.sh
npm run native:build   # cmake --build ... --target install && native:stamp
```

## MaterialX Note

Current MaterialX behavior in this repo uses:

- Three's MaterialX loader in top-left UV space
- MaterialX meshes flip UV `V` on the final geometry before sampling
- inline MaterialX graphs that use EXR image nodes can fall back to standard
  texture slots, because Three's MaterialX image path does not currently handle
  those EXRs correctly; fallback meshes keep authored UVs and do not apply the
  MaterialX `V` flip

If MaterialX output suddenly regresses after a viewer refactor, verify the
loader `uvSpace` option in `src/viewer/MaterialFactory.ts`, the MaterialX
`Flip V` path in `src/viewer/GeometryBuilder.ts`, and the EXR fallback rules in
`src/viewer/materialXCompatibility.ts`; the unified stage driver already
delivers UVs on the same corner stream as positions.
