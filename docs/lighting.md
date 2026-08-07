# Lighting

USD Web View has two lighting paths:

- authored USDLux lights extracted from the loaded stage
- viewer fallback lighting used only when the stage has no direct lights and no
  loaded DomeLight/DomeLight_1 environment

The goal is viewport inspection, not renderer parity with Karma, Storm, or a
path tracer. USDLux attributes are translated to the closest Three.js lighting
primitive available in the active renderer.

## Stage Lighting Priority

Authored stage lighting takes precedence:

1. A valid USDLux `DomeLight` or `DomeLight_1` texture drives the scene
   environment and background.
2. Authored direct USDLux lights replace the default ambient/hemisphere rig.
3. The default RoomEnvironment plus ambient/hemisphere lights are used only
   when no stage lighting is available.

DomeLight extraction is based on the USDLux schema type, not the prim name.
It reads the authored texture asset from USD or USDZ package contents. Latlong
HDR (`.hdr`), OpenEXR (`.exr`), and ordinary LDR image textures such as JPEG,
PNG, and WebP are supported. Authored DomeLight intensity/exposure values are
used directly; the viewer does not brighten dim authored environments.

The viewer also supports a display-side DomeLight rotation attribute,
`inputs:texture:rotation`, in degrees. If the source stage does not author that
attribute, the attributes panel shows it as an editable session-layer control.
Changing it rotates both the IBL environment and visible HDRI background.
In WebGPU, the visible background rotation follows Three.js
`Scene.backgroundRotation`; reflected environment rotation is limited by the
current Three.js WebGPU implementation.

## Supported USDLux Prims

| USDLux source | WebGL viewport | WebGPU viewport |
| --- | --- | --- |
| `DomeLight`, `DomeLight_1` | Environment/background texture | Environment/background texture |
| `DistantLight` | `DirectionalLight` | `DirectionalLight` |
| unshaped `SphereLight` | `PointLight` | `PointLight` |
| shaped `SphereLight` | `SpotLight` | `SpotLight` |
| `RectLight` | `RectAreaLight` | `SpotLight` approximation |
| unshaped `DiskLight` | square `RectAreaLight` approximation | `SpotLight` approximation |
| shaped `DiskLight` | `SpotLight` | `SpotLight` |

Unsupported USDLux forms are reported once in the console and omitted from
rendered lighting:

- `CylinderLight`
- `GeometryLight`
- `PluginLight`
- `PortalLight`
- `MeshLightAPI`
- `VolumeLightAPI`

## Attribute Translation

The viewer extracts these common USDLux inputs when present:

- `inputs:intensity`
- `inputs:exposure`
- `inputs:color`
- `inputs:diffuse`
- `inputs:specular`
- `inputs:normalize`
- `inputs:enableColorTemperature`
- `inputs:colorTemperature`
- `inputs:texture:rotation` on DomeLights
- `inputs:shaping:cone:angle`
- `inputs:shaping:cone:softness`
- light-shape inputs such as `inputs:radius`, `inputs:width`, `inputs:height`,
  and `inputs:angle`

`intensity` and `exposure` are combined as `intensity * 2^exposure`.
DomeLights use that authored value directly for environment lighting and the
visible background. Diffuse and specular lobe weights are folded into viewport
intensity for direct lights because Three.js does not expose the same USDLux
lobe split. `inputs:colorTemperature` affects light color only when
`inputs:enableColorTemperature` is true. Editing `inputs:colorTemperature` in
the attributes panel automatically enables that switch for the selected light.

For non-normalized area-like lights, source size affects viewport intensity:
sphere/disk radius scales roughly by area, and rect width/height scales by
area. This is an approximation so edits to radius, width, and height are
visible in the interactive renderer. When `inputs:normalize` is true, size does
not scale intensity.

## WebGL Behavior

WebGL has the most complete light mapping currently available in this viewer:

- `RectLight` maps to `RectAreaLight`.
- unshaped `DiskLight` maps to a square `RectAreaLight` approximation with the
  same diameter.
- wire gizmos are drawn with Three.js `Line` objects.

Limitations:

- `DiskLight` is not a true disk emitter; it is square in lighting influence.
- `RectAreaLight` is still a raster approximation and does not match a path
  tracer for soft shadows, textured emitters, or volumetric scattering.
- No USDLux shadow, shaping, barn-door, linking, collection, or light-filter
  fidelity is guaranteed beyond the explicitly extracted fields.

## WebGPU Behavior

WebGPU is used for MaterialX content. Its direct-light support is currently
more limited in this Three.js path:

- `DistantLight`, `PointLight`, and `SpotLight` mappings are used directly.
- `RectLight` and unshaped `DiskLight` are rendered as `SpotLight`
  approximations.
- the authored rect/disk wire gizmo still shows the source light shape even
  though the lighting influence is approximated.

The viewer avoids `RectAreaLight` in WebGPU because the current Three.js
WebGPU/TSL path fails while setting up rect-area-light LTC data. Revisit this
when Three.js WebGPU area-light support is stable.

Limitations:

- rect and disk area influence is approximate
- no true area-light sampling
- no path-traced multiple scattering or volumetric contribution
- no mesh, geometry, portal, plugin, cylinder, or volume light conversion
- very large HDR/EXR environments may hit browser or adapter memory limits;
  EXR textures are loaded through the half-float path to keep uploads smaller

## Gizmos And Editing

Light gizmos are enabled from **Settings > Lighting > Light gizmos**.

Selection behavior:

- click a light prim in the scene graph to select it
- click the wire gizmo in the viewport to select the corresponding USD light
  prim
- selected gizmos tint amber
- press `F` to frame the selected light

Editable light attributes are shown in the attributes panel. Numeric and color
light edits refresh the light rig directly, so changes to intensity, exposure,
color, temperature, radius, width, height, and shaping cone values should show
without a full geometry redraw.

Gizmos are not transform manipulators. They visualize and select authored USD
lights; they do not move, rotate, or scale light prims in the viewport.

DomeLight editing is limited to controls the HDRI path applies directly:
intensity, exposure, and texture rotation. Other inherited USDLux light inputs,
such as color and diffuse/specular lobe weights, are not exposed as editable on
DomeLight because the current environment renderer does not apply them.

## Regression Coverage

The `usdlux-lights` regression fixture covers the current direct-light
translation surface. The `domelight-versioned` fixture covers `DomeLight_1`
environment extraction by schema type, including an arbitrary prim name and a
packaged HDR asset. These baselines are viewport-rendering baselines, not
renderer-fidelity targets.

## TODO

- **Optional WASM64 path** - investigate a WASM64 build for very large USDZ
  packages, texture payloads, and stage data that are constrained by the
  current WASM32 memory ceiling. Keep WASM32 as the default until OpenUSD,
  Emscripten, browser support, CI, and deployment behavior are practical.
- **Path-traced renderer path** - prototype a separate `three-gpu-pathtracer`
  mode for higher-fidelity lighting checks. Target better DomeLight sampling,
  true area-light behavior, shadows, MaterialX/UsdPreviewSurface subset
  mapping, and eventually volumetric experiments. The raster Three.js viewport
  should remain the default interactive inspection path.
