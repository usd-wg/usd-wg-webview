import { describe, expect, it } from "vitest";
import {
  attachMaterialXResources,
  isMaterialXResourcePath,
  mimeTypeForPath,
  normalizeStageSummary,
} from "../../src/usd/UsdWebViewRuntime";
import type { RenderableMaterial, RenderableTexture } from "../../src/usd/types";

describe("isMaterialXResourcePath", () => {
  it("accepts MaterialX image resource extensions", () => {
    for (const path of ["a.png", "dir/b.jpg", "c.JPEG", "d.webp", "e.svg", "f.exr", "g.hdr"]) {
      expect(isMaterialXResourcePath(path), path).toBe(true);
    }
  });

  it("rejects non-image paths", () => {
    for (const path of ["a.usd", "b.mtlx", "e.png.usd"]) {
      expect(isMaterialXResourcePath(path), path).toBe(false);
    }
  });
});

describe("mimeTypeForPath", () => {
  it("maps known extensions", () => {
    expect(mimeTypeForPath("a.hdr")).toBe("image/vnd.radiance");
    expect(mimeTypeForPath("a.jpg")).toBe("image/jpeg");
    expect(mimeTypeForPath("a.JPEG")).toBe("image/jpeg");
    expect(mimeTypeForPath("a.png")).toBe("image/png");
    expect(mimeTypeForPath("a.webp")).toBe("image/webp");
    expect(mimeTypeForPath("a.svg")).toBe("image/svg+xml");
    expect(mimeTypeForPath("a.exr")).toBe("image/x-exr");
  });

  it("falls back to octet-stream", () => {
    expect(mimeTypeForPath("a")).toBe("application/octet-stream");
  });
});

describe("normalizeStageSummary", () => {
  it("injects the root file when the summary is null", () => {
    expect(normalizeStageSummary("scene.usda", null)).toEqual({ rootFile: "scene.usda" });
  });

  it("lets summary fields override the injected root file", () => {
    const summary = normalizeStageSummary("scene.usda", {
      rootFile: "other.usda",
      primCount: 3,
    });
    // Documents current behavior: spread order means the summary's own
    // rootFile wins over the requested path.
    expect(summary.rootFile).toBe("other.usda");
    expect(summary.primCount).toBe(3);
  });
});

describe("attachMaterialXResources", () => {
  const resources: RenderableTexture[] = [
    { path: "tex.png", mimeType: "image/png", data: new Uint8Array([1]) },
  ];

  it("attaches resources only to MaterialX materials", () => {
    const material: RenderableMaterial = {
      materialX: { path: "m.mtlx", mimeType: "application/xml", data: new Uint8Array() },
    };
    attachMaterialXResources(material, resources);
    expect(material.materialX?.resources).toEqual(resources);
  });

  it("preserves native MaterialX resources when adding loose-file resources", () => {
    const nativeResource = { path: "scene.usdz[0/native.jpg]", mimeType: "image/jpeg", data: new Uint8Array([2]) };
    const material: RenderableMaterial = {
      materialX: {
        path: "m.mtlx",
        mimeType: "application/xml",
        data: new Uint8Array(),
        resources: [nativeResource],
      },
    };
    attachMaterialXResources(material, resources);
    expect(material.materialX?.resources).toEqual([nativeResource, ...resources]);
  });

  it("ignores materials without a MaterialX payload", () => {
    const material: RenderableMaterial = { diffuseColor: [1, 0, 0] };
    attachMaterialXResources(material, resources);
    expect("resources" in material).toBe(false);
  });

  it("tolerates undefined materials", () => {
    expect(() => attachMaterialXResources(undefined, resources)).not.toThrow();
  });
});
