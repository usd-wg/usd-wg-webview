// Pure geometry/topology helpers shared by the viewport. No renderer or
// scene state lives here — everything is a function of its inputs, which
// keeps the face-expansion, normal-welding, fingerprint, and MaterialX UV
// orientation rules unit-testable.

import { BufferGeometry, Float32BufferAttribute, type Material, Vector3 } from "three";
import type { RenderableMaterial, RenderableMesh } from "../usd/types";
import { materialShouldUseTextureFallback } from "./materialXCompatibility";

// Face-expand: for each index, copy `stride` floats from `data`. Matches the
// reference ThreeJsRenderDelegate.updateOrder() pattern — no setIndex() needed.
export function faceExpandAttr(
  data: ArrayLike<number>,
  indices: ArrayLike<number>,
  stride: number
): Float32Array {
  const out = new Float32Array(indices.length * stride);
  for (let i = 0; i < indices.length; i++) {
    const s = indices[i] * stride;
    for (let j = 0; j < stride; j++) out[i * stride + j] = data[s + j];
  }
  return out;
}

export function normalWeldKey(x: number, y: number, z: number): string {
  const precision = 1e5;
  return `${Math.round(x * precision)}:${Math.round(y * precision)}:${Math.round(z * precision)}`;
}

export function buildIndexedVertexNormals(
  points: ArrayLike<number>,
  indices: ArrayLike<number>
): Float32Array {
  const normals = new Float32Array(points.length);
  const weldedNormals = new Map<string, Vector3>();
  const weldedVertexIndices = new Map<string, number[]>();

  for (let i = 0; i + 2 < indices.length; i += 3) {
    const ia = Number(indices[i]);
    const ib = Number(indices[i + 1]);
    const ic = Number(indices[i + 2]);

    const ax = points[ia * 3];
    const ay = points[ia * 3 + 1];
    const az = points[ia * 3 + 2];
    const bx = points[ib * 3];
    const by = points[ib * 3 + 1];
    const bz = points[ib * 3 + 2];
    const cx = points[ic * 3];
    const cy = points[ic * 3 + 1];
    const cz = points[ic * 3 + 2];

    const abx = bx - ax;
    const aby = by - ay;
    const abz = bz - az;
    const acx = cx - ax;
    const acy = cy - ay;
    const acz = cz - az;

    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;

    for (const vertexIndex of [ia, ib, ic]) {
      const offset = vertexIndex * 3;
      const key = normalWeldKey(points[offset], points[offset + 1], points[offset + 2]);
      const accumulated = weldedNormals.get(key) ?? new Vector3();
      accumulated.x += nx;
      accumulated.y += ny;
      accumulated.z += nz;
      weldedNormals.set(key, accumulated);
      const indicesForKey = weldedVertexIndices.get(key) ?? [];
      indicesForKey.push(vertexIndex);
      weldedVertexIndices.set(key, indicesForKey);
    }
  }

  for (const [key, accumulated] of weldedNormals) {
    const length = accumulated.length();
    if (length > 0) {
      accumulated.divideScalar(length);
    } else {
      accumulated.set(0, 0, 1);
    }
    for (const vertexIndex of weldedVertexIndices.get(key) ?? []) {
      const offset = vertexIndex * 3;
      normals[offset] = accumulated.x;
      normals[offset + 1] = accumulated.y;
      normals[offset + 2] = accumulated.z;
    }
  }

  return normals;
}

// NOTE: 8-point sampling means interior-only vertex changes can go
// undetected (documented false negative; removed with the unified driver).
export function geometryFingerprint(points: ArrayLike<number>): string {
  if (!points.length) return "0";
  const samples = 8;
  const last = points.length - 1;
  let hash = `${points.length}`;
  for (let i = 0; i < samples; i++) {
    const index = Math.min(last, Math.floor((last * i) / (samples - 1)));
    hash += `:${points[index].toPrecision(7)}`;
  }
  return hash;
}

export function renderableHasMaterialX(renderable: RenderableMesh): boolean {
  if (materialHasActiveMaterialX(renderable.material)) {
    return true;
  }
  return (renderable.materialSubsets ?? []).some((subset) => materialHasActiveMaterialX(subset.material));
}

export function renderableUsesTextureFallback(renderable: RenderableMesh): boolean {
  if (materialShouldUseTextureFallback(renderable.material)) {
    return true;
  }
  return (renderable.materialSubsets ?? []).some((subset) => materialShouldUseTextureFallback(subset.material));
}

function materialHasActiveMaterialX(material?: RenderableMaterial): boolean {
  return !!material?.materialX && !materialShouldUseTextureFallback(material);
}

// The MaterialX V-flip. This is the single place UV orientation for
// successfully compiled MaterialX materials is decided; regression case materialx-tiled
// guards it with an orientation-asymmetric texture.
export function applyMaterialXUvOptions(
  uvAttr: Float32BufferAttribute,
  renderable: RenderableMesh,
  materialXFlipV: boolean,
  renderedMaterials: Material | Material[]
): void {
  if (!materialXFlipV) return;

  const materials = Array.isArray(renderedMaterials) ? renderedMaterials : [renderedMaterials];
  const flipRange = (start: number, count: number, material?: Material) => {
    if (material?.userData.webviewMaterialX !== true) return;
    for (let index = start; index < Math.min(start + count, uvAttr.count); index += 1) {
      uvAttr.setY(index, 1 - uvAttr.getY(index));
    }
    uvAttr.needsUpdate = true;
  };
  if (renderable.materialSubsets?.length) {
    // Match applyGeometryGroups/createRenderableMaterials slot order. UVs are
    // corner-expanded, so mixed materials can use different orientations.
    const slots = new Map<string, number>();
    for (const subset of renderable.materialSubsets) {
      const key = getSubsetMaterialKey(subset.material, subset.path);
      if (!slots.has(key)) slots.set(key, slots.size);
      flipRange(subset.start, subset.count, materials[slots.get(key)!]);
    }
  } else {
    flipRange(0, uvAttr.count, materials[0]);
  }
}

export function getSubsetMaterialKey(
  material: RenderableMaterial | undefined,
  fallbackPath: string
): string {
  return material?.path ?? fallbackPath;
}

export function getUniqueSubsetMaterials(
  renderable: RenderableMesh
): (RenderableMaterial | undefined)[] {
  const materials: (RenderableMaterial | undefined)[] = [];
  const seen = new Set<string>();
  for (const subset of renderable.materialSubsets ?? []) {
    const key = getSubsetMaterialKey(subset.material, subset.path);
    if (seen.has(key)) continue;
    seen.add(key);
    materials.push(subset.material);
  }
  return materials;
}

export function getRenderableMaterialXEntries(renderable: RenderableMesh): NonNullable<RenderableMaterial["materialX"]>[] {
  const entries: NonNullable<RenderableMaterial["materialX"]>[] = [];
  const seen = new Set<string>();
  const pushEntry = (materialX?: RenderableMaterial["materialX"]) => {
    if (!materialX) {
      return;
    }
    const key = `${materialX.path}:${materialX.materialName ?? ""}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    entries.push(materialX);
  };

  pushEntry(renderable.material?.materialX);
  for (const subset of renderable.materialSubsets ?? []) {
    pushEntry(subset.material?.materialX);
  }

  return entries;
}

export function getRenderableMaterialXPathList(renderable: RenderableMesh): string[] {
  return getRenderableMaterialXEntries(renderable).map((materialX) => materialX.path);
}

export function getRenderableMaterialKey(
  renderable: RenderableMesh,
  materialXFlipV: boolean
): string {
  const materials = renderable.materialSubsets?.length
    ? getUniqueSubsetMaterials(renderable)
    : [renderable.material];
  return materials.map((material) => {
    const materialX = material?.materialX;
    if (materialX && !materialShouldUseTextureFallback(material)) {
      return `mtlx:${materialXFlipV ? "flipv" : "noflipv"}:${materialX.path}:${materialX.materialName ?? ""}`;
    }
    return material?.path ?? "default";
  }).join("|");
}

// --- Mesh geometry assembly (moved from ThreeViewport) -------------------
// These build/refresh BufferGeometry from a RenderableMesh. They are free
// functions so the face-expansion and normal/tangent rules stay in one
// module; the facade passes the MaterialX flip setting and a tangent
// warning sink.

export interface GeometryBuildOptions {
  materialXFlipV: boolean;
  renderedMaterials: Material | Material[];
  warnTangents: (renderable: RenderableMesh, detail: string) => void;
}

export function buildGeometry(renderable: RenderableMesh, opts: GeometryBuildOptions): BufferGeometry {
  const { points, indices, uvs } = renderable;
  const geo = new BufferGeometry();
  geo.setAttribute("position", new Float32BufferAttribute(faceExpandAttr(points, indices, 3), 3));
  if (uvs?.length) {
    const uvAttr = new Float32BufferAttribute(faceExpandAttr(uvs, indices, 2), 2);
    applyMaterialXUvOptions(uvAttr, renderable, opts.materialXFlipV, opts.renderedMaterials);
    geo.setAttribute("uv", uvAttr);
    geo.setAttribute("uv1", uvAttr.clone());
  }
  if (renderable.materialSubsets?.length) {
    applyGeometryGroups(geo, renderable);
  }
  setExpandedVertexNormals(geo, points, indices, renderable.normals);
  setExpandedVertexTangents(geo, renderable, opts);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

// Always start with authored UVs: material edits may switch either direction
// between compiled MaterialX and standard fallback without changing topology.
export function updateGeometryUvs(
  geo: BufferGeometry,
  renderable: RenderableMesh,
  opts: GeometryBuildOptions
): void {
  if (renderable.uvs?.length) {
    const uv = new Float32BufferAttribute(faceExpandAttr(renderable.uvs, renderable.indices, 2), 2);
    if (geo.attributes.position?.count !== uv.count) return;
    applyMaterialXUvOptions(uv, renderable, opts.materialXFlipV, opts.renderedMaterials);
    geo.setAttribute("uv", uv);
    geo.setAttribute("uv1", uv.clone());
  } else {
    geo.deleteAttribute("uv");
    geo.deleteAttribute("uv1");
  }
  setExpandedVertexTangents(geo, renderable, opts);
}

// Update vertex positions on an existing geometry for animation frames.
// Refresh UV orientation and normals/tangents from the current material choice.
// Falls back to full rebuild only when vertex count changes (topology shift).
export function updateGeometryPositions(
  geo: BufferGeometry,
  renderable: RenderableMesh,
  opts: GeometryBuildOptions
): void {
  const pos = faceExpandAttr(renderable.points as number[], renderable.indices as number[], 3);
  const posAttr = geo.attributes.position;
  if (posAttr && posAttr.count * 3 === pos.length) {
    // Same vertex count — update in place.
    (posAttr.array as Float32Array).set(pos);
    posAttr.needsUpdate = true;
    setExpandedVertexNormals(geo, renderable.points, renderable.indices, renderable.normals);
    updateGeometryUvs(geo, renderable, opts);
  } else {
    // Topology changed — rebuild from current source data, never retain stale
    // UVs/tangents from a previous material or differently sized corner stream.
    geo.dispose();
    const newGeo = buildGeometry(renderable, opts);
    // Copy attributes into the existing geometry object so the Mesh reference stays valid
    for (const key of Object.keys(geo.attributes)) {
      if (!newGeo.attributes[key]) geo.deleteAttribute(key);
    }
    for (const key of Object.keys(newGeo.attributes)) {
      geo.setAttribute(key, newGeo.attributes[key]);
    }
    geo.index = newGeo.index;
    geo.clearGroups();
    for (const group of newGeo.groups) {
      geo.addGroup(group.start, group.count, group.materialIndex ?? 0);
    }
  }
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
}

export function applyGeometryGroups(geo: BufferGeometry, renderable: RenderableMesh): void {
  geo.clearGroups();
  if (!renderable.materialSubsets?.length) return;
  const slots = new Map<string, number>();
  for (let index = 0; index < renderable.materialSubsets.length; ++index) {
    const subset = renderable.materialSubsets[index];
    const key = getSubsetMaterialKey(subset.material, subset.path);
    if (!slots.has(key)) {
      slots.set(key, slots.size);
    }
    geo.addGroup(subset.start, subset.count, slots.get(key) ?? 0);
  }
}

export function setExpandedVertexNormals(
  geo: BufferGeometry,
  points: ArrayLike<number>,
  indices: ArrayLike<number>,
  providedNormals?: Float32Array
): void {
  // The unified stage driver supplies corner-stream normals (authored
  // normals honored, native smooth-normal fallback); use them directly
  // when they match the expanded vertex count instead of re-welding.
  if (providedNormals && providedNormals.length === indices.length * 3) {
    geo.setAttribute("normal", new Float32BufferAttribute(providedNormals, 3));
    geo.attributes.normal.needsUpdate = true;
    return;
  }
  const normals = buildIndexedVertexNormals(points, indices);
  geo.setAttribute("normal", new Float32BufferAttribute(faceExpandAttr(normals, indices, 3), 3));
  geo.attributes.normal.needsUpdate = true;
}

export function setExpandedVertexTangents(
  geo: BufferGeometry,
  renderable: RenderableMesh,
  opts: GeometryBuildOptions
): void {
  const tangentAttribute = buildExpandedVertexTangents(renderable, opts);
  if (tangentAttribute) {
    geo.setAttribute("tangent", tangentAttribute);
    geo.attributes.tangent.needsUpdate = true;
    return;
  }

  if (geo.getAttribute("tangent")) {
    geo.deleteAttribute("tangent");
  }
}

function buildExpandedVertexTangents(
  renderable: RenderableMesh,
  opts: GeometryBuildOptions
): Float32BufferAttribute | null {
  const { points, indices, uvs, normals } = renderable;
  if (!uvs?.length) {
    opts.warnTangents(renderable, "MaterialX tangent generation skipped because the mesh has no UVs.");
    return null;
  }

  const indexedGeometry = new BufferGeometry();
  try {
    // Split corners before choosing orientation, including vertices shared by
    // MaterialX and standard subsets. Tangents must use the same UVs as drawing.
    indexedGeometry.setAttribute("position", new Float32BufferAttribute(faceExpandAttr(points, indices, 3), 3));

    const uvAttribute = new Float32BufferAttribute(faceExpandAttr(uvs, indices, 2), 2);
    applyMaterialXUvOptions(uvAttribute, renderable, opts.materialXFlipV, opts.renderedMaterials);
    indexedGeometry.setAttribute("uv", uvAttribute);
    setExpandedVertexNormals(indexedGeometry, points, indices, normals);
    indexedGeometry.setIndex(Array.from(indices, (_, index) => index));
    indexedGeometry.computeTangents();

    const tangent = indexedGeometry.getAttribute("tangent");
    if (!tangent) {
      opts.warnTangents(renderable, "MaterialX tangent generation finished without producing a tangent attribute.");
      return null;
    }

    return new Float32BufferAttribute(new Float32Array(tangent.array), 4);
  } catch (error) {
    console.warn("[USD WebView] Failed to compute tangents for mesh geometry", {
      path: renderable.path,
      materialPaths: getRenderableMaterialXPathList(renderable),
      error,
    });
    opts.warnTangents(renderable, "MaterialX tangent generation failed for this mesh.");
    return null;
  } finally {
    indexedGeometry.dispose();
  }
}
