// Pure gate evaluation for the visual regression suite. Kept side-effect
// free so it can be unit tested.

export const DEFAULT_GATE = {
  // pixelmatch per-pixel color threshold (0..1, lower = stricter).
  pixelmatchThreshold: 0.1,
  // Fraction of differing pixels tolerated per capture.
  maxMismatchRatio: 0.002,
};

export function resolveGate(caseGateOverrides) {
  return { ...DEFAULT_GATE, ...(caseGateOverrides ?? {}) };
}

/**
 * @param {Array<{
 *   caseId: string,
 *   captureName: string,
 *   status: "compared" | "missing-baseline" | "size-mismatch" | "capture-error" | "blessed" | "skipped",
 *   mismatchRatio?: number,
 *   detail?: string,
 *   gate: { pixelmatchThreshold: number, maxMismatchRatio: number },
 * }>} entries
 */
export function evaluateGate(entries) {
  const failures = [];

  for (const entry of entries) {
    if (entry.status === "blessed" || entry.status === "skipped") {
      continue;
    }
    if (entry.status !== "compared") {
      failures.push({
        ...entry,
        reason: entry.detail
          ? `${entry.status}: ${entry.detail}`
          : entry.status,
      });
      continue;
    }
    if ((entry.mismatchRatio ?? Infinity) > entry.gate.maxMismatchRatio) {
      failures.push({
        ...entry,
        reason:
          `mismatchRatio ${entry.mismatchRatio?.toFixed(6)} exceeds ` +
          `maxMismatchRatio ${entry.gate.maxMismatchRatio}`,
      });
    }
  }

  return { pass: failures.length === 0, failures };
}
