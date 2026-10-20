# Building USD Web View

## Frontend quick start (no native SDK required)

The repository supplies two verified prebuilt OpenUSD 26.08 binding pairs.
That USD version is inherited from `main` (PR #31), not introduced by the
WASM64 feature. Normal frontend development and CI do not rebuild the SDK.

```sh
npm ci
npm run dev             # packages both pairs, then starts Vite on port 8000
npm run build           # packages, compiles, then verifies dist/
npm run preview         # serves the built site
```

Use `npm run dev -- --port 8001` when another worktree occupies port 8000.
The MaterialX-editor worktree and the WASM release worktree are independent.

## Native-build prerequisites

- [Emscripten SDK (emsdk)](https://emscripten.org/docs/getting_started/downloads.html)
- An OpenUSD WASM build (see below)
- A native OpenUSD source checkout (needed for private headers not installed by the WASM SDK)
- CMake 3.20+
- Node.js + npm

The following native steps are needed only when rebuilding bindings. For the
complete dual-architecture SDK reconstruction, see [wasm-sdk.md](wasm-sdk.md).

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
npm ci
npm run dev
```

Open the URL printed by Vite. The runtime panel should report **ready** once the WASM module loads.

Use `npm ci` to install the exact locked frontend dependencies, including the
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
up changes in `public/` automatically. Run `npm run native:stamp` after wrapper
edits so deployed clients also receive a new cache identity.

## Binding Version Bumps

Cache-bust ids are content-derived and stamped automatically — never edit them
by hand. `node tools/native-build/stamp-build.mjs` (or `npm run native:stamp`)
hashes the WASM, generated JavaScript glue, and maintained wrapper (excluding
the stamp lines themselves). The default WASM32 identity is `wasm32-<hash>`.
It rewrites:

- `public/usd-webview-bindings/usdWebViewBindings.js` (`_wasmBuildId`,
  `_wrapperBuildId`)
- `src/usd/generated/buildId.ts` (`WASM_BUILD_NAME`, imported by
  `UsdWebViewRuntime.ts`)
- The WASM32 entry in `public/usd-webview-bindings/runtimes.json`, if packaged.

Recommended rebuild loop:

```sh
source /path/to/emsdk/emsdk_env.sh
npm run native:build   # cmake --build ... --target install && native:stamp
```

## Dual-runtime packaging and deployment

Artifact ownership:

| Location | Role | Version controlled |
| --- | --- | --- |
| `public/usd-webview-bindings/usdWebViewBindingsModule.{js,wasm}` and `build.json` | WASM32 pair and hash record | Yes |
| `native/artifacts/wasm64/` | WASM64 pair and hash record | Yes |
| `public/usd-webview-bindings/usdWebViewBindings.js` | Shared maintained wrapper | Yes |
| `public/usd-webview-bindings/runtimes.json` and `wasm64/<hash>/` | Generated dual-runtime package | No |
| `public/localAssets/` | Local experiments/scenes | No; never deployed |

Normal development/build commands invoke `native:package` automatically.
It reads the canonical prebuilt pairs without downloading files or requiring
the native SDK. Missing or mismatched artifacts and stale wrapper stamps
fail the build instead of silently producing a 32-only release.

After rebuilding **both** native variants as described in
[wasm-sdk.md](wasm-sdk.md), import the new 64-bit pair:

```sh
npm run native:package -- public/localAssets/wasm64-runtime
npm run native:verify
npm run build
```

An explicit source argument validates and copies that pair plus its hash record
to `native/artifacts/wasm64/`; include those files in the change alongside the
WASM32 artifacts and generated stamps. Calling `native:package` with no argument
recreates the public package from the canonical pairs. It verifies both JS and
WASM hashes, file sizes, memory architecture, and the WASM32 cache stamp.
`native:verify` is read-only and verifies the generated package too.

Vite's release public-assets filter excludes `localAssets`, `testAssets`, and
unselected old WASM64 directories. `postbuild` verifies the hashes/architectures
of the files actually in `dist/` and rejects extra 64-bit artifacts or local
scene directories. Deploy **all of `dist/` together**, not just the frontend
bundle or one WASM file. Keep manifest/HTML revalidation enabled; hashed WASM64
paths may be cached immutably. Serve WASM with `application/wasm`.

Startup fetches the small manifest and validates a zero-page Memory64 probe
locally. It downloads only the selected pair (one generated JS file and one
WASM file), not both variants. A missing manifest retains legacy WASM32-only
compatibility, but is not an accepted release package. In auto mode, WASM64
initialization failure retries WASM32 once.
There is no runtime switch after a scene load or out-of-memory failure.

Use `?wasm=32` or `?wasm=64` to force a variant; forced 64 never silently
downgrades. Omit the parameter for auto selection. The status-bar build name
identifies the **loaded** runtime as `wasm32-<hash>` or `wasm64-<hash>`;
hover it for any startup fallback reason. The wrapper's own cache identity
still belongs to the default WASM32 package, not the selected 64-bit pair.

## CI and release checks

`.github/workflows/test.yml` runs on PRs, `main`, and the WASM feature branch:

1. `package`: locked npm install, unit tests, artifact tests, production build,
   and verification; uploads one candidate `viewer-dist` artifact.
2. `regression`: independent forced-WASM32/WASM64 matrix jobs download that
   exact artifact and run the full visual corpus against production preview.
   Reports include the loaded architecture/build identity.
3. `selection-and-stats`: downloads the same artifact; checks auto selection,
   forced modes, unavailable Memory64, mobile emulation, blocked 64-bit
   startup, legacy 32-only fallback, and Stats on both runtimes.
4. `release-ready`: fails unless all preceding jobs succeeded. Use this
   aggregate result as the release/merge gate. The uploaded candidate artifact
   alone is not evidence that browser checks passed.

No hosting deployment is configured by this workflow. CI tests the prebuilt
pairs, not a from-source OpenUSD rebuild. Native changes require maintainers
to rebuild/stamp **both** pairs and include them; hashes verify byte integrity,
not provenance or correspondence to C++ source.

Run the same checks locally:

```sh
npm run test:unit
npm run test:artifacts
npm run build
npm run test:dist -- smoke
npm run test:dist -- 32
npm run test:dist -- 64
```

`test:dist` owns a temporary preview server on port 8010; set `USD_TEST_PORT`
to override. Run the two visual modes sequentially locally because the runner
reuses `test-results/regression/results/` (CI jobs have isolated workspaces).
Fixtures are served by Playwright interception, not shipped in `dist/`.

## Runtime troubleshooting

- `invoke_* ... function import requires a callable`: first suspect mismatched
  generated JavaScript/WASM files. Run `native:verify`, rebuild/stamp the
  affected pair if necessary, repackage, and reload. Never copy just one half
  of the pair or manually invent a new cache ID.
- A `wasm-...` label without an architecture prefix indicates an older viewer;
  check the worktree/port and reload before interpreting results.
- Chrome's Request conditions drawer uses URLPattern syntax. For local
  fallback testing use `http://localhost:8001/usd-webview-bindings/wasm64/*`,
  matching the actual host/port, rather than a leading `*/` glob. Or right-click
  the WASM64 request and choose Block request. Test the auto URL, not forced 64.
- Old crate-format messages such as “deprecated version 0.7.0” are OpenUSD
  asset warnings, not Memory64 failures. The current reader still supports
  those assets; future-reader compatibility is a separate asset-maintenance
  concern. Native stderr currently appears through the browser's error logger,
  which can add long stack traces even to warnings.

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
