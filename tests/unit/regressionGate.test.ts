import { describe, expect, it } from "vitest";
import { DEFAULT_GATE, evaluateGate, resolveGate } from "../regression/gate.mjs";

const gate = DEFAULT_GATE;

function entry(overrides: Record<string, unknown>) {
  return { caseId: "case", captureName: "default", gate, ...overrides };
}

describe("resolveGate", () => {
  it("applies defaults and per-case overrides", () => {
    expect(resolveGate(undefined)).toEqual(DEFAULT_GATE);
    expect(resolveGate({ maxMismatchRatio: 0.05 })).toEqual({
      pixelmatchThreshold: DEFAULT_GATE.pixelmatchThreshold,
      maxMismatchRatio: 0.05,
    });
  });
});

describe("evaluateGate", () => {
  it("passes when every capture is within its threshold", () => {
    const verdict = evaluateGate([
      entry({ status: "compared", mismatchRatio: 0 }),
      entry({ status: "compared", mismatchRatio: 0.001 }),
      entry({ status: "blessed" }),
      entry({ status: "skipped" }),
    ]);
    expect(verdict.pass).toBe(true);
    expect(verdict.failures).toEqual([]);
  });

  it("fails a capture over its mismatch budget", () => {
    const verdict = evaluateGate([entry({ status: "compared", mismatchRatio: 0.01 })]);
    expect(verdict.pass).toBe(false);
    expect(verdict.failures[0].reason).toContain("exceeds");
  });

  it("respects per-entry gate overrides", () => {
    const loose = { ...gate, maxMismatchRatio: 0.05 };
    const verdict = evaluateGate([
      entry({ status: "compared", mismatchRatio: 0.01, gate: loose }),
    ]);
    expect(verdict.pass).toBe(true);
  });

  it("fails missing baselines, size mismatches, and capture errors", () => {
    for (const status of ["missing-baseline", "size-mismatch", "capture-error"]) {
      const verdict = evaluateGate([entry({ status, detail: "info" })]);
      expect(verdict.pass, status).toBe(false);
      expect(verdict.failures[0].reason).toContain(status);
    }
  });

  it("treats a compared entry with no ratio as failing", () => {
    const verdict = evaluateGate([entry({ status: "compared" })]);
    expect(verdict.pass).toBe(false);
  });
});
