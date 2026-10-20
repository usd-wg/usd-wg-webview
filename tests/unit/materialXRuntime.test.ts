import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { MaterialXAssetResolver, assetPathCandidates } from "../../src/materialx/MaterialXAssetResolver";
import { getMaterialXRuntime } from "../../src/materialx/MaterialXRuntime";

describe("MaterialXAssetResolver", () => {
  it("matches package-relative, material-relative, and basename candidates", () => {
    expect(assetPathCandidates("textures/base.png", "materials").has("materials/textures/base.png")).toBe(true);
    expect(assetPathCandidates("/scene.usdz[assets/base.png]").has("assets/base.png")).toBe(true);
    expect(assetPathCandidates("/scene.usdz[assets/base.png]").has("base.png")).toBe(true);
  });

  it("returns object URLs and revokes them on cleanup", () => {
    const createSpy = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const resolver = new MaterialXAssetResolver();

    const resolved = resolver.resolve("./textures/base.png", "materials/look.mtlx", [
      { path: "materials/textures/base.png", mimeType: "image/png", data: new Uint8Array([1]) },
    ]);

    expect(resolved?.url).toBe("blob:test");
    resolver.revokeUrls();
    expect(revokeSpy).toHaveBeenCalledWith("blob:test");
    createSpy.mockRestore();
    revokeSpy.mockRestore();
  });

  it("resolves a normalized material-relative path before duplicate basenames", () => {
    const createSpy = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
    const resolver = new MaterialXAssetResolver();
    const resolved = resolver.resolve("../image_format_png/textures/texture.png", "materials/nodes/rotate3d_identity/material.mtlx", [
      { path: "materials/nodes/image/textures/texture.png", mimeType: "image/png", data: new Uint8Array([1]) },
      { path: "materials/nodes/image_format_png/textures/texture.png", mimeType: "image/png", data: new Uint8Array([2]) },
    ]);

    expect(resolved?.path).toBe("materials/nodes/image_format_png/textures/texture.png");
    createSpy.mockRestore();
  });

  it("does not guess when only a duplicate basename matches", () => {
    const resolver = new MaterialXAssetResolver();
    const resolved = resolver.resolve("texture.png", "materials/nodes/unknown/material.mtlx", [
      { path: "materials/nodes/first/textures/texture.png", mimeType: "image/png", data: new Uint8Array([1]) },
      { path: "materials/nodes/second/textures/texture.png", mimeType: "image/png", data: new Uint8Array([2]) },
    ]);

    expect(resolved).toBeNull();
  });
});

describe("MaterialXRuntime", () => {
  it("initializes once and compiles ESSL from the official runtime", async () => {
    const baseUrl = pathToFileURL(`${process.cwd()}/public/materialx/1.39.5`).href;
    const first = await getMaterialXRuntime(baseUrl);
    const second = await getMaterialXRuntime(baseUrl);

    expect(second).toBe(first);

    const source = await readFile("tests/regression/cases/materialx-tiled/material/tiled-letter.mtlx", "utf8");

    const result = await first.compile(source, { path: "tiled-letter.mtlx", target: "essl" });

    expect(result.diagnostics).toEqual([]);
    expect(result.vertexSource).toContain("void main()");
    expect(result.fragmentSource).toContain("standard_surface");
  }, 30000);

  it("compiles connected MaterialX surface graphs for validation/reference", async () => {
    const baseUrl = pathToFileURL(`${process.cwd()}/public/materialx/1.39.5`).href;
    const runtime = await getMaterialXRuntime(baseUrl);
    const source = `<?xml version="1.0"?>
<materialx version="1.39">
  <nodegraph name="NG">
    <constant name="C" type="color3">
      <input name="value" type="color3" value="0.1, 0.2, 0.3" />
    </constant>
    <output name="out" type="color3" nodename="C" />
  </nodegraph>
  <surfacematerial name="M" type="material">
    <input name="surfaceshader" type="surfaceshader" nodename="SR" />
  </surfacematerial>
  <standard_surface name="SR" type="surfaceshader">
    <input name="base_color" type="color3" nodegraph="NG" output="out" />
  </standard_surface>
</materialx>`;

    const result = await runtime.compile(source, {
      path: "connected-surface.mtlx",
      target: "essl",
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.elementName).toBe("SR");
    expect(result.fragmentSource).toContain("SR_base_color");
    expect(result.fragmentSource).toContain("standard_surface");
  }, 30000);
});
