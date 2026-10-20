# OpenUSD + MaterialX WASM Build Notes

## Purpose

This document records the full OpenUSD + MaterialX + WebAssembly build pipeline used by `usd-wg-webview`.

The goal is to make it possible to recreate the entire WASM SDK from scratch on a new machine without reverse-engineering old build artifacts.

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

Commit:

```text
2095fafafd033fa23386d7ec6d58c7cc33974518
```

## MaterialX

MaterialX was built from a standalone source checkout.

**TODO:** record exact commit if available.

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

Then update:

```text
public/usd-webview-bindings/usdWebViewBindings.js
  _wasmBuildId
  _wrapperBuildId

src/usd/UsdWebViewRuntime.ts
  RUNTIME_ENTRYPOINT
```

to force browser cache invalidation.

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
- Build usd-webview-bindings
- Update browser cache-bust identifiers
- Verify runtime loads successfully

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
