import { Box3, BoxGeometry, Group, Matrix4, Mesh } from "three";
import { describe, expect, it } from "vitest";
import { ThreeViewport } from "../../src/viewer/ThreeViewport";
import type { RenderableMesh } from "../../src/usd/types";

// These transform operations do not need a DOM canvas or a WebGL renderer.
function viewport(): ThreeViewport {
  return Object.create(ThreeViewport.prototype) as ThreeViewport;
}

function renderable(x: number): RenderableMesh {
  return {
    path: "/World/Cube",
    name: "Cube",
    points: [],
    indices: [],
    matrix: new Matrix4().makeTranslation(x, 0, 0).toArray(),
  };
}

describe("viewport world transforms", () => {
  it("frames translated meshes before the first render and after edits", () => {
    const view = viewport();
    const root = new Group();
    const mesh = new Mesh(new BoxGeometry(1, 1, 1));
    root.add(mesh);

    for (const x of [-1.5, 2]) {
      view["applyRenderableTransform"](mesh, renderable(x));
      const bounds = new Box3().setFromObject(root);
      expect(bounds.min.x).toBeCloseTo(x - 0.5);
      expect(bounds.max.x).toBeCloseTo(x + 0.5);
    }

    view["applyRenderableTransform"](mesh, { ...renderable(0), matrix: [] });
    expect(new Box3().setFromObject(root).min.x).toBeCloseTo(-0.5);
  });

  it("refreshes bounds after a transform-only update", () => {
    const view = viewport();
    const mesh = new Mesh(new BoxGeometry(1, 1, 1));
    mesh.matrixAutoUpdate = false;
    Object.assign(view, { meshByPath: new Map([["/World/Cube", mesh]]) });
    new Box3().setFromObject(mesh);

    view.updateTransforms([{ path: "/World/Cube", matrix: renderable(3).matrix }]);
    expect(new Box3().setFromObject(mesh).min.x).toBeCloseTo(2.5);
  });
});
