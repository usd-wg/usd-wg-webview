import {
  AlwaysDepth, DepthTexture, HalfFloatType, LinearSRGBColorSpace, NoToneMapping,
  RenderTarget, Scene, Vector2, type Camera,
} from "three";
import { NodeMaterial, QuadMesh, type WebGPURenderer } from "three/webgpu";
import { renderOutput, texture } from "three/tsl";

// Gaussian colors are trained for sRGB alpha blending. Render lit geometry in
// linear color, encode it once, copy its depth, then blend splats in sRGB on the
// same canvas. All passes use the same device, without a CPU readback.
export class SplatCompositor {
  private readonly target = new RenderTarget(1, 1, {
    type: HalfFloatType,
    depthTexture: new DepthTexture(1, 1),
    samples: 4,
  });
  private readonly material = new NodeMaterial();
  private readonly quad = new QuadMesh(this.material);
  private readonly copyScene = new Scene();
  private readonly size = new Vector2();
  private outputKey = "";

  constructor(private readonly renderer: WebGPURenderer) {
    this.target.samples = renderer.samples;
    this.copyScene.add(this.quad);
    this.material.depthTest = true;
    this.material.depthWrite = true;
    this.material.depthFunc = AlwaysDepth;
    this.material.depthNode = texture(this.target.depthTexture!).r;
  }

  render(meshScene: Scene, splatScene: Scene, camera: Camera): void {
    const renderer = this.renderer;
    renderer.getDrawingBufferSize(this.size);
    this.target.setSize(this.size.x, this.size.y);
    const { outputColorSpace, toneMapping, autoClear } = renderer;
    const previousTarget = renderer.getRenderTarget();
    const key = `${outputColorSpace}:${toneMapping}`;
    if (key !== this.outputKey) {
      this.material.fragmentNode = renderOutput(texture(this.target.texture), toneMapping, outputColorSpace);
      this.material.needsUpdate = true;
      this.outputKey = key;
    }
    try {
      renderer.setRenderTarget(this.target);
      renderer.autoClear = true;
      renderer.render(meshScene, camera);

      // This pass already encodes output color/tone mapping. Disable Three's
      // implicit output pass while copying to the canvas and drawing splats.
      renderer.setRenderTarget(previousTarget);
      renderer.outputColorSpace = LinearSRGBColorSpace;
      renderer.toneMapping = NoToneMapping;
      // Render as a scene, not QuadMesh.render(): Three disables MSAA for its
      // special fullscreen pass. Changing sample counts before the splat pass
      // reallocates the WebGPU canvas attachments and loses color/depth.
      renderer.render(this.copyScene, this.quad.camera);
      renderer.autoClear = false;
      renderer.render(splatScene, camera);
    } finally {
      renderer.setRenderTarget(previousTarget);
      renderer.outputColorSpace = outputColorSpace;
      renderer.toneMapping = toneMapping;
      renderer.autoClear = autoClear;
    }
  }

  dispose(): void {
    this.target.dispose();
    this.material.dispose();
  }
}
