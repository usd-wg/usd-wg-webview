#!/usr/bin/env bash
# Build one pinned SDK. Run native:prepare first; see docs/wasm-sdk.md.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/sdk-environment.sh"
node "$viewer_root/tools/native-build/prepare-sources.mjs" --check

arch="${1:-wasm32}"
case "$arch" in
  # Emscripten 6.0.0's CMake toolchain matches the presence of MEMORY64,
  # including MEMORY64=0, when choosing pointer size. Omit it for wasm32.
  wasm32) flags="" ;;
  wasm64) flags="-sMEMORY64=1" ;;
  *) echo "Usage: bash $0 [wasm32|wasm64]" >&2; exit 2 ;;
esac
jobs="${BUILD_JOBS:-8}"
sources="$lab_root/sources"
build_root="$lab_root/build/$arch"
install_root="$lab_root/install/$arch"
usd_source="$sources/OpenUSD-v26.08"
mtlx_source="$sources/MaterialX-22f1c433"
usd_install="$install_root/usd"
mtlx_install="$install_root/materialx"

mkdir -p "$build_root" "$install_root"

common=(-G Ninja -DCMAKE_BUILD_TYPE=Release
  -DCMAKE_INSTALL_LIBDIR=lib
  "-DCMAKE_C_FLAGS=$flags" "-DCMAKE_CXX_FLAGS=$flags"
  -DCMAKE_HAVE_LIBC_PTHREAD=1 -DTHREADS_HAVE_PTHREAD_ARG=ON)

emcmake cmake -S "$mtlx_source" -B "$build_root/materialx" "${common[@]}" \
  "-DCMAKE_INSTALL_PREFIX=$mtlx_install" \
  -DMATERIALX_BUILD_SHARED_LIBS=OFF -DMATERIALX_BUILD_GEN_GLSL=ON \
  -DMATERIALX_BUILD_RENDER=OFF -DMATERIALX_BUILD_VIEWER=OFF \
  -DMATERIALX_BUILD_TESTS=OFF -DMATERIALX_BUILD_DOCS=OFF \
  -DMATERIALX_BUILD_OIIO=OFF -DMATERIALX_BUILD_OCIO=OFF \
  -DMATERIALX_BUILD_JS=OFF -DMATERIALX_BUILD_PYTHON=OFF
cmake --build "$build_root/materialx" --target install --parallel "$jobs"

emcmake cmake -S "$sources/OpenSubdiv-3_6_1" -B "$build_root/opensubdiv" "${common[@]}" \
  "-DCMAKE_INSTALL_PREFIX=$usd_install" -DBUILD_SHARED_LIBS=OFF \
  -DNO_EXAMPLES=ON -DNO_TUTORIALS=ON -DNO_REGRESSION=ON -DNO_DOC=ON \
  -DNO_OMP=ON -DNO_CUDA=ON -DNO_OPENCL=ON -DNO_DX=ON -DNO_TESTS=ON \
  -DNO_GLEW=ON -DNO_GLFW=ON -DNO_PTEX=ON -DNO_TBB=ON -DNO_METAL=ON \
  -DNO_OPENGL=ON -DOSD_PATCH_SHADER_SOURCE_GLSL=ON
cmake --build "$build_root/opensubdiv" --target install --parallel "$jobs"

emcmake cmake -S "$sources/oneTBB-2021.12.0" -B "$build_root/tbb" "${common[@]}" \
  "-DCMAKE_INSTALL_PREFIX=$usd_install" -DBUILD_SHARED_LIBS=OFF \
  "-DCMAKE_C_FLAGS=$flags -pthread --use-port=zlib" \
  "-DCMAKE_CXX_FLAGS=$flags -pthread --use-port=zlib" \
  -DTBB_TEST=OFF -DTBB_STRICT=OFF
cmake --build "$build_root/tbb" --target install --parallel "$jobs"

emcmake cmake -S "$usd_source" -B "$build_root/openusd" "${common[@]}" \
  "-DCMAKE_INSTALL_PREFIX=$usd_install" "-DCMAKE_FIND_ROOT_PATH=$usd_install" \
  "-DCMAKE_C_FLAGS=$flags -pthread --use-port=zlib" \
  "-DCMAKE_CXX_FLAGS=$flags -pthread --use-port=zlib" \
  "-DCMAKE_EXE_LINKER_FLAGS=$flags -pthread" \
  "-DTBB_DIR=$usd_install/lib/cmake/TBB" \
  "-DOPENSUBDIV_INCLUDE_DIR=$usd_install/include" \
  "-DOPENSUBDIV_OSDCPU_LIBRARY=$usd_install/lib/libosdCPU.a" \
  "-DMaterialX_DIR=$mtlx_install/lib/cmake/MaterialX" \
  -DBUILD_SHARED_LIBS=OFF -DPXR_FIND_TBB_IN_CONFIG=ON \
  -DPXR_BUILD_IMAGING=ON -DPXR_BUILD_USD_IMAGING=ON \
  -DPXR_ENABLE_MATERIALX_SUPPORT=ON -DPXR_ENABLE_GL_SUPPORT=OFF \
  -DPXR_ENABLE_METAL_SUPPORT=OFF -DPXR_ENABLE_VULKAN_SUPPORT=OFF \
  -DPXR_ENABLE_PYTHON_SUPPORT=OFF -DPXR_ENABLE_PRECOMPILED_HEADERS=OFF \
  -DPXR_BUILD_TESTS=OFF -DPXR_BUILD_EXAMPLES=OFF -DPXR_BUILD_TUTORIALS=OFF \
  -DPXR_BUILD_DOCUMENTATION=OFF -DPXR_BUILD_USD_TOOLS=OFF \
  -DPXR_BUILD_USDVIEW=OFF -DPXR_BUILD_USD_VALIDATION=OFF \
  -DPXR_BUILD_ALEMBIC_PLUGIN=OFF -DPXR_BUILD_DRACO_PLUGIN=OFF \
  -DPXR_BUILD_OPENIMAGEIO_PLUGIN=OFF -DPXR_BUILD_OPENCOLORIO_PLUGIN=OFF \
  -DPXR_BUILD_EMBREE_PLUGIN=OFF -DPXR_BUILD_PRMAN_PLUGIN=OFF \
  -DPXR_ENABLE_OPENVDB_SUPPORT=OFF -DPXR_ENABLE_PTEX_SUPPORT=OFF
cmake --build "$build_root/openusd" --target install --parallel "$jobs"

echo "SDK ready: $usd_install"
echo "Next: bash tools/native-build/build-local-bindings.sh $arch"
