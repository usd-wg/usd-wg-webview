import { GpuArrays, SplatCollection, SplatRenderer, type AnySplatObject } from "@sparkjsdev/radix";
import { Group, Object3D, Scene, type Camera } from "three";
import type { WebGPURenderer } from "three/webgpu";
import { uniform } from "three/tsl";
import type { RenderableGaussianSplat } from "../usd/types";
import { encodeGaussianSplats } from "./splatData";
import { SplatCompositor } from "./SplatCompositor";

export type SplatViewOptions = { maxShDegree: number; scaleMultiplier: number };

export class GaussianSplatRenderer {
  private readonly radix: SplatRenderer;
  private readonly root = new Group();
  private readonly scale = uniform(1);
  private encodedBytes = 0;
  private readonly splatScene = new Scene();
  private readonly compositor: SplatCompositor;

  constructor(private readonly renderer: WebGPURenderer, private readonly scene: Scene) {
    this.radix = new SplatRenderer({
      renderer,
      method: "ewa",
      sortBits: 32,
      objectParams: { maxShDegree: 3 },
      modifierSpace: "object",
      modifier: (splat) => {
        const scaled = splat.toVar();
        scaled.get("scales").mulAssign(this.scale);
        return scaled;
      },
    });
    this.root.name = "Gaussian Splat Root";
    scene.add(this.root);
    this.splatScene.add(this.radix);
    this.compositor = new SplatCompositor(renderer);
  }

  render(camera: Camera): void {
    if (this.radix.collection.count > 0) {
      this.compositor.render(this.scene, this.splatScene, camera);
    } else {
      this.renderer.render(this.scene, camera);
    }
  }

  renderSplats(splats: RenderableGaussianSplat[]): void {
    const models: Object3D[] = [];
    const objects: AnySplatObject[] = [];
    const allocated: GpuArrays[] = [];
    let encodedBytes = 0;
    try {
      for (const splat of splats) {
        if (splat.count === 0) continue;
        const data = encodeGaussianSplats(splat);
        for (const bundle of Object.values(data.bundles)) {
          for (const channel of Object.values(bundle.channels)) encodedBytes += channel.data.byteLength;
        }
        const arrays = GpuArrays.fromData(this.renderer, data);
        allocated.push(arrays);
        const model = new Object3D();
        model.name = splat.path;
        // USD's flattened row-major matrix is Three's column-major transform.
        if (splat.matrix.length === 16) model.matrix.fromArray(splat.matrix);
        model.matrixAutoUpdate = false;
        models.push(model);
        objects.push(SplatCollection.arrays(arrays, {
          matrixWorld: model.matrixWorld,
          release: () => arrays.dispose(),
        }));
      }
    } catch (error) {
      for (const arrays of allocated) arrays.dispose();
      throw error;
    }
    this.root.clear();
    for (const model of models) this.root.add(model);
    this.root.updateMatrixWorld(true);
    this.radix.collection = new SplatCollection(objects);
    this.encodedBytes = encodedBytes;
    if (objects.length === 0) this.releaseViews();
  }

  clear(): void {
    this.root.clear();
    this.radix.collection = SplatCollection.EMPTY;
    this.releaseViews();
    this.encodedBytes = 0;
  }

  private releaseViews(): void {
    // An empty scene skips the draw, so no new worker order will retire the old
    // collection. Explicitly release its views on unload/clear.
    for (const view of [...this.radix.views.values()]) view.dispose();
  }

  setOptions(options: SplatViewOptions): void {
    this.radix.objectParams.maxShDegree = Math.max(0, Math.min(3, options.maxShDegree));
    this.scale.value = options.scaleMultiplier;
    this.radix.requestSort();
  }

  setViewUpAxis(axis: "y" | "z"): void {
    this.root.rotation.set(axis === "z" ? -Math.PI / 2 : 0, 0, 0);
    this.root.updateMatrixWorld(true);
    this.radix.requestSort();
  }

  // Captures await the fallback's worker; a fixed frame count is not enough.
  async settle(camera: Camera): Promise<void> {
    if (this.radix.collection.count === 0) return;
    this.root.updateMatrixWorld(true);
    if (this.radix.sortMode === "cpu") {
      const view = this.radix.viewFor(camera);
      view.apply(await view.sort(camera));
    }
  }

  getStats() {
    return { count: this.radix.collection.count, objects: this.radix.collection.objects.length,
      sortMode: this.radix.sortMode, encodedBytes: this.encodedBytes,
      maxShDegree: this.radix.objectParams.maxShDegree, scaleMultiplier: this.scale.value };
  }

  dispose(): void {
    this.scene.remove(this.root);
    this.splatScene.remove(this.radix);
    this.radix.dispose();
    this.compositor.dispose();
    this.root.clear();
  }
}
