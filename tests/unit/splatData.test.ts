import { Sh, Splats } from "@sparkjsdev/radix/core";
import { describe, expect, it } from "vitest";
import { encodeGaussianSplats } from "../../src/viewer/splatData";
import type { RenderableGaussianSplat } from "../../src/usd/types";

function source(overrides: Partial<RenderableGaussianSplat> = {}): RenderableGaussianSplat {
  return { path: "/World/Splats", name: "Splats", count: 2, matrix: [],
    positions: new Float32Array([1, 2, 3, -1, -2, -3]),
    scales: new Float32Array([0.2, 0.4, 0.8, 1, 2, 3]),
    orientations: new Float32Array([0, 0, 0, 1, 0, 0, Math.SQRT1_2, Math.SQRT1_2]),
    opacities: new Float32Array([0.25, 0.75]), ...overrides };
}

describe("USD Gaussian splat encoding", () => {
  it("preserves positions, anisotropic scales, xyzw rotations and opacity", () => {
    const input = source();
    const data = encodeGaussianSplats(input);
    const s = Splats.makeSplat();
    for (let i = 0; i < 2; i++) {
      Splats.load(data.bundles.packedSplats, i, s);
      expect([s.center.x, s.center.y, s.center.z]).toEqual(Array.from(input.positions.slice(i * 3, i * 3 + 3)));
      for (const [axis, offset] of [["x", 0], ["y", 1], ["z", 2]] as const) {
        expect(s.scales[axis] / input.scales[i * 3 + offset]).toBeCloseTo(1, 1);
      }
      const q = input.orientations.subarray(i * 4, i * 4 + 4);
      const dot = s.quaternion.x * q[0] + s.quaternion.y * q[1] + s.quaternion.z * q[2] + s.quaternion.w * q[3];
      expect(Math.abs(dot)).toBeGreaterThan(0.999);
      expect(s.opacity).toBeCloseTo(input.opacities[i], 2);
    }
  });

  it.each([0, 1, 2, 3])("maps coefficient-major RGB at SH degree %i without mixing splats", (degree) => {
    const stride = (degree + 1) ** 2;
    const coefficients = Float32Array.from({ length: 2 * stride * 3 }, (_, i) => Math.sin(i) * 4);
    const data = encodeGaussianSplats(source({ shCoeffs: coefficients, shDegree: degree }));
    const s = Splats.makeSplat();
    const found = Sh.find(data.bundles);
    expect(found?.degree ?? 0).toBe(degree);
    for (let i = 0; i < 2; i++) {
      Splats.load(data.bundles.packedSplats, i, s);
      for (const [channel, offset] of [["r", 0], ["g", 1], ["b", 2]] as const) {
        expect(s.rgb[channel]).toBeCloseTo(Math.max(0, Math.min(1, 0.28209479177387814 * coefficients[i * stride * 3 + offset] + 0.5)), 2);
      }
      if (found) {
        const decoded = Sh.decoder(data)(i, new Float32Array((stride - 1) * 3));
        for (let c = 0; c < decoded.length; c++) {
          expect(Math.abs(decoded[c] - coefficients[i * stride * 3 + 3 + c])).toBeLessThan(0.04);
        }
      }
    }
  });

  it("infers SH3 and uses the compact 64-byte storage combination", () => {
    const data = encodeGaussianSplats(source({ shCoeffs: new Float32Array(96) }));
    expect(Sh.find(data.bundles)).toMatchObject({ codec: "packed", degree: 3 });
    const bytes = Object.values(data.bundles).flatMap(bundle => Object.values(bundle.channels))
      .reduce((sum, channel) => sum + channel.data.byteLength, 0);
    expect(bytes).toBe(data.capacity * 64);
  });

  it("defaults absent optional data to unit white splats", () => {
    const data = encodeGaussianSplats(source({ scales: new Float32Array(), orientations: new Float32Array(), opacities: new Float32Array() }));
    const s = Splats.load(data.bundles.packedSplats, 1, Splats.makeSplat());
    expect(s.rgb).toEqual({ r: 1, g: 1, b: 1 });
    expect(s.opacity).toBe(1);
    expect(s.quaternion.w).toBeCloseTo(1);
    expect(s.scales.x).toBeCloseTo(1, 1);
    expect(Sh.find(data.bundles)).toBeUndefined();
  });

  it("accepts empty data and rejects incomplete position arrays", () => {
    expect(encodeGaussianSplats(source({ count: 0 })).count).toBe(0);
    expect(() => encodeGaussianSplats(source({ count: 3 }))).toThrow("positions/count");
    expect(() => encodeGaussianSplats(source({ count: -1 }))).toThrow("positions/count");
  });
});
