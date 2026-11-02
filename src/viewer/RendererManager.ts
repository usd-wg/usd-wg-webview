// One initialized TSL renderer for meshes, MaterialX and splats.
import { createRenderer, getGpuCaps } from "@sparkjsdev/radix";
import type { ColorSpace, ToneMapping } from "three";
import type { ViewportContext } from "./viewerContext";

export class RendererManager {
  static createRenderer() {
    const forceWebGL = new URLSearchParams(window.location.search).get("forceWebGL") === "1";
    return createRenderer({
      backend: forceWebGL ? "webgpu-gl" : undefined,
      antialias: true,
      // Lit meshes and MaterialX need Three's linear intermediate/output pass.
      directCanvas: false,
    });
  }

  constructor(private readonly ctx: ViewportContext) {}

  getBackend(): "WebGPU" | "WebGL2" {
    return getGpuCaps(this.ctx.renderer).backend === "webgpu" ? "WebGPU" : "WebGL2";
  }

  getAdapterInfo() {
    const device = (this.ctx.renderer.backend as { device?: { adapterInfo?: {
      vendor: string; architecture: string; device: string; description: string;
    } } }).device;
    const info = device?.adapterInfo;
    return info ? { vendor: info.vendor, architecture: info.architecture,
      device: info.device, description: info.description } : undefined;
  }

  setOutputColorSpace(colorSpace: ColorSpace): void { this.ctx.renderer.outputColorSpace = colorSpace; }
  setToneMapping(toneMapping: ToneMapping): void { this.ctx.renderer.toneMapping = toneMapping; }
  setToneMappingExposure(exposure: number): void { this.ctx.renderer.toneMappingExposure = Math.min(5, Math.max(0, exposure)); }

  resize(): void {
    const width = Math.max(this.ctx.host.clientWidth, 1);
    const height = Math.max(this.ctx.host.clientHeight, 1);
    this.ctx.camera.aspect = width / height;
    this.ctx.camera.updateProjectionMatrix();
    this.ctx.renderer.setSize(width, height, false);
  }
}
