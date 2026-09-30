import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

export function diffAgainstBaseline(baselinePng, resultPng, gate, diffPath) {
  if (
    baselinePng.width !== resultPng.width ||
    baselinePng.height !== resultPng.height
  ) {
    return {
      status: "size-mismatch",
      detail:
        `baseline ${baselinePng.width}x${baselinePng.height} vs ` +
        `result ${resultPng.width}x${resultPng.height}`,
    };
  }

  const { width, height } = baselinePng;
  const diffPng = new PNG({ width, height });
  const mismatched = pixelmatch(
    baselinePng.data,
    resultPng.data,
    diffPng.data,
    width,
    height,
    { threshold: gate.pixelmatchThreshold }
  );
  const mismatchRatio = mismatched / (width * height);
  return { status: "compared", mismatchRatio, diffPng, diffPath };
}
