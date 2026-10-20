import { describe, expect, it, vi } from "vitest";
import { loadSelectedRuntime, parseRuntimeManifest, runtimePreference, supportsMemory64, type RuntimeManifest } from "../../src/usd/runtimeSelection";

const manifest: RuntimeManifest = {
  version: 1,
  wasm32: { architecture: "wasm32", buildId: "test-32", moduleUrl: "/usd-webview-bindings/32.js", wasmUrl: "/usd-webview-bindings/32.wasm" },
  wasm64: { architecture: "wasm64", buildId: "test-64", moduleUrl: "/usd-webview-bindings/64.js", wasmUrl: "/usd-webview-bindings/64.wasm" },
};

describe("runtime architecture selection", () => {
  it.each([true, false])("auto initializes only the supported pair (Memory64=%s)", async supported => {
    const create = vi.fn(async variant => variant.architecture);
    const result = await loadSelectedRuntime(manifest, "auto", create, () => supported);
    expect(result.runtime).toBe(supported ? "wasm64" : "wasm32");
    expect(create).toHaveBeenCalledTimes(1);
  });
  it("forced 32 never probes or initializes 64", async () => {
    const detect = vi.fn(() => true);
    const create = vi.fn(async variant => variant.architecture);
    expect((await loadSelectedRuntime(manifest, "32", create, detect)).runtime).toBe("wasm32");
    expect(detect).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
  });
  it("works with the ordinary 32-only package", async () => {
    const result = await loadSelectedRuntime({version: 1, wasm32: manifest.wasm32}, "auto", async v => v, () => true);
    expect(result.variant.architecture).toBe("wasm32");
  });
  it("falls back exactly once after a 64 startup failure and reports the cause", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const create = vi.fn().mockRejectedValueOnce(new Error("64 allocation failed")).mockResolvedValueOnce("ready");
      const result = await loadSelectedRuntime(manifest, "auto", create, () => true);
      expect(create.mock.calls.map(([v]) => v.architecture)).toEqual(["wasm64", "wasm32"]);
      expect(result.fallbackReason).toBe("64 allocation failed");
      expect(result.variant.architecture).toBe("wasm32");
    } finally { warning.mockRestore(); }
  });
  it("does not mask failures in forced 64 mode", async () => {
    const create = vi.fn(async () => { throw new Error("broken pair"); });
    await expect(loadSelectedRuntime(manifest, "64", create, () => true)).rejects.toThrow("broken pair");
    expect(create).toHaveBeenCalledTimes(1);
    await expect(loadSelectedRuntime(manifest, "64", create, () => false)).rejects.toThrow("unavailable");
    expect(create).toHaveBeenCalledTimes(1);
  });
  it("does not retry a failed 32 initialization", async () => {
    const create = vi.fn(async () => { throw new Error("32 failed"); });
    await expect(loadSelectedRuntime(manifest, "auto", create, () => false)).rejects.toThrow("32 failed");
    expect(create).toHaveBeenCalledTimes(1);
  });
  it("handles validation exceptions without throwing", () => {
    const validate = vi.spyOn(WebAssembly, "validate").mockImplementation(() => { throw new Error("disabled"); });
    try { expect(supportsMemory64()).toBe(false); } finally { validate.mockRestore(); }
  });
  it("validates modes and manifests without accepting external runtime scripts", () => {
    expect(runtimePreference("")).toBe("auto");
    expect(runtimePreference("?wasm=32")).toBe("32");
    expect(() => runtimePreference("?wasm=garbage")).toThrow();
    expect(parseRuntimeManifest(manifest)).toEqual(manifest);
    expect(() => parseRuntimeManifest({...manifest, wasm64: {...manifest.wasm64, moduleUrl: "https://example.com/runtime.js"}})).toThrow();
    expect(() => parseRuntimeManifest({...manifest, wasm32: {...manifest.wasm32, moduleUrl: "/usd-webview-bindings/../evil.js"}})).toThrow();
    expect(() => parseRuntimeManifest({version: 2})).toThrow();
    expect(() => parseRuntimeManifest({...manifest, wasm32: {...manifest.wasm32, buildId: undefined}})).toThrow();
  });
});
