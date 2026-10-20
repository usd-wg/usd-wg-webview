#!/usr/bin/env bash
# Shared by the SDK and binding builders; source only after set -euo pipefail.
viewer_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
lab_root="${USD_WASM_LAB_ROOT:-$viewer_root/build/wasm-sdk}"
if [[ "$viewer_root" =~ [[:space:]] || "$lab_root" =~ [[:space:]] ]]; then
  echo "Native builds require checkout and SDK paths without whitespace; see docs/wasm-sdk.md" >&2; exit 1
fi
mkdir -p "$lab_root"
lab_root="$(cd "$lab_root" && pwd)"
export USD_WASM_LAB_ROOT="$lab_root"
for prerequisite in node npm git cmake ninja python3; do
  command -v "$prerequisite" >/dev/null || { echo "Missing prerequisite: $prerequisite (see docs/wasm-sdk.md)" >&2; exit 1; }
done
python3 -c 'import sys; sys.exit("Python 3.10+ required by Emscripten 6.0.0") if sys.version_info < (3, 10) else None'
node -e 'const v=process.versions.node.split(".").map(Number); if(v[0]<22) throw Error("Node.js 22+ required")'
node -e 'const {execFileSync}=require("node:child_process"); const v=execFileSync("cmake",["--version"],{encoding:"utf8"}).match(/version (\d+)\.(\d+)/); if(!v || +v[1]<3 || (+v[1]===3 && +v[2]<27)) throw Error("CMake 3.27+ required")'
: "${EMSDK_ROOT:?Set EMSDK_ROOT to an activated Emscripten 6.0.0 installation; see docs/wasm-sdk.md}"
sdk_environment="$EMSDK_ROOT/emsdk_env.sh"
configured_emsdk_root="$EMSDK_ROOT"
# emsdk_env.sh is not nounset-clean and clears EMSDK_ROOT/EM_CACHE.
set +u
source "$sdk_environment"
set -u
export EMSDK_ROOT="$configured_emsdk_root"
export EM_CACHE="$lab_root/emscripten-cache"
export CCACHE_DIR="$lab_root/ccache"
expected_emcc="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).emscripten)' "$viewer_root/tools/native-build/sources.json")"
actual_emcc="$(emcc -dumpversion)"
if [[ "$actual_emcc" != "$expected_emcc" ]]; then
  echo "Expected Emscripten $expected_emcc; found $actual_emcc. Install and activate the pinned version." >&2
  exit 1
fi
if [[ ! "${BUILD_JOBS:-8}" =~ ^[1-9][0-9]*$ ]]; then
  echo "BUILD_JOBS must be a positive integer" >&2; exit 1
fi
