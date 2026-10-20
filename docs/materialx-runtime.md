# MaterialX Runtime

This repository keeps the official ASWF MaterialX JavaScript/WASM release as a
validation/reference runtime. Interactive MaterialX rendering uses upstream
Three.js' MaterialX loader and node-material path.

## Vendored Version

- Version: 1.39.5
- Release asset: `MaterialX_JavaScript.zip`
- Source URL: `https://github.com/AcademySoftwareFoundation/MaterialX/releases/download/v1.39.5/MaterialX_JavaScript.zip`
- SHA-256: `fbb0afe06064b4a5606d52dafe3b740f093de084000f11340ac0a6a88a7ecb0b`
- Local path: `public/materialx/1.39.5/`

The unpacked release contains `JsMaterialXCore` and `JsMaterialXGenShader`
JavaScript/WASM modules. Unit tests lazy-load `JsMaterialXGenShader` to validate
parsing and shader generation against the official implementation.

## Updating

Run:

```sh
npm run materialx:fetch
```

The fetch script downloads the pinned release asset, verifies the SHA-256, and
rewrites `public/materialx/1.39.5/metadata.json`.

When updating MaterialX versions:

1. Update `VERSION`, `SOURCE_URL`, and `SHA256` in
   `tools/materialx/fetch-official-runtime.mjs`.
2. Run `npm run materialx:fetch`.
3. Update this document with the new version and SHA.
4. Run `npm run test:unit`, `npm run build`, and targeted MaterialX regression
   cases before blessing visual baselines.

## Runtime

The viewer renders MaterialX through Three's `MaterialXLoader`, pinned to an
upstream Three.js commit that includes the current MaterialX loader/compiler
stack. The official WASM runtime is retained to validate documents and compare
shader-generation behavior, not to produce the interactive viewport material.

## Current Fidelity Notes

### UV orientation and fallback materials

`GeometryBuilder.applyMaterialXUvOptions` is the sole owner of the MaterialX
V flip. It uses the selected render material's `userData.webviewMaterialX`
flag, not the presence of an authored MaterialX payload. Standard materials,
including EXR, compilation-failure, and unavailable-renderer fallbacks, retain
authored UVs. Resolve materials before geometry creation or UV refresh.

Mixed-material meshes flip only successfully compiled MaterialX subset corner
ranges. Tangents use the same final UVs. Refreshes start from authored values
and update both `uv` and `uv1`, so material switching cannot retain or accumulate
a flip.

Validate both the working MaterialX path and textured fallback:

```sh
npm run test:unit
npm run build
npm run test:regression -- --case materialx-tiled --case materialx-fallback-uv
```

The fallback case deliberately supplies an unsupported MaterialX
`UsdPreviewSurface` surface alongside its standard USD Preview texture graph.
The letter texture must remain upright. Unit coverage includes compilation
failure, renderer unavailability, mixed subsets, material transitions,
topology changes, and tangent handedness.

The active path preserves USD-side responsibilities: material binding
discovery, raw or synthesized `.mtlx` extraction, and texture byte extraction
remain in the OpenUSD WASM layer. Three's loader owns the MaterialX graph,
surface mapping, UV convention, texture handling, and renderer integration.

Known gaps while parity is still in progress:

- The official WASM runtime can compile ESSL/WGSL for reference, but the viewer
  does not host those generated shaders at runtime.
- EXR MaterialX image nodes can still fall back to extracted standard texture
  slots where browser support is insufficient.
