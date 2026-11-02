import { Matrix4, OrthographicCamera, PerspectiveCamera, Vector3 } from "three";
import type { StageCameraSample } from "../usd/types";

export type CameraGate = { left: number; top: number; width: number; height: number };

/** Fit the authored filmback inside the viewport; the surrounding area is overscan. */
export function cameraGate(aspect: number, width: number, height: number): CameraGate {
  const w = Math.min(width, height * aspect);
  const h = w / aspect;
  return { left: (width - w) / 2, top: (height - h) / 2, width: w, height: h };
}

/** Pure camera conversion shared by rendering and projection tests. */
export class StageCameraView {
  readonly perspective = new PerspectiveCamera();
  readonly orthographic = new OrthographicCamera();
  camera: PerspectiveCamera | OrthographicCamera = this.perspective;
  gate: CameraGate | null = null;
  private readonly matrix = new Matrix4();
  private readonly scale = new Vector3();

  update(sample: StageCameraSample, width: number, height: number, stageToView = new Matrix4()): boolean {
    const { horizontalAperture: ha, verticalAperture: va, focalLength: focal, near, far } = sample;
    if (sample.matrix.length !== 16 || !sample.matrix.every(Number.isFinite) ||
        ![ha, va, focal, near, far, sample.horizontalApertureOffset, sample.verticalApertureOffset].every(Number.isFinite) ||
        ha <= 0 || va <= 0 || far <= near || near < 0 ||
        (sample.projection === "perspective" && (focal <= 0 || near <= 0))) return false;

    width = Math.max(1, width); height = Math.max(1, height);
    this.gate = cameraGate(ha / va, width, height);
    // USD row vectors flatten in the same order as Three's column-major storage.
    this.matrix.fromArray(sample.matrix).premultiply(stageToView);
    const camera = sample.projection === "orthographic" ? this.orthographic : this.perspective;
    this.matrix.decompose(camera.position, camera.quaternion, this.scale);
    camera.scale.setScalar(1);
    // The native sample has already removed authored camera scale. Any remaining
    // uniform scale here comes from the viewer's optional model normalization.
    const sceneScale = Math.abs(this.scale.x);
    camera.near = near * sceneScale;
    camera.far = far * sceneScale;
    const factor = sample.projection === "perspective" ? camera.near / focal : 0.1 * sceneScale;
    const halfWidth = ha * factor * 0.5 * width / this.gate.width;
    const halfHeight = va * factor * 0.5 * height / this.gate.height;
    const offsetX = sample.horizontalApertureOffset * factor;
    const offsetY = sample.verticalApertureOffset * factor;
    if (camera instanceof PerspectiveCamera) {
      camera.fov = 2 * Math.atan(halfHeight / camera.near) * 180 / Math.PI;
      camera.aspect = width / height;
      camera.filmOffset = 0;
      camera.setViewOffset(width, height,
        offsetX / (2 * halfWidth) * width, -offsetY / (2 * halfHeight) * height, width, height);
    } else {
      camera.left = -halfWidth + offsetX;
      camera.right = halfWidth + offsetX;
      camera.top = halfHeight + offsetY;
      camera.bottom = -halfHeight + offsetY;
    }
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    this.camera = camera;
    return true;
  }
}
