#!/usr/bin/env bash
set -euo pipefail
viewer_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$viewer_root"
if (( $# > 1 )); then
  echo "Usage: npm run native:source -- [both|wasm32|wasm64]" >&2; exit 2
fi
case "${1:-both}" in
  both) architectures=(wasm32 wasm64) ;;
  wasm32|wasm64) architectures=("$1") ;;
  *) echo "Usage: npm run native:source -- [both|wasm32|wasm64]" >&2; exit 2 ;;
esac
: "${EMSDK_ROOT:?Install/activate Emscripten 6.0.0 and export EMSDK_ROOT first; see docs/wasm-sdk.md}"
source tools/native-build/sdk-environment.sh
node tools/native-build/prepare-sources.mjs
for arch in "${architectures[@]}"; do
  bash tools/native-build/build-local-sdk.sh "$arch"
  bash tools/native-build/build-local-bindings.sh "$arch"
done
if [[ "${1:-both}" != wasm32 ]]; then
  npm run native:package -- public/localAssets/wasm64-runtime
else
  npm run native:package
fi
npm run native:verify
