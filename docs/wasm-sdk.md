# Building the OpenUSD WASM SDK from source

This is the canonical fresh-machine runbook for **both** native runtimes.
No maintainer SDK, local archive, private repository, or prebuilt viewer WASM
is required to compile them. The compiler itself is the pinned binary
Emscripten distribution, not a from-source LLVM build.

For frontend-only development, use the checked-in runtimes and
[building.md](building.md). You do not need this expensive SDK build.

## Prerequisites and supported hosts

The tested host is Linux x86-64 (including WSL2). Windows contributors should
use WSL2 with the checkout on the Linux filesystem. The scripts use Bash,
Node, Git, Python, CMake and Ninja; they avoid macOS-only commands. Native
macOS execution is not yet validated for this complete recipe.
Use checkout and SDK paths without whitespace; the native whole-archive link
arguments currently require that layout.

Install Node.js **22+** with npm, Git, Python **3.10+**, CMake **3.27+**, Ninja,
a host C/C++ toolchain, and CA certificates. On Ubuntu 24.04 / WSL Ubuntu 24.04:

```sh
sudo apt-get update
sudo apt-get install -y build-essential git python3 cmake ninja-build ca-certificates
# Install Node.js 22+ separately if needed: https://nodejs.org/en/download
node --version
cmake --version
ninja --version
```

Older Ubuntu releases may supply an insufficient CMake. Install a newer
[Kitware release](https://cmake.org/download/) and put it first on PATH.
OpenUSD requires 3.27; the bindings' own CMake minimum is not the SDK minimum.
Allow several gigabytes of disk plus toolchain downloads, and substantial
RAM during compilation/linking. `BUILD_JOBS=8` is the default; use 2 or 4 on
smaller machines. First builds take substantially longer than incremental
binding builds. Network access is needed for GitHub, emsdk downloads, npm,
and Emscripten's pinned zlib port on first use.

## 1. Checkout and install frontend dependencies

```sh
git clone https://github.com/usd-wg/usd-wg-webview.git
cd usd-wg-webview
# Before this feature merges, select its branch:
git switch feat/wasm64-runtime
npm ci
```

The source build replaces generated runtime files in this checkout. Use a
separate clean clone/worktree if you need to preserve an existing runtime.

## 2. Install the pinned compiler

From the viewer repository root:

```sh
mkdir -p build
git clone --branch 6.0.0 --depth 1 https://github.com/emscripten-core/emsdk.git build/emsdk
test "$(git -C build/emsdk rev-parse HEAD)" = d223ae73c6998296e3ab27cf81dc2c2c9fd383de
./build/emsdk/emsdk install 6.0.0
./build/emsdk/emsdk activate 6.0.0
export EMSDK_ROOT="$PWD/build/emsdk"
```

Skip cloning if already installed; reuse an activated **6.0.0** SDK by setting
`EMSDK_ROOT` to its absolute directory. Do not use `latest`: source/library
and generated-glue compatibility depend on the compiler. The builders source
`emsdk_env.sh` themselves and reject a different compiler version. The
[official emsdk installation guide](https://emscripten.org/docs/getting_started/downloads.html)
describes installation/activation and platform prerequisites.

## 3. Build both complete dependency stacks and bindings

```sh
export BUILD_JOBS=8
npm run native:source
npm run build
```

`native:source` defaults to `both`. In order it:

1. Downloads exact Git commits and applies the checked-in patches.
2. Builds MaterialX → OpenSubdiv → oneTBB → OpenUSD separately for WASM32.
3. Builds/installs the WASM32 bindings and stamps their content-derived IDs.
4. Repeats the SDK and binding build for WASM64 with separate CMake caches.
5. Imports the newly built WASM64 pair into its canonical release directory,
   packages both pairs, and verifies their hashes and architecture.

No prebuilt SDK libraries are used. There is no dependency on another checkout.
Both architectures share source files, not object files or installed libraries.
The source build is incremental: rerun the same command after an interruption.
Failed fetches leave a named `.fetch-*` directory for diagnosis; they are not
reused as completed source checkouts.

All SDK state defaults to this ignored layout:

```text
build/emsdk/                         # compiler (unless an external SDK is used)
build/wasm-sdk/
  sources/{OpenUSD-v26.08,MaterialX-22f1c433,OpenSubdiv-3_6_1,oneTBB-2021.12.0}/
  build/{wasm32,wasm64}/{materialx,opensubdiv,tbb,openusd}/
  install/{wasm32,wasm64}/{materialx,usd}/
  emscripten-cache/
  ccache/
build/usd-webview-bindings/          # WASM32 binding CMake cache
build/usd-webview-bindings-wasm64/   # WASM64 binding CMake cache
```

Set `USD_WASM_LAB_ROOT` to an absolute directory to relocate SDK state;
the default is **not** the checkout's parent directory anymore. Keep the same
root and compiler when resuming. Old archive-based lab directories are not
accepted by the new Git-revision verifier; use a fresh root instead of
resetting or overwriting those sources.

Outputs that change in Git:

- `public/usd-webview-bindings/usdWebViewBindingsModule.{js,wasm}` and `build.json`.
- Content stamps in the shared wrapper and `src/usd/generated/buildId.ts`.
- `native/artifacts/wasm64/` (the new generated pair and hash record).

The WASM64 staging output is `public/localAssets/wasm64-runtime/`.
`native:package` copies the canonical pair into a content-addressed public
directory and emits `runtimes.json`; these public packaging outputs are ignored.
Never copy only the JS glue or only the WASM, and never invent build IDs by hand.

## Pinned inputs and required patches

`tools/native-build/sources.json` is the machine-readable source lock.

| Component | Revision |
| --- | --- |
| Emscripten | 6.0.0 |
| OpenUSD 26.08 | `ee47c679abde5b467a7b6a41f3b2285564a4222e` |
| MaterialX 1.39.6 development revision | `22f1c433e71f49a541a15c4b1f5f9084b97be226` |
| OpenSubdiv 3.6.1 | `f26d0dedeaf846ea321865a527bb4489691c2f04` |
| oneTBB 2021.12.0 | `9afd759b72c0c233cd5ea3c3c06b0894c9da9c54` |

Preparation verifies HEAD, the expected patch diff, and absence of unexpected
untracked source files. It refuses mismatched revisions or additional edits;
it never resets an existing source tree. `npm run native:prepare -- --check`
performs the checks without downloads or modifications.

The two patches live under `tools/native-build/patches/`:

- MaterialX: change **the source** `cmake/modules/MaterialXConfig.cmake.in`
  so Emscripten consumers do not request X11. Editing the installed config is
  insufficient: a reinstall would overwrite that edit.
- OpenUSD: let `pxr/imaging/hgi/hgi.cpp` return no platform GPU backend under
  Emscripten. Geometry/material extraction needs imaging libraries, but this
  browser viewer renders through Three.js, not a native HGI backend.

The scripts are the authoritative CMake option list. Both stacks are static;
OpenUSD imaging, USD imaging, and MaterialX support are enabled, while native
GL/Metal/Vulkan, Python bindings, tools, and optional render plugins are off.
OpenSubdiv and oneTBB are built explicitly, not borrowed from the host.
Bindings need the pinned OpenUSD source directory for private headers such as
`usdzResolver.h`, as well as `pxr_DIR`, `TBB_DIR`, `OpenSubdiv_DIR`, and
`MaterialX_DIR`; the binding script supplies all of these.

WASM32 must **omit** `MEMORY64`, not set `-sMEMORY64=0`: Emscripten 6.0.0's
CMake toolchain treats the flag's presence as a pointer-size override.
WASM64 uses `-sMEMORY64=1` throughout and explicit `WASM_BIGINT=1` /
8 GiB maximum memory at the final link. Both use growing linear memory.
The environment helper sets writable cache directories **after** sourcing
emsdk, which clears some pre-existing Emscripten environment variables.

This pins compiler/dependency inputs, but is not a claim of byte-identical
builds across hosts, paths, or CMake versions. Content hashes identify actual
outputs; browser tests establish behavior.

## Partial and incremental builds

Prepare/download only:

```sh
npm run native:prepare
npm run native:prepare -- --check
```

Rebuild a single complete stack (the other canonical runtime must already
exist for packaging; do not use this alone to release a shared native change):

```sh
npm run native:source -- wasm32
npm run native:source -- wasm64
```

After a bindings-only C++ change, reuse the prepared and installed SDKs:

```sh
export EMSDK_ROOT="$PWD/build/emsdk"
bash tools/native-build/build-local-bindings.sh wasm32
bash tools/native-build/build-local-bindings.sh wasm64
npm run native:package -- public/localAssets/wasm64-runtime
npm run native:verify
npm run build
```

For a dependency build without installing viewer bindings:

```sh
bash tools/native-build/build-local-sdk.sh wasm32
bash tools/native-build/build-local-sdk.sh wasm64
```

These commands assume `native:prepare` already succeeded. Always rebuild both
variants after shared C++ or dependency changes. Wrapper-only edits need
`native:stamp` and `native:package`, not a native compile.

## 4. Validate the rebuilt site

```sh
npx playwright install --with-deps chromium
npm run test:unit
npm run test:artifacts
npm run build
npm run test:dist -- smoke
npm run test:dist -- 32
npm run test:dist -- 64
git diff --check
```

Run browser suites sequentially. They use a temporary production-preview
server (port 8010 by default), assert the selected architecture, and exercise
the actual generated pairs. Smoke covers seven selection/fallback cases and
Stats on both architectures; each visual mode runs the full corpus.
Do not bless differences merely to make a native upgrade pass.

Routine CI verifies and browser-tests the checked-in pairs; it does **not**
compile the SDK from scratch. A frontend CI pass alone is not evidence that
a new native source-build recipe works. See
[building.md](building.md#ci-and-release-checks) for artifact ownership and
the release gate.

### Source-build validation record

On 2026-10-20, both stacks were rebuilt on Linux x86-64 / WSL2 from fresh
public Git downloads, using empty SDK build/install/cache directories and the
existing Emscripten 6.0.0 compiler installation. The resulting production
package passed 72 unit tests, 10 artifact/bootstrap tests, all seven runtime
selection cases, Stats checks on both architectures, and all 23 visual captures
per architecture without baseline changes. Source verification also passed
after building. This validates the dependency reconstruction and resulting
runtimes locally; it is not a clean-OS/compiler-install test, macOS certification,
or a large-scene memory benchmark.

## Troubleshooting and upgrades

- Missing source/patch: run `native:prepare`. Unexpected source edits require
  preserving your work and choosing a new SDK root, not a force reset.
- CMake package-size mismatch: ensure 32-bit flags omit `MEMORY64` entirely.
  Do not reuse an architecture's CMake cache for the other architecture.
- X11 requested: verify the MaterialX source patch and rebuild/install it.
- OpenSubdiv not found: use the binding script, which supplies its config path.
- Old compiler or moved SDK: install/activate 6.0.0 and set `EMSDK_ROOT` again.
- Killed compiler/linker: reduce `BUILD_JOBS`, check RAM/swap/disk, and rerun.
- `invoke_* function import requires a callable`: verify the JS/WASM pair and
  repackage; see [runtime troubleshooting](building.md#runtime-troubleshooting).
- Keep SDK state and binding CMake caches tied to one source lock/compiler.
  For upgrades, use a fresh SDK root **and a fresh viewer checkout/worktree**,
  update the lock/patches/docs and versioned source directory names in the build
  scripts, build both variants, then run the complete gate.
  Existing binding caches retain absolute SDK paths.

## Runtime options and memory testing

### Current runtime contract

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


Full-island/high-residency USD and actual mobile-device benchmarks remain
pending. An 8 GiB build ceiling is not a promised supported scene size.

### Standalone high-address probe

This tests addresses above 4 GiB separately from OpenUSD. It does not load
a huge scene or establish multi-gigabyte physical residency:

```sh
source "$EMSDK_ROOT/emsdk_env.sh"
export EM_CACHE="$PWD/build/wasm-sdk/emscripten-cache"
mkdir -p public/localAssets/wasm64-probe
em++ tools/native-build/memory64-probe.cpp \
  --bind --no-entry -O2 -sMEMORY64=1 -sWASM_BIGINT=1 \
  -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=8589934592 \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web \
  -o public/localAssets/wasm64-probe/probe.mjs
npm run dev -- --port 8001
# Other terminal:
node tools/native-build/run-memory64-probe.mjs http://127.0.0.1:8001
```

The probe accesses both sides of 4 GiB, detects truncated-pointer aliasing,
copies a high-address typed array through Embind, grows memory, and checks
that the JavaScript-owned copy survives. It touches only sparse pages and
boundary sentinels. Historical local Chromium checks passed this probe and
both small-scene visual suites; neither proves large-scene residency.

## Large-scene metrics in ? → Stats

The existing Stats panel includes live load/runtime/resource sections; there
is no separate diagnostics window. Open it on the viewer you are testing.
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
npm run test:dist -- smoke
```

The browser test checks both architectures, positive allocator counters,
2/8 GiB ceilings, file accounting, replacement reset, unavailable browser heap
reporting, and existing-panel open/close/narrow-width behavior. Screenshots
are saved to `/tmp/usd-stats-wasm32.png` and `/tmp/usd-stats-wasm64.png`.


## Selection verification

```sh
npm run dev -- --port 8001
# Other terminal:
npm run test:runtime-selection -- http://127.0.0.1:8001
```

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
