// Material creation and update for renderable meshes: MeshPhysicalMaterial
// mapping from UsdPreviewSurface data, MaterialX parsing (WebGPU renderer
// only), material-key change detection, and MaterialX resource resolution.

import {
  Color,
  DoubleSide,
  type Material,
  Mesh,
  MeshPhysicalMaterial,
} from "three";
import { MaterialXLoader } from "three/examples/jsm/loaders/MaterialXLoader.js";
import type { RenderableMaterial, RenderableMesh, RenderableTexture } from "../usd/types";
import {
  getRenderableMaterialKey,
  getRenderableMaterialXEntries,
  getUniqueSubsetMaterials,
  renderableHasMaterialX,
} from "./GeometryBuilder";
import type { TextureCache } from "./TextureCache";
import { materialShouldUseTextureFallback, prepareMaterialXForThree } from "./materialXCompatibility";

const TEXT_DECODER = new TextDecoder();

export class MaterialFactory {
  readonly materialXLoader = new MaterialXLoader();
  private readonly materialXResourceUrls = new Map<string, string>();
  private readonly materialXTangentWarnings = new Set<string>();
  private experimentalMaterialXMode = false;

  constructor(
    private readonly textures: TextureCache,
    private readonly isWebGpuRenderer: () => boolean
  ) {}

  isExperimentalMaterialXMode(): boolean {
    return this.experimentalMaterialXMode;
  }

  // Reset per-stage state (warnings, resource URLs, MaterialX mode flag).
  clearStageState(): void {
    this.materialXTangentWarnings.clear();
    this.revokeMaterialXResourceUrls();
    this.experimentalMaterialXMode = false;
  }

  dispose(): void {
    this.materialXLoader.dispose();
    this.revokeMaterialXResourceUrls();
  }

  createRenderableMaterials(renderable: RenderableMesh): Material | Material[] {
    if (renderable.materialSubsets?.length) {
      return getUniqueSubsetMaterials(renderable).map((material) =>
        this.createMaterialForRenderable(renderable, material)
      );
    }
    return this.createMaterialForRenderable(renderable, renderable.material);
  }

  updateMeshMaterials(
    mesh: Mesh,
    renderable: RenderableMesh,
    materialXFlipV: boolean,
    textureLoads?: Promise<void>[]
  ): void {
    const materialSources = renderable.materialSubsets?.length
      ? getUniqueSubsetMaterials(renderable)
      : [renderable.material];
    const currentIsArray = Array.isArray(mesh.material);
    const nextIsArray = !!renderable.materialSubsets?.length;
    const nextHasMaterialX = renderableHasMaterialX(renderable);
    const currentHasMaterialX = this.meshHasMaterialXMaterial(mesh);
    const nextMaterialKey = getRenderableMaterialKey(renderable, materialXFlipV);
    // Build fresh materials only when the key or shape changed. Building them
    // unconditionally re-parsed MaterialX on every update and leaked the
    // discarded (undisposed) materials.
    if (currentIsArray !== nextIsArray ||
        currentHasMaterialX !== nextHasMaterialX ||
        mesh.userData.materialKey !== nextMaterialKey ||
        (nextIsArray && (mesh.material as Material[]).length !== materialSources.length)) {
      const nextMaterials = this.createRenderableMaterials(renderable);
      this.disposeMeshMaterials(mesh);
      mesh.material = nextMaterials;
      mesh.userData.materialKey = nextMaterialKey;
    }

    const materials = Array.isArray(mesh.material)
      ? mesh.material
      : [mesh.material];

    for (let index = 0; index < materials.length; ++index) {
      const material = materials[index];
      if (material instanceof MeshPhysicalMaterial) {
        this.updateMaterialProperties(material, renderable, materialSources[index]);
        this.textures.applyMaterialTextures(material, materialSources[index], textureLoads);
      }
    }
    mesh.material = Array.isArray(mesh.material) ? materials : materials[0];
  }

  disposeMeshMaterials(mesh: Mesh): void {
    const materials = Array.isArray(mesh.material)
      ? mesh.material
      : [mesh.material];
    for (const material of materials) {
      this.textures.disposeMaterialTextures(material);
      material.dispose();
    }
  }

  private createMaterialForRenderable(
    renderable: RenderableMesh,
    rmat = renderable.material
  ): Material {
    const materialXMaterial = this.createMaterialXMaterial(rmat);
    return materialXMaterial ?? this.createMaterial(renderable, rmat);
  }

  private createMaterialXMaterial(rmat?: RenderableMaterial): Material | null {
    const materialX = rmat?.materialX;
    if (!materialX) {
      return null;
    }
    if (!materialX.data?.length) {
      return null;
    }
    if (!this.isWebGpuRenderer()) {
      console.warn("[USD WebView] Skipping MaterialX material because WebGPU renderer is unavailable", {
        path: materialX.path,
        materialName: materialX.materialName,
      });
      return null;
    }

    try {
      const originalMaterialXText = TEXT_DECODER.decode(materialX.data);
      if (materialShouldUseTextureFallback(rmat)) {
        return null;
      }
      const materialXText = prepareMaterialXForThree(originalMaterialXText);
      const result = this.materialXLoader.parse(materialXText, {
        materialName: materialX.materialName,
        archiveResolver: (uri: string) => this.resolveMaterialXResource(uri, materialX.path, materialX.resources ?? []),
        path: materialX.path,
        uvSpace: "bottom-left",
        issuePolicy: "warn",
      });
      materialX.report = result.report;
      const material = materialX.materialName
        ? result.materials[materialX.materialName]
        : Object.values(result.materials)[0];
      if (!material) {
        console.warn("[USD WebView] MaterialX loader did not produce a usable material", {
          path: materialX.path,
          materialName: materialX.materialName,
          availableMaterials: Object.keys(result.materials),
          report: result.report,
        });
        return null;
      }
      material.side = DoubleSide;
      material.userData.webviewMaterialX = true;
      this.experimentalMaterialXMode = true;
      return material;
    } catch (error) {
      console.warn("[USD WebView] Failed to create MaterialX material", {
        path: materialX.path,
        materialName: materialX.materialName,
        error,
      });
      return null;
    }
  }

  meshHasMaterialXMaterial(mesh: Mesh): boolean {
    const materials = Array.isArray(mesh.material)
      ? mesh.material
      : [mesh.material];
    return materials.some((material) => material.userData.webviewMaterialX === true);
  }

  private createMaterial(
    renderable: RenderableMesh,
    rmat = renderable.material
  ): MeshPhysicalMaterial {
    const [r = 0.72, g = 0.72, b = 0.72] = rmat?.diffuseTexture
      ? [1, 1, 1]
      : rmat?.diffuseColor ?? renderable.color ?? [];
    const material = new MeshPhysicalMaterial({
      color: new Color(r, g, b),
      metalness: rmat?.metallicTexture ? 1.0 : (rmat?.metallic ?? 0.05),
      roughness: rmat?.roughnessTexture ? 1.0 : (rmat?.roughness ?? 0.55),
      opacity: rmat?.opacity ?? 1,
      transparent: this.isTransparentMaterial(rmat),
      depthWrite: !this.isTransparentMaterial(rmat),
      clearcoat: rmat?.clearcoat ?? 0,
      clearcoatRoughness: rmat?.clearcoatRoughness ?? 0,
      ior: rmat?.ior ?? 1.5,
      side: DoubleSide,
    });
    this.updateMaterialProperties(material, renderable, rmat);
    return material;
  }

  updateMaterialProperties(
    material: MeshPhysicalMaterial,
    renderable: RenderableMesh,
    rmat = renderable.material
  ): void {
    const [r = 0.72, g = 0.72, b = 0.72] = rmat?.diffuseTexture
      ? [1, 1, 1]
      : rmat?.diffuseColor ?? renderable.color ?? [];
    material.color.setRGB(r, g, b);
    material.metalness = rmat?.metallicTexture ? 1.0 : (rmat?.metallic ?? 0.05);
    material.roughness = rmat?.roughnessTexture ? 1.0 : (rmat?.roughness ?? 0.55);
    material.opacity = rmat?.opacity ?? 1;
    material.transparent = this.isTransparentMaterial(rmat);
    material.depthWrite = !this.isTransparentMaterial(rmat);
    material.clearcoat = rmat?.clearcoat ?? 0;
    material.clearcoatRoughness = rmat?.clearcoatRoughness ?? 0;
    material.ior = rmat?.ior ?? 1.5;
    if (rmat?.emissiveColor) {
      const [er = 0, eg = 0, eb = 0] = rmat.emissiveColor;
      material.emissive.setRGB(er, eg, eb);
    } else {
      material.emissive.setRGB(0, 0, 0);
    }
    material.needsUpdate = true;
  }

  private isTransparentMaterial(rmat?: RenderableMaterial): boolean {
    return (rmat?.opacity ?? 1) < 1 || !!rmat?.opacityTexture;
  }

  private resolveMaterialXResource(
    uri: string,
    materialXPath: string,
    resources: RenderableTexture[]
  ): string | null {
    const normalizedUri = normalizeAssetPath(uri);
    const basePath = normalizeAssetPath(materialXPath).split("/").slice(0, -1).join("/");
    const candidates = assetPathCandidates(normalizedUri, basePath);

    const resource = resources.find((candidate) => {
      const path = normalizeAssetPath(candidate.path);
      const resourceCandidates = assetPathCandidates(path);
      for (const resourceCandidate of resourceCandidates) {
        if (candidates.has(resourceCandidate)) {
          return true;
        }
      }
      return false;
    });
    if (!resource?.data?.length) {
      return null;
    }

    const cached = this.materialXResourceUrls.get(resource.path);
    if (cached) {
      return cached;
    }

    const url = createDataUrl(resource.data, resource.mimeType);
    this.materialXResourceUrls.set(resource.path, url);
    return url;
  }

  private revokeMaterialXResourceUrls(): void {
    for (const url of this.materialXResourceUrls.values()) {
      if (url.startsWith("blob:")) {
        URL.revokeObjectURL(url);
      }
    }
    this.materialXResourceUrls.clear();
  }

  warnIfMaterialXNeedsTangents(renderable: RenderableMesh, detail: string): void {
    for (const materialX of getRenderableMaterialXEntries(renderable)) {
      if (!this.materialXMayNeedTangents(materialX)) {
        continue;
      }

      const key = `${renderable.path}:${materialX.path}:${materialX.materialName ?? ""}`;
      if (this.materialXTangentWarnings.has(key)) {
        continue;
      }
      this.materialXTangentWarnings.add(key);
      console.warn("[USD WebView] MaterialX material may render incorrectly without mesh tangents", {
        meshPath: renderable.path,
        materialXPath: materialX.path,
        materialName: materialX.materialName,
        detail,
      });
    }
  }

  private materialXMayNeedTangents(materialX: NonNullable<RenderableMaterial["materialX"]>): boolean {
    if (!materialX.data?.length) {
      return false;
    }

    const text = TEXT_DECODER.decode(materialX.data).toLowerCase();
    return (
      /(?:normalmap|gltf_normalmap|hextilednormalmap|<\s*bump\b|<\s*tangent\b|<\s*bitangent\b)/.test(text) ||
      /name\s*=\s*["'](?:normal|coat_normal|geometry_coat_normal|specular_anisotropy|specular_rotation|anisotropy_strength|anisotropy_rotation)["']/.test(text)
    );
  }
}

function normalizeAssetPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function assetPathCandidates(path: string, basePath = ""): Set<string> {
  const candidates = new Set<string>();
  const add = (candidate: string) => {
    const normalized = normalizeAssetPath(candidate);
    if (!normalized) {
      return;
    }
    candidates.add(normalized);
    candidates.add(normalized.split("/").pop() ?? normalized);

    const packageMember = extractPackageMemberPath(normalized);
    if (packageMember && packageMember !== normalized) {
      candidates.add(packageMember);
      candidates.add(packageMember.split("/").pop() ?? packageMember);
    }
  };

  add(path);
  if (basePath) {
    add(`${basePath}/${path}`);
  }

  return candidates;
}

function extractPackageMemberPath(path: string): string | null {
  const openBracket = path.indexOf("[");
  const closeBracket = path.lastIndexOf("]");
  if (openBracket === -1 || closeBracket <= openBracket) {
    return null;
  }

  return normalizeAssetPath(path.slice(openBracket + 1, closeBracket));
}

function createDataUrl(bytes: Uint8Array, mimeType: string): string {
  let binary = "";
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return `data:${mimeType};base64,${btoa(binary)}`;
}
