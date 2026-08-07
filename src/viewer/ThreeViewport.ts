// Viewport facade. Owns the scene graph and the mesh registry, and wires the
// viewer modules together: RendererManager (WebGL/WebGPU lifecycle),
// GeometryBuilder (geometry assembly), MaterialFactory, TextureCache,
// LightingRig, NavigationController, and PickingController. The public API is
// unchanged from the pre-split single-class implementation.

import {
  AxesHelper,
  Box3,
  Color,
  type ColorSpace,
  Group,
  ImageLoader,
  InstancedMesh,
  Matrix4,
  Mesh,
  PerspectiveCamera,
  Scene,
  type ToneMapping,
  Vector3,
  WebGLRenderer,
} from "three";
import type { WebGPURenderer } from "three/webgpu";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EXRLoader } from "three/examples/jsm/loaders/EXRLoader.js";
import type { PrimTransform, RenderableMesh, RenderableGaussianSplat, RenderableLight, RenderableTexture, StageSummary } from "../usd/types";
import { GaussianSplatRenderer, type SplatViewOptions } from "./GaussianSplatRenderer";
import {
  applyGeometryGroups,
  applyMaterialXUvOptions,
  buildGeometry,
  faceExpandAttr,
  type GeometryBuildOptions,
  geometryFingerprint,
  getRenderableMaterialKey,
  renderableHasMaterialX,
  updateGeometryPositions,
} from "./GeometryBuilder";
import { Float32BufferAttribute } from "three";
import { MaterialFactory } from "./MaterialFactory";
import { TextureCache } from "./TextureCache";
import { LightingRig } from "./Lighting";
import { NavigationController, type NavigationMode } from "./Navigation";
import { PickingController } from "./Picking";
import { RendererManager } from "./RendererManager";
import type { ViewportContext } from "./viewerContext";

export type { NavigationMode } from "./Navigation";
export type ViewUpAxis = "y" | "z";

const IDENTITY_MATRIX = new Matrix4();

export class ThreeViewport {
  private readonly defaultBackground = new Color(0x181d21);
  private readonly ctx: ViewportContext;
  private readonly stageRoot = new Group();
  private readonly meshByPath = new Map<string, Mesh>();
  private readonly pathByMesh = new Map<Mesh, string>();
  private splatRenderer: GaussianSplatRenderer | null;
  private animationFrame = 0;
  private readonly resizeObserver: ResizeObserver;
  private viewUpAxis: ViewUpAxis = "y";
  private materialXFlipV = true;

  private readonly rendererManager: RendererManager;
  private readonly textures = new TextureCache();
  private readonly materials: MaterialFactory;
  private readonly lighting: LightingRig;
  private readonly navigation: NavigationController;
  private readonly picking: PickingController;

  constructor(private readonly host: HTMLElement) {
    const scene = new Scene();
    scene.background = this.defaultBackground;

    const camera = new PerspectiveCamera(50, 1, 0.01, 10000);
    camera.position.set(4, 3, 6);

    const renderer = new WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.host.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;

    this.ctx = { host, camera, scene, stageRoot: this.stageRoot, renderer, controls };

    this.rendererManager = new RendererManager(this.ctx, {
      beforeSwitch: () => this.navigation.removeGameNavigationHandlers(),
      afterSwitch: () => this.navigation.installGameNavigationHandlers(),
      onWebGpuActive: () => {
        this.lighting.useRenderer(this.ctx.renderer as WebGPURenderer);
        this.splatRenderer?.dispose();
        this.splatRenderer = null;
      },
    });
    this.materials = new MaterialFactory(this.textures, () => this.rendererManager.isWebGpuRenderer());
    this.materials.materialXLoader.manager.addHandler(/^data:image\/x-exr/i, new EXRLoader(this.materials.materialXLoader.manager));
    this.materials.materialXLoader.manager.addHandler(/^data:image\//, new ImageLoader(this.materials.materialXLoader.manager));
    this.lighting = new LightingRig(scene, this.defaultBackground, renderer);
    this.navigation = new NavigationController(this.ctx);
    this.picking = new PickingController(this.ctx, this.meshByPath, this.pathByMesh);

    this.stageRoot.name = "USD Stage Root";
    scene.add(this.stageRoot);
    scene.add(new AxesHelper(1.25));

    this.splatRenderer = new GaussianSplatRenderer(renderer, scene);

    this.resizeObserver = new ResizeObserver(() => this.rendererManager.resize());
    this.resizeObserver.observe(this.host);
    this.navigation.installGameNavigationHandlers();
    this.rendererManager.resize();
  }

  private geometryOptions(): GeometryBuildOptions {
    return {
      materialXFlipV: this.materialXFlipV,
      warnTangents: (renderable, detail) => this.materials.warnIfMaterialXNeedsTangents(renderable, detail),
    };
  }

  start(onTick?: () => void): void {
    const render = () => {
      onTick?.();
      this.navigation.tickGameNavigation();
      this.navigation.tickFrameAnim();
      this.ctx.controls.update();
      if (this.rendererManager.isWebGpuRenderer()) {
        void (this.ctx.renderer as WebGPURenderer).renderAsync(this.ctx.scene, this.ctx.camera);
      } else {
        this.ctx.renderer.render(this.ctx.scene, this.ctx.camera);
      }
      this.animationFrame = window.requestAnimationFrame(render);
    };

    render();
  }

  dispose(): void {
    window.cancelAnimationFrame(this.animationFrame);
    this.resizeObserver.disconnect();
    this.navigation.removeGameNavigationHandlers();
    this.ctx.controls.dispose();
    this.splatRenderer?.dispose();
    this.picking.clearSelectedInstanceOverlays();
    this.materials.dispose();
    this.lighting.dispose();
    this.textures.revokeTextureUrls();
    this.ctx.renderer.dispose();
    this.ctx.renderer.domElement.remove();
  }

  renderStage(
    renderables: RenderableMesh[],
    _summary: StageSummary | null,
    _hasSplats = false
  ): void {
    if (!renderables.length) {
      this.clearStage();
      this.applyViewUpAxis();
      return;
    }

    this.clearStage();

    for (const renderable of renderables) {
      const mesh = this.createSceneMesh(renderable);
      mesh.name = renderable.name || renderable.path;
      mesh.userData.materialKey = getRenderableMaterialKey(renderable, this.materialXFlipV);
      mesh.userData.ptsLen  = renderable.points.length;
      mesh.userData.ptsFingerprint = geometryFingerprint(renderable.points);
      mesh.userData.instanceCount = renderable.instanceMatrices?.length ?? 0;
      this.meshByPath.set(renderable.path, mesh);
      this.pathByMesh.set(mesh, renderable.path);
      this.applyRenderableTransform(mesh, renderable);
      this.stageRoot.add(mesh);
    }

    this.applyViewUpAxis();

    this.frameStage();
  }

  renderGaussianSplats(splats: RenderableGaussianSplat[]): void {
    if (!this.splatRenderer) {
      return;
    }
    this.splatRenderer.renderSplats(splats);
    if (splats.length > 0 && this.meshByPath.size === 0) {
      this.frameSplats(splats);
    }
  }

  setStageLights(lights: RenderableLight[]): void {
    this.lighting.setStageLights(lights);
  }

  setLightGizmosVisible(visible: boolean): void {
    this.lighting.setLightGizmosVisible(visible);
  }

  isExperimentalMaterialXMode(): boolean {
    return this.materials.isExperimentalMaterialXMode();
  }

  setMaterialXFlipV(enabled: boolean): void {
    this.materialXFlipV = enabled;
  }

  async prepareForRenderables(renderables: RenderableMesh[]): Promise<void> {
    if (renderables.some((renderable) => renderableHasMaterialX(renderable))) {
      await this.rendererManager.ensureWebGpuRenderer();
    }
  }

  frameCurrentStage(): void {
    this.frameStage();
  }

  setSplatViewOptions(options: SplatViewOptions): void {
    this.splatRenderer?.setOptions(options);
  }

  setNavigationMode(mode: NavigationMode): void {
    this.navigation.setNavigationMode(mode);
  }

  getNavigationMode(): NavigationMode {
    return this.navigation.getNavigationMode();
  }

  setViewUpAxis(axis: ViewUpAxis): void {
    this.viewUpAxis = axis;
    this.applyViewUpAxis();
    this.frameStage();
  }

  getViewUpAxis(): ViewUpAxis {
    return this.viewUpAxis;
  }

  setOutputColorSpace(colorSpace: ColorSpace): void {
    this.rendererManager.setOutputColorSpace(colorSpace);
  }

  setToneMapping(toneMapping: ToneMapping): void {
    this.rendererManager.setToneMapping(toneMapping);
  }

  setToneMappingExposure(exposure: number): void {
    this.rendererManager.setToneMappingExposure(exposure);
  }

  loadHdriMap(file: File): Promise<void> {
    return this.lighting.loadHdriMap(file);
  }

  loadHdriAsset(asset: RenderableTexture, label?: string): Promise<void> {
    return this.lighting.loadHdriAsset(asset, label);
  }

  useDefaultLighting(): void {
    this.lighting.useDefaultLighting();
  }

  setHdriMapVisible(visible: boolean): void {
    this.lighting.setHdriMapVisible(visible);
  }

  setHdriIntensity(intensity: number): void {
    this.lighting.setHdriIntensity(intensity);
  }

  setHdriRotation(degrees: number): void {
    this.lighting.setHdriRotation(degrees);
  }

  hasHdriMap(): boolean {
    return this.lighting.hasHdriMap();
  }

  setGameCameraSpeed(speed: number): void {
    this.navigation.setGameCameraSpeed(speed);
  }

  getGameCameraSpeed(): number {
    return this.navigation.getGameCameraSpeed();
  }

  updateRenderables(renderables: RenderableMesh[], forceGeometryUpdate = false): void {
    this.updateRenderablesInScope(renderables, undefined, forceGeometryUpdate);
  }

  // Partial update from the unified driver: only the supplied meshes are
  // touched; nothing outside the update set is removed.
  updateRenderablesPartial(renderables: RenderableMesh[]): void {
    const paths = new Set(renderables.map((renderable) => renderable.path));
    this.updateRenderablesInScope(renderables, (path) => paths.has(path), true);
  }

  updateRenderablesUnderRoot(
    rootPath: string,
    renderables: RenderableMesh[],
    forceGeometryUpdate = false
  ): void {
    const rootPrefix = `${rootPath}/`;
    this.updateRenderablesInScope(
      renderables,
      (path) => path === rootPath || path.startsWith(rootPrefix),
      forceGeometryUpdate
    );
  }

  private updateRenderablesInScope(
    renderables: RenderableMesh[],
    pathInScope: (path: string) => boolean = () => true,
    forceGeometryUpdate = false
  ): void {
    const newPaths = new Set(renderables.map(r => r.path));
    for (const [path, mesh] of [...this.meshByPath.entries()]) {
      if (pathInScope(path) && !newPaths.has(path)) {
        this.stageRoot.remove(mesh);
        mesh.geometry.dispose();
        this.materials.disposeMeshMaterials(mesh);
        this.meshByPath.delete(path);
        this.pathByMesh.delete(mesh);
        this.picking.forgetMesh(mesh);
      }
    }
    for (const renderable of renderables) {
      const existing = this.meshByPath.get(renderable.path);
      if (existing) {
        if (!this.sceneMeshMatchesRenderable(existing, renderable)) {
          this.stageRoot.remove(existing);
          existing.geometry.dispose();
          this.materials.disposeMeshMaterials(existing);
          this.pathByMesh.delete(existing);
          this.picking.forgetMesh(existing);

          const replacement = this.createSceneMesh(renderable);
          replacement.name = renderable.name || renderable.path;
          replacement.userData.ptsLen = renderable.points.length;
          replacement.userData.ptsFingerprint = geometryFingerprint(renderable.points);
          replacement.userData.materialKey = getRenderableMaterialKey(renderable, this.materialXFlipV);
          replacement.userData.instanceCount = renderable.instanceMatrices?.length ?? 0;
          this.meshByPath.set(renderable.path, replacement);
          this.pathByMesh.set(replacement, renderable.path);
          this.applyRenderableTransform(replacement, renderable);
          this.stageRoot.add(replacement);
          continue;
        }
        this.applyRenderableTransform(existing, renderable);
        const len = renderable.points.length;
        const fingerprint = geometryFingerprint(renderable.points);
        if (
          forceGeometryUpdate ||
          existing.userData.ptsLen !== len ||
          existing.userData.ptsFingerprint !== fingerprint
        ) {
          updateGeometryPositions(existing.geometry, renderable, this.geometryOptions());
          existing.userData.ptsLen = len;
          existing.userData.ptsFingerprint = fingerprint;
        }
        if (renderable.materialSubsets?.length || renderable.material || renderable.color) {
          this.materials.updateMeshMaterials(existing, renderable, this.materialXFlipV);
        }
        if (this.picking.isHighlighted(existing)) {
          this.picking.applyHighlight(existing);
        }
      } else {
        const mesh = this.createSceneMesh(renderable);
        mesh.name = renderable.name || renderable.path;
        mesh.userData.ptsLen = renderable.points.length;
        mesh.userData.ptsFingerprint = geometryFingerprint(renderable.points);
        mesh.userData.materialKey = getRenderableMaterialKey(renderable, this.materialXFlipV);
        mesh.userData.instanceCount = renderable.instanceMatrices?.length ?? 0;
        this.meshByPath.set(renderable.path, mesh);
        this.pathByMesh.set(mesh, renderable.path);
        this.applyRenderableTransform(mesh, renderable);
        this.stageRoot.add(mesh);
      }
    }
  }

  // Materials-only pass: called once after initial load to apply PBR materials
  // and textures onto geometry that was already built by renderStage/Hydra.
  // Never removes or rebuilds geometry — Hydra owns the geometry.
  async updateRenderablesAsync(renderables: RenderableMesh[]): Promise<void> {
    const textureLoads: Promise<void>[] = [];
    if (renderables.some((renderable) => renderableHasMaterialX(renderable))) {
      await this.rendererManager.ensureWebGpuRenderer();
    }
    for (const renderable of renderables) {
      const existing = this.meshByPath.get(renderable.path);
      if (!existing) continue;

      // Hydra skips UV extraction for skinned meshes — inject from legacy data.
      if (renderable.uvs?.length) {
        const shouldRewriteUvs =
          !existing.geometry.attributes.uv || renderableHasMaterialX(renderable);
        if (shouldRewriteUvs) {
          const faceUvs = faceExpandAttr(renderable.uvs as number[], renderable.indices as number[], 2);
          if (existing.geometry.attributes.position?.count === faceUvs.length / 2) {
            const uvAttr = new Float32BufferAttribute(faceUvs, 2);
            applyMaterialXUvOptions(uvAttr, renderable, this.materialXFlipV);
            existing.geometry.setAttribute("uv", uvAttr);
            existing.geometry.setAttribute("uv1", uvAttr.clone());
          }
        }
      }
      applyGeometryGroups(existing.geometry, renderable);
      this.materials.updateMeshMaterials(existing, renderable, this.materialXFlipV, textureLoads);
    }
    await Promise.all(textureLoads);
  }

  private createSceneMesh(renderable: RenderableMesh): Mesh {
    const geometry = buildGeometry(renderable, this.geometryOptions());
    const material = this.materials.createRenderableMaterials(renderable);
    if (renderable.instanceMatrices?.length) {
      const mesh = new InstancedMesh(geometry, material, renderable.instanceMatrices.length);
      mesh.userData.instanceOwnerPath = renderable.instanceOwnerPath ?? renderable.path;
      return mesh;
    }
    return new Mesh(geometry, material);
  }

  private sceneMeshMatchesRenderable(mesh: Mesh, renderable: RenderableMesh): boolean {
    const instanceCount = renderable.instanceMatrices?.length ?? 0;
    if (mesh instanceof InstancedMesh) {
      return instanceCount > 0 && mesh.count === instanceCount;
    }
    return instanceCount === 0;
  }

  private applyRenderableTransform(mesh: Mesh, renderable: RenderableMesh): void {
    if (renderable.matrix.length === 16) {
      mesh.matrix.set(...(renderable.matrix as Parameters<typeof mesh.matrix.set>));
      mesh.matrix.transpose();
      mesh.matrixAutoUpdate = false;
    } else {
      mesh.matrix.identity();
      mesh.matrixAutoUpdate = false;
    }

    if (!(mesh instanceof InstancedMesh)) {
      return;
    }

    const instanceMatrices = renderable.instanceMatrices ?? [];
    for (let index = 0; index < instanceMatrices.length; ++index) {
      const values = instanceMatrices[index];
      if (values?.length === 16) {
        const matrix = new Matrix4();
        matrix.set(...(values as Parameters<typeof matrix.set>));
        matrix.transpose();
        mesh.setMatrixAt(index, matrix);
      } else {
        mesh.setMatrixAt(index, IDENTITY_MATRIX);
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
  }

  updateTransforms(transforms: PrimTransform[]): void {
    for (const { path, matrix } of transforms) {
      const mesh = this.meshByPath.get(path);
      if (!mesh || matrix.length !== 16) continue;
      mesh.matrix.set(...(matrix as Parameters<typeof mesh.matrix.set>));
      mesh.matrix.transpose();
    }
  }

  private clearStage(): void {
    this.textures.bumpGeneration();
    this.splatRenderer?.clear();
    this.meshByPath.clear();
    this.pathByMesh.clear();
    this.picking.clearStageState();
    this.textures.revokeTextureUrls();
    this.materials.clearStageState();
    this.lighting.clearStageLights();
    this.stageRoot.rotation.set(0, 0, 0);
    this.stageRoot.traverse((object) => {
      if (object instanceof Mesh) {
        object.geometry.dispose();
        const materials = Array.isArray(object.material)
          ? object.material
          : [object.material];
        for (const material of materials) {
          this.textures.disposeMaterialTextures(material);
          material.dispose();
        }
      }
    });
    this.stageRoot.clear();
  }

  private applyViewUpAxis(): void {
    this.stageRoot.rotation.set(this.viewUpAxis === "z" ? -Math.PI / 2 : 0, 0, 0);
    this.lighting.setViewUpAxis(this.viewUpAxis);
    this.splatRenderer?.setViewUpAxis(this.viewUpAxis);
  }

  pickPrim(clientX: number, clientY: number): string | null {
    const lightPath = this.lighting.pickLight(clientX, clientY, this.ctx.host, this.ctx.camera);
    if (lightPath) {
      return lightPath;
    }
    return this.picking.pickPrim(clientX, clientY);
  }

  setSelectedPrim(primPath: string | null): void {
    this.picking.setSelectedPrim(primPath);
    this.lighting.setSelectedLight(primPath);
  }

  framePrim(primPath: string): void {
    const instanceBox = this.picking.getSelectedInstanceBox(primPath);
    if (instanceBox) {
      this.navigation.animateToBox(instanceBox, true);
      return;
    }
    const lightBox = this.lighting.getLightBox(primPath);
    if (lightBox) {
      this.navigation.animateToBox(lightBox, true);
      return;
    }
    const box = new Box3();
    const prefix = primPath + "/";
    for (const [path, mesh] of this.meshByPath) {
      if (path === primPath || path.startsWith(prefix)) {
        box.expandByObject(mesh);
      }
    }
    if (box.isEmpty()) return;
    this.navigation.animateToBox(box, true);
  }

  private frameSplats(splats: RenderableGaussianSplat[]): void {
    // SplatMesh doesn't participate in Box3.setFromObject, so derive a
    // rough world-space bounding box from the prim transform matrix.
    // USD matrix is row-major; translation is row 3 = m[12..14].
    // Scale estimate = max length of the three rotation/scale rows.
    const box = new Box3();
    for (const splat of splats) {
      const m = splat.matrix;
      if (m.length < 16) continue;
      const tx = m[12], ty = m[13], tz = m[14];
      const s0 = Math.sqrt(m[0] ** 2 + m[1] ** 2 + m[2] ** 2);
      const s1 = Math.sqrt(m[4] ** 2 + m[5] ** 2 + m[6] ** 2);
      const s2 = Math.sqrt(m[8] ** 2 + m[9] ** 2 + m[10] ** 2);
      const r = Math.max(s0, s1, s2, 1) * 1.5;
      box.expandByPoint(new Vector3(tx - r, ty - r, tz - r));
      box.expandByPoint(new Vector3(tx + r, ty + r, tz + r));
    }
    if (!box.isEmpty()) {
      this.navigation.animateToBox(box, false);
    }
  }

  private frameStage(): void {
    const box = new Box3().setFromObject(this.stageRoot);
    if (box.isEmpty()) return;
    this.navigation.animateToBox(box, false);
  }
}
