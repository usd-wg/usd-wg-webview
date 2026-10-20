// Texture asset loading and lifetime management. Owns the blob URLs, the
// per-path load cache, and the set of textures the viewer created (managed
// textures) so stage swaps can dispose exactly what the viewer allocated.

import {
  LinearSRGBColorSpace,
  type Material,
  MeshPhysicalMaterial,
  SRGBColorSpace,
  Texture,
  TextureLoader,
} from "three";
import { EXRLoader } from "three/examples/jsm/loaders/EXRLoader.js";
import type { RenderableMaterial, RenderableTexture } from "../usd/types";

export class TextureCache {
  getTrackedTextures(): Iterable<Texture> {
    return this.managedTextures;
  }
  private readonly textureLoader = new TextureLoader();
  private readonly exrLoader = new EXRLoader();
  private readonly textureUrls: string[] = [];
  private readonly textureCache = new Map<string, Promise<Texture | null>>();
  private readonly managedTextures = new Set<Texture>();
  private textureGeneration = 0;

  // Invalidate in-flight loads across a stage swap.
  bumpGeneration(): void {
    this.textureGeneration += 1;
  }

  applyMaterialTextures(
    material: MeshPhysicalMaterial,
    rmat?: RenderableMaterial,
    textureLoads?: Promise<void>[]
  ): void {
    const loads = [
      this.applyTexture(material, "map",                    rmat?.diffuseTexture,            true),
      this.applyTexture(material, "roughnessMap",           rmat?.roughnessTexture,          false),
      this.applyTexture(material, "metalnessMap",           rmat?.metallicTexture,           false),
      this.applyTexture(material, "normalMap",              rmat?.normalTexture,             false),
      this.applyTexture(material, "aoMap",                  rmat?.occlusionTexture,          false),
      this.applyTexture(material, "emissiveMap",            rmat?.emissiveTexture,           true),
      this.applyTexture(material, "clearcoatMap",           rmat?.clearcoatTexture,          false),
      this.applyTexture(material, "clearcoatRoughnessMap",  rmat?.clearcoatRoughnessTexture, false),
      this.applyTexture(material, "alphaMap",               rmat?.opacityTexture,            false),
    ];
    if (textureLoads) {
      textureLoads.push(...loads);
    }
  }

  private applyTexture(
    material: MeshPhysicalMaterial,
    slot: keyof MeshPhysicalMaterial,
    asset: RenderableTexture | undefined,
    sRGB: boolean
  ): Promise<void> {
    const materialRecord = material as unknown as Record<string, unknown>;
    const userData = material.userData as Record<string, unknown>;
    const textureKey = `texture:${String(slot)}`;

    if (!asset?.data?.length) {
      if (userData[textureKey] !== undefined) {
        userData[textureKey] = undefined;
      }
      const previous = materialRecord[slot as string];
      if (previous instanceof Texture && previous.userData.webviewManaged) {
        previous.dispose();
        this.managedTextures.delete(previous);
      }
      if (previous) {
        materialRecord[slot as string] = null;
        material.needsUpdate = true;
      }
      return Promise.resolve();
    }

    const previous = materialRecord[slot as string];
    const hasExpectedTexture =
      previous instanceof Texture &&
      previous.name === asset.path;

    if (userData[textureKey] === asset.path && hasExpectedTexture) {
      return Promise.resolve();
    }

    userData[textureKey] = asset.path;
    const generation = this.textureGeneration;

    return this.loadTextureAsset(asset).then((baseTexture) => {
      if (generation !== this.textureGeneration) {
        return;
      }
      if (!baseTexture) {
        userData[textureKey] = undefined;
        return;
      }

      const texture = baseTexture.clone();
      texture.name = asset.path;
      texture.colorSpace = sRGB ? SRGBColorSpace : LinearSRGBColorSpace;
      texture.needsUpdate = true;
      texture.userData.webviewManaged = true;
      this.managedTextures.add(texture);

      // When emissiveMap is applied, emissive must be non-black.
      if (slot === "emissiveMap" && material.emissive.getHex() === 0x000000) {
        material.emissive.set(0xffffff);
      }
      const nextPrevious = materialRecord[slot as string];
      if (nextPrevious instanceof Texture && nextPrevious.userData.webviewManaged) {
        nextPrevious.dispose();
        this.managedTextures.delete(nextPrevious);
      }
      materialRecord[slot as string] = texture;
      material.needsUpdate = true;
    });
  }

  private loadTextureAsset(asset: RenderableTexture): Promise<Texture | null> {
    const cached = this.textureCache.get(asset.path);
    if (cached) {
      return cached;
    }
    const generation = this.textureGeneration;

    const bytes = new ArrayBuffer(asset.data.byteLength);
    new Uint8Array(bytes).set(asset.data);
    const blob = new Blob([bytes], { type: asset.mimeType });
    const url = URL.createObjectURL(blob);
    this.textureUrls.push(url);

    const pending = new Promise<Texture | null>((resolve) => {
      const loader = this.isExrTexture(asset) ? this.exrLoader : this.textureLoader;
      loader.load(
        url,
        (texture: Texture) => {
          if (generation !== this.textureGeneration) {
            texture.dispose();
            resolve(null);
            return;
          }
          texture.name = asset.path;
          resolve(texture);
        },
        undefined,
        (error) => {
          console.warn(`Failed to load texture for ${asset.path}`, error);
          this.textureCache.delete(asset.path);
          resolve(null);
        }
      );
    });
    this.textureCache.set(asset.path, pending);
    return pending;
  }

  private isExrTexture(asset: RenderableTexture): boolean {
    return asset.path.toLowerCase().endsWith(".exr") || asset.mimeType === "image/x-exr";
  }

  disposeMaterialTextures(material: Material): void {
    const materialRecord = material as unknown as Record<string, unknown>;
    for (const slot of [
      "map",
      "roughnessMap",
      "metalnessMap",
      "normalMap",
      "aoMap",
      "emissiveMap",
      "clearcoatMap",
      "clearcoatRoughnessMap",
      "alphaMap",
    ]) {
      const texture = materialRecord[slot];
      if (texture instanceof Texture && texture.userData.webviewManaged) {
        texture.dispose();
        this.managedTextures.delete(texture);
        materialRecord[slot] = null;
      }
    }
  }

  revokeTextureUrls(): void {
    for (const texture of this.managedTextures) {
      texture.dispose();
    }
    this.managedTextures.clear();
    this.textureCache.clear();
    for (const url of this.textureUrls) {
      URL.revokeObjectURL(url);
    }
    this.textureUrls.length = 0;
  }
}
