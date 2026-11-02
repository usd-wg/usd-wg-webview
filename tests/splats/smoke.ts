import { GpuArrays, type SplatRenderer } from "@sparkjsdev/radix";
import { Color, Matrix4, PerspectiveCamera, Scene, Vector3, type Group } from "three";
import { GaussianSplatRenderer } from "../../src/viewer/GaussianSplatRenderer";
import { RendererManager } from "../../src/viewer/RendererManager";
import type { RenderableGaussianSplat } from "../../src/usd/types";

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function source(count: number): RenderableGaussianSplat {
  const positions = new Float32Array(count * 3);
  const scales = new Float32Array(count * 3).fill(0.02);
  const orientations = new Float32Array(count * 4);
  const shCoeffs = new Float32Array(count * 48);
  for (let i = 0; i < count; i++) {
    positions.set([(i % 257) / 256 * 2.8 - 1.4,
      (Math.floor(i / 257) % 257) / 256 * 1.6 - 0.8,
      (i % 31) / 30 * 0.6 - 0.3], i * 3);
    orientations[i * 4 + 3] = 1;
    shCoeffs[i * 48 + 3] = 0.3;
  }
  return { path: "/Splats", name: "Splats", count, positions, scales, orientations,
    opacities: new Float32Array(count).fill(0.8), shCoeffs, shDegree: 3,
    matrix: new Matrix4().makeTranslation(0.2, 0.1, 0.3).toArray() };
}

async function run() {
  const renderer = await RendererManager.createRenderer();
  renderer.setSize(800, 400);
  document.body.append(renderer.domElement);
  const scene = new Scene();
  scene.background = new Color(0x222222);
  const camera = new PerspectiveCamera(50, 2, 0.01, 100);
  camera.position.set(0, 0, 6);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const adapter = new GaussianSplatRenderer(renderer, scene);
  // Inspect upstream diagnostics and lifetime callbacks without adding a
  // production API solely for the test. These are TS-private, not JS fields.
  const { radix, root } = adapter as unknown as { radix: SplatRenderer; root: Group };
  const originalDispose = GpuArrays.prototype.dispose;
  const sourceDisposals = new Set<GpuArrays>();
  GpuArrays.prototype.dispose = function () {
    if (this.schema.packedSplats) sourceDisposals.add(this);
    return originalDispose.call(this);
  };
  async function drawCount() {
    scene.updateMatrixWorld(true);
    await adapter.settle(camera);
    adapter.render(camera);
    return radix.sortMode === "gpu" ? radix.readSortedCount() : radix.viewFor(camera).order?.visible;
  }
  try {
    // Deliberately exceeds 65,536, with a non-workgroup-aligned tail.
    const count = 70_001;
    adapter.renderSplats([source(count)]);
    check(await drawCount() === count, "Large collection lost visible splats");
    const encodedBytes = adapter.getStats().encodedBytes;
    adapter.setOptions({ maxShDegree: 0, scaleMultiplier: 1.5 });
    check(await drawCount() === count, "Control change lost splats");
    check(adapter.getStats().encodedBytes === encodedBytes, "Controls reallocated source storage");
    adapter.setViewUpAxis("z");
    const translation = new Vector3().setFromMatrixPosition(root.children[0].matrixWorld);
    check(translation.distanceTo(new Vector3(0.2, 0.3, -0.1)) < 1e-6, "USD transform/up-axis mismatch");
    check(await drawCount() === count, "Up-axis change lost splats");
    adapter.renderSplats([source(257)]);
    check(await drawCount() === 257, "Replacement retained old collection");
    adapter.clear();
    check(radix.views.size === 0, "Clear retained sorting views");
    check(adapter.getStats().count === 0 && adapter.getStats().encodedBytes === 0, "Clear retained payload stats");
    check(sourceDisposals.size === 2, "Retired source arrays were not released");
    for (let cycle = 0; cycle < 3; cycle++) {
      adapter.renderSplats([source(513)]);
      check(await drawCount() === 513, "Reload lost splats");
      adapter.clear();
    }
    check(sourceDisposals.size === 5, "Repeated reload leaked source arrays");
    return { pass: true, sortMode: radix.sortMode, largeCount: count, encodedBytes,
      releasedCollections: sourceDisposals.size };
  } finally {
    adapter.dispose();
    renderer.dispose();
    GpuArrays.prototype.dispose = originalDispose;
  }
}

// Always settle the promise so the runner can report a useful failure.
(window as unknown as { splatSmoke: Promise<unknown> }).splatSmoke = run()
  .catch(error => ({ pass: false, error: String(error), stack: error.stack }));
