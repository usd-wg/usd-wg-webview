import { describe, expect, it } from "vitest";
import { Matrix4, Vector3 } from "three";
import { StageCameraView } from "../../src/viewer/StageCamera";
import type { StageCameraSample } from "../../src/usd/types";

const sample: StageCameraSample = {
  path: "/Camera", matrix: new Matrix4().toArray(), projection: "perspective",
  horizontalAperture: 20, verticalAperture: 10,
  horizontalApertureOffset: 0, verticalApertureOffset: 0,
  focalLength: 10, near: 1, far: 100,
};

describe("stage camera projection", () => {
  it("fits the authored frame in wide and tall viewports without distorting it", () => {
    for (const [width, height] of [[1920, 1080], [600, 1200]]) {
      const view = new StageCameraView();
      expect(view.update(sample, width, height)).toBe(true);
      const corner = new Vector3(10, 5, -10).project(view.camera);
      const gate = view.gate!;
      expect((corner.x + 1) * width / 2).toBeCloseTo(gate.left + gate.width);
      expect((1 - corner.y) * height / 2).toBeCloseTo(gate.top);
      expect(gate.width / gate.height).toBeCloseTo(2);
    }
  });

  it("keeps horizontal and vertical aperture offsets on the authored frame", () => {
    const view = new StageCameraView();
    view.update({ ...sample, horizontalApertureOffset: 2, verticalApertureOffset: 1 }, 1000, 1000);
    const center = new Vector3(2, 1, -10).project(view.camera);
    expect(center.x).toBeCloseTo(0);
    expect(center.y).toBeCloseTo(0);
  });

  it("converts orthographic tenths-of-scene-unit apertures and ignores focal length", () => {
    const view = new StageCameraView();
    view.update({ ...sample, projection: "orthographic", focalLength: 0,
      horizontalApertureOffset: 2, verticalApertureOffset: 1 }, 1000, 500);
    for (const depth of [-2, -80]) {
      const corner = new Vector3(1.2, 0.6, depth).project(view.camera);
      expect(corner.x).toBeCloseTo(1);
      expect(corner.y).toBeCloseTo(1);
    }
  });

  it("preserves roll and composes the stage-to-view transform exactly once", () => {
    const view = new StageCameraView();
    const pose = new Matrix4().makeRotationZ(Math.PI / 2).setPosition(2, 3, 10);
    const conversion = new Matrix4().makeRotationX(-Math.PI / 2);
    view.update({ ...sample, matrix: pose.toArray() }, 1000, 500, conversion);
    const target = new Vector3(10, 5, -10).applyMatrix4(pose).applyMatrix4(conversion);
    target.project(view.camera);
    expect(target.x).toBeCloseTo(1);
    expect(target.y).toBeCloseTo(1);
    expect(view.camera.position.distanceTo(new Vector3(2, 10, -3))).toBeLessThan(1e-10);
  });

  it("rejects invalid optics without replacing a valid view", () => {
    const view = new StageCameraView();
    view.update(sample, 800, 600);
    const before = view.camera.projectionMatrix.clone();
    for (const invalid of [{ focalLength: 0 }, { near: 0 }, { far: 0 }, { verticalAperture: -1 },
      { matrix: [1, 2] }, { horizontalApertureOffset: NaN }]) {
      expect(view.update({ ...sample, ...invalid }, 800, 600)).toBe(false);
      expect(view.camera.projectionMatrix.equals(before)).toBe(true);
    }
  });
});
