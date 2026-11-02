import { Sh, Splats, type SplatData } from "@sparkjsdev/radix/core";
import type { RenderableGaussianSplat } from "../usd/types";

const SH_C0 = 0.28209479177387814;

// Preserve the compact base layout. Packed SH retains the authored coefficient
// range, at 48 B for SH3 (64 B including the base splat).
export function encodeGaussianSplats(source: RenderableGaussianSplat): SplatData<"packedSplats"> {
  const { count, positions, scales, orientations, opacities, shCoeffs } = source;
  if (!Number.isSafeInteger(count) || count < 0 || positions.length < count * 3) {
    throw new Error("Invalid Gaussian splat positions/count for " + source.path);
  }
  const data = Splats.make(count, { layout: "packedSplats" });
  const encode = Splats.encoder(data.bundles.packedSplats);
  const record = Splats.makeExtSplat();
  const inferredStride = count > 0 ? Math.floor((shCoeffs?.length ?? 0) / (count * 3)) : 0;
  const authoredDegree = source.shDegree;
  const stride = Number.isInteger(authoredDegree) && authoredDegree! >= 0
    ? (authoredDegree! + 1) ** 2 : inferredStride;
  const degree = Math.max(0, Math.min(3, Math.floor(Math.sqrt(Math.min(stride, inferredStride))) - 1));
  const encodeSh = Sh.prepare(data, degree, "packed");
  const coeffs = new Float32Array(((degree + 1) ** 2 - 1) * 3);
  for (let i = 0; i < count; i++) {
    record.center.x = positions[i * 3];
    record.center.y = positions[i * 3 + 1];
    record.center.z = positions[i * 3 + 2];
    record.scales.x = scales[i * 3] ?? 1;
    record.scales.y = scales[i * 3 + 1] ?? 1;
    record.scales.z = scales[i * 3 + 2] ?? 1;
    record.quaternion.x = orientations[i * 4] ?? 0;
    record.quaternion.y = orientations[i * 4 + 1] ?? 0;
    record.quaternion.z = orientations[i * 4 + 2] ?? 0;
    record.quaternion.w = orientations[i * 4 + 3] ?? 1;
    record.opacity = opacities[i] ?? 1;
    const dc = i * stride * 3;
    const hasDc = shCoeffs && stride > 0 && dc + 2 < shCoeffs.length;
    record.rgb.r = hasDc ? Math.max(0, Math.min(1, SH_C0 * shCoeffs[dc] + 0.5)) : 1;
    record.rgb.g = hasDc ? Math.max(0, Math.min(1, SH_C0 * shCoeffs[dc + 1] + 0.5)) : 1;
    record.rgb.b = hasDc ? Math.max(0, Math.min(1, SH_C0 * shCoeffs[dc + 2] + 0.5)) : 1;
    encode(i, record);
    if (encodeSh) {
      for (let c = 0; c < coeffs.length; c++) coeffs[c] = shCoeffs?.[dc + 3 + c] ?? 0;
      encodeSh(i, coeffs);
    }
  }
  return data;
}
