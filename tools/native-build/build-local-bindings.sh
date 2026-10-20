#!/usr/bin/env bash
set -euo pipefail
viewer_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
lab_root="${USD_WASM_LAB_ROOT:-$(dirname "$viewer_root")}"
: "${EMSDK_ROOT:?Set EMSDK_ROOT to the Emscripten SDK used for the SDK build}"
set +u
source "$EMSDK_ROOT/emsdk_env.sh"
set -u
export EM_CACHE="$lab_root/emscripten-cache"
export CCACHE_DIR="$lab_root/ccache"
export CMAKE_BUILD_PARALLEL_LEVEL="${BUILD_JOBS:-8}"
arch="${1:-wasm32}"
case "$arch" in
  wasm32)
    flags=""
    link_flags=""
    build_dir="$viewer_root/build/usd-webview-bindings"
    output_dir="$viewer_root/public/usd-webview-bindings"
    ;;
  wasm64)
    flags="-sMEMORY64=1"
    link_flags="-sMEMORY64=1 -sWASM_BIGINT=1 -sMAXIMUM_MEMORY=8589934592"
    build_dir="$viewer_root/build/usd-webview-bindings-wasm64"
    output_dir="$viewer_root/public/localAssets/wasm64-runtime"
    ;;
  *) echo "Usage: bash $0 [wasm32|wasm64]" >&2; exit 2 ;;
esac
usd_install="$lab_root/install/$arch/usd"
mtlx_install="$lab_root/install/$arch/materialx"
test -f "$usd_install/pxrConfig.cmake"
emcmake cmake -S "$viewer_root/native/usd-webview-bindings" -B "$build_dir" \
  -G Ninja -DCMAKE_BUILD_TYPE=Release \
  "-DCMAKE_C_FLAGS=$flags" "-DCMAKE_CXX_FLAGS=$flags" \
  "-DCMAKE_EXE_LINKER_FLAGS=$link_flags" \
  "-Dpxr_DIR=$usd_install" "-DTBB_DIR=$usd_install/lib/cmake/TBB" \
  "-DOpenSubdiv_DIR=$usd_install/lib/cmake/OpenSubdiv" \
  "-DMaterialX_DIR=$mtlx_install/lib/cmake/MaterialX" \
  "-DUSD_WEBVIEW_OPENUSD_SOURCE_DIR=$lab_root/sources/OpenUSD-v26.08" \
  "-DCMAKE_INSTALL_PREFIX=$output_dir"
cd "$viewer_root"
if [[ "$arch" == wasm32 ]]; then
  npm run native:build
else
  cmake --build "$build_dir" --target install
  node tools/native-build/stamp-experiment.mjs "$output_dir"
fi
