import { describe, expect, it } from "vitest";
import { BufferGeometry, Float32BufferAttribute, Group, InstancedMesh, Mesh, MeshBasicMaterial, Texture } from "three";
import { collectResourceMetrics } from "../../src/viewer/resourceMetrics";
import { summarizeFiles } from "../../src/usd/loadMetrics";
import { escapeMetricText, formatBytes, formatDuration } from "../../src/app/metricFormatting";

describe("large-scene metrics", () => {
  it("keeps file totals above 4 GiB without 32-bit coercion", () => {
    expect(summarizeFiles([{ name: "large.usdc", size: 5 * 1024 ** 3 }, { name: "other", size: 17 }], { size: 123 }))
      .toEqual({ fileCount: 2, totalBytes: 5 * 1024 ** 3 + 17, largestBytes: 5 * 1024 ** 3, rootBytes: 123 });
    expect(summarizeFiles([]).totalBytes).toBe(0);
  });
  it("distinguishes unavailable measurements from zero and formats binary units", () => {
    expect(formatBytes()).toBe("Unavailable");
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(8 * 1024 ** 3)).toBe("8.00 GiB");
    expect(formatBytes(NaN)).toBe("Unavailable");
    expect(formatDuration(1500)).toBe("1.50 s");
    expect(escapeMetricText('<a x="&">')).toBe("&lt;a x=&quot;&amp;&quot;&gt;");
  });
  it("counts shared geometry buffers and textures once, including instance buffers", () => {
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(new Float32Array(9), 3));
    const texture = new Texture({ width: 16, height: 8 });
    const material = new MeshBasicMaterial({ map: texture });
    const group = new Group();
    group.add(new Mesh(geometry, material), new Mesh(geometry, material), new InstancedMesh(geometry, material, 2));
    const stats = collectResourceMetrics(group, [texture]);
    expect(stats.geometryBufferBytes).toBe(9 * 4 + 2 * 16 * 4);
    expect(stats.geometries).toBe(1);
    expect(stats.instances).toBe(2);
    expect(stats.knownTextures).toBe(1);
    expect(stats.textureRgba8Bytes).toBe(16 * 8 * 4);
  });
  it("does not invent dimensions for pending textures or retain old scene data", () => {
    const root = new Group();
    expect(collectResourceMetrics(root, [new Texture()]).sizedTextures).toBe(0);
    expect(collectResourceMetrics(root).geometryBufferBytes).toBe(0);
  });
});
