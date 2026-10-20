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
  InstancedMesh,
  Matrix3,
  Matrix4,
  type Material,
  Mesh,
  PerspectiveCamera,
  Scene,
  Texture,
  type ToneMapping,
  Vector3,
  WebGLRenderer,
  NoToneMapping,
  SRGBColorSpace,
} from "three";
import type { WebGPURenderer } from "three/webgpu";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
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
import { MaterialFactory, type MaterialXDebugOutputMode } from "./MaterialFactory";
import { TextureCache } from "./TextureCache";
import { LightingRig } from "./Lighting";
import { NavigationController, type CameraPose, type NavigationMode } from "./Navigation";
import { PickingController } from "./Picking";
import { RendererManager } from "./RendererManager";
import type { ViewportContext } from "./viewerContext";

export type { NavigationMode } from "./Navigation";
export type ViewUpAxis = "y" | "z";
export type ReferenceCaptureOptions = {
  camera?: CameraPose;
  environmentRotationDegrees?: number;
  hdriMapVisible?: boolean;
  toneMapping?: "none";
  outputColorSpace?: "srgb";
  lightGizmosVisible?: boolean;
  axesVisible?: boolean;
  materialXFlipV?: boolean;
  normalizeStageToYUp?: boolean;
  materialXDebugOutput?: MaterialXDebugOutputMode;
  modelNormalization?:
    | boolean
    | {
        enabled?: boolean;
        targetRadius?: number;
        target?: [number, number, number];
      };
};

export type ViewportDebugMaterialInfo = {
  mesh: string;
  uvCount: number | null;
  positionCount: number | null;
  materials: Array<{
    type: string;
    materialX: boolean;
    materialXHost?: string;
    materialXDebugOutput?: string;
    materialXFragmentHasGraphColorOutput?: boolean;
    materialXTextureResolutions?: unknown;
    hasMap?: boolean;
    mapName?: string;
    mapImageWidth?: number | null;
    mapImageHeight?: number | null;
  }>;
};

const IDENTITY_MATRIX = new Matrix4();
const Z_UP_TO_Y_UP = new Matrix4().makeRotationX(-Math.PI / 2);
const Y_UP_TO_Z_UP = new Matrix4().makeRotationX(Math.PI / 2);

export class ThreeViewport {
  private readonly defaultBackground = new Color(0x181d21);
  private readonly ctx: ViewportContext;
  private readonly stageRoot = new Group();
  private readonly axesHelper = new AxesHelper(1.25);
  private readonly meshByPath = new Map<string, Mesh>();
  private readonly pathByMesh = new Map<Mesh, string>();
  private splatRenderer: GaussianSplatRenderer | null;
  private animationFrame = 0;
  private readonly manualRenderMode =
    new URLSearchParams(window.location.search).get("manualRender") === "1";
  private renderQueue: Promise<void> = Promise.resolve();
  private readonly resizeObserver: ResizeObserver;
  private viewUpAxis: ViewUpAxis = "y";
  private materialXFlipV = true;
  private normalizeStageToYUp = false;
  private referenceModelNormalization:
    | Exclude<ReferenceCaptureOptions["modelNormalization"], boolean>
    | null = null;

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
    this.lighting = new LightingRig(scene, this.defaultBackground, renderer);
    this.navigation = new NavigationController(this.ctx);
    this.picking = new PickingController(this.ctx, this.meshByPath, this.pathByMesh);

    this.stageRoot.name = "USD Stage Root";
    scene.add(this.stageRoot);
    scene.add(this.axesHelper);

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
    if (this.manualRenderMode) {
      void this.renderForCapture();
      return;
    }

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

  renderForCapture(passes = 3): Promise<void> {
    this.renderQueue = this.renderQueue.then(async () => {
      this.ctx.controls.update();
      if (this.rendererManager.isWebGpuRenderer()) {
        const renderer = this.ctx.renderer as WebGPURenderer & {
          compileAsync?: (object: Group, camera: PerspectiveCamera, scene: Scene) => Promise<void>;
          renderAsync?: (scene: Scene, camera: PerspectiveCamera) => Promise<void>;
        };
        if (renderer.compileAsync) {
          await renderer.compileAsync(this.stageRoot, this.ctx.camera, this.ctx.scene);
        }
        for (let pass = 0; pass < passes; pass += 1) {
          if (renderer.renderAsync) {
            await renderer.renderAsync(this.ctx.scene, this.ctx.camera);
          } else {
            renderer.render(this.ctx.scene, this.ctx.camera);
          }
          await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
        }
      } else {
        for (let pass = 0; pass < passes; pass += 1) {
          this.ctx.renderer.render(this.ctx.scene, this.ctx.camera);
          await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
        }
      }
    });
    return this.renderQueue;
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

    for (const sourceRenderable of renderables) {
      const renderable = this.toRenderCoordinateSpace(sourceRenderable);
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
    this.syncMaterialXDefaultLight();
  }

  setLightGizmosVisible(visible: boolean): void {
    this.lighting.setLightGizmosVisible(visible);
  }

  setAxesVisible(visible: boolean): void {
    this.axesHelper.visible = visible;
  }

  isExperimentalMaterialXMode(): boolean {
    return this.materials.isExperimentalMaterialXMode();
  }

  setMaterialXFlipV(enabled: boolean): void {
    this.materialXFlipV = enabled;
  }

  setMaterialXDebugOutputMode(mode: MaterialXDebugOutputMode): boolean {
    return this.materials.setMaterialXDebugOutputMode(mode);
  }

  async prepareForRenderables(renderables: RenderableMesh[]): Promise<void> {
    if (renderables.some((renderable) => renderableHasMaterialX(renderable))) {
      await this.rendererManager.ensureWebGpuRenderer();
      await this.materials.prepareMaterialXMaterials(renderables);
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

  getDebugMaterialInfo(): ViewportDebugMaterialInfo[] {
    const info: ViewportDebugMaterialInfo[] = [];
    this.stageRoot.traverse((object) => {
      if (!(object instanceof Mesh)) {
        return;
      }
      const materials = Array.isArray(object.material)
        ? object.material
        : [object.material];
      info.push({
        mesh: object.name,
        uvCount: object.geometry.attributes.uv?.count ?? null,
        positionCount: object.geometry.attributes.position?.count ?? null,
        materials: materials.map((material) => {
          const record = material as Material & {
            map?: Texture | null;
            type?: string;
            fragmentShader?: string;
          };
          return {
            type: record.type ?? material.constructor.name,
            materialX: material.userData.webviewMaterialX === true,
            materialXHost: material.userData.webviewMaterialXHost,
            materialXDebugOutput: material.userData.webviewMaterialXDebugOutput,
            materialXFragmentHasGraphColorOutput: record.fragmentShader?.includes("out1 = vec4(final_color_out, 1.0);"),
            materialXTextureResolutions: material.userData.webviewMaterialXTextureResolutions,
            hasMap: !!record.map,
            mapName: record.map?.name,
            mapImageWidth: record.map?.image?.width ?? null,
            mapImageHeight: record.map?.image?.height ?? null,
          };
        }),
      });
    });
    return info;
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

  applyReferenceCaptureOptions(options: ReferenceCaptureOptions): boolean {
    let coordinateSpaceChanged = false;
    if (options.outputColorSpace === "srgb") {
      this.setOutputColorSpace(SRGBColorSpace);
    }
    if (options.toneMapping === "none") {
      this.setToneMapping(NoToneMapping);
      this.setToneMappingExposure(1);
    }
    if (options.environmentRotationDegrees !== undefined) {
      this.setHdriRotation(options.environmentRotationDegrees);
    }
    if (options.hdriMapVisible !== undefined) {
      this.setHdriMapVisible(options.hdriMapVisible);
    }
    if (options.lightGizmosVisible !== undefined) {
      this.setLightGizmosVisible(options.lightGizmosVisible);
    }
    if (options.axesVisible !== undefined) {
      this.setAxesVisible(options.axesVisible);
    }
    if (options.materialXFlipV !== undefined) {
      this.setMaterialXFlipV(options.materialXFlipV);
    }
    if (options.normalizeStageToYUp !== undefined &&
        options.normalizeStageToYUp !== this.normalizeStageToYUp) {
      this.normalizeStageToYUp = options.normalizeStageToYUp;
      this.applyViewUpAxis();
      coordinateSpaceChanged = true;
    }
    if (options.modelNormalization !== undefined) {
      this.setReferenceModelNormalization(options.modelNormalization);
    }
    if (options.camera) {
      this.navigation.setCameraPose(options.camera);
    }
    return coordinateSpaceChanged;
  }

  loadHdriMap(file: File): Promise<void> {
    return this.lighting.loadHdriMap(file).then(() => {
      this.syncMaterialXDefaultLight();
    });
  }

  loadHdriAsset(asset: RenderableTexture, label?: string, materialXIrradianceAsset?: RenderableTexture): Promise<void> {
    return this.lighting.loadHdriAsset(asset, label, materialXIrradianceAsset).then(() => {
      this.syncMaterialXDefaultLight();
    });
  }

  useDefaultLighting(): void {
    this.lighting.useDefaultLighting();
    this.syncMaterialXDefaultLight();
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
    for (const sourceRenderable of renderables) {
      const renderable = this.toRenderCoordinateSpace(sourceRenderable);
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
      await this.materials.prepareMaterialXMaterials(renderables);
    }
    for (const sourceRenderable of renderables) {
      const renderable = this.toRenderCoordinateSpace(sourceRenderable);
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
      mesh.matrix.copy(this.toRenderCoordinateMatrix(renderable.matrix));
      mesh.matrixAutoUpdate = false;
    } else {
      mesh.matrix.identity();
      mesh.matrixAutoUpdate = false;
    }

    // Direct matrix writes must invalidate world transforms before bounds queries.
    mesh.matrixWorldNeedsUpdate = true;

    if (!(mesh instanceof InstancedMesh)) {
      return;
    }

    const instanceMatrices = renderable.instanceMatrices ?? [];
    for (let index = 0; index < instanceMatrices.length; ++index) {
      const values = instanceMatrices[index];
      if (values?.length === 16) {
        mesh.setMatrixAt(index, this.toRenderCoordinateMatrix(values));
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
      mesh.matrixWorldNeedsUpdate = true;
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
    this.syncMaterialXDefaultLight();
    this.stageRoot.rotation.set(0, 0, 0);
    this.stageRoot.position.set(0, 0, 0);
    this.stageRoot.scale.setScalar(1);
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
    this.stageRoot.rotation.set(
      this.viewUpAxis === "z" && !this.normalizeStageToYUp ? -Math.PI / 2 : 0,
      0,
      0
    );
    this.lighting.setViewUpAxis(this.viewUpAxis);
    this.splatRenderer?.setViewUpAxis(this.viewUpAxis);
    this.applyReferenceModelNormalization();
  }

  private toRenderCoordinateSpace(renderable: RenderableMesh): RenderableMesh {
    if (!this.normalizeStageToYUp || this.viewUpAxis !== "z") {
      return renderable;
    }

    const normalized = {
      ...renderable,
      points: rotateZUpVectorsToYUp(renderable.points),
      normals: renderable.normals
        ? rotateZUpVectorsToYUp(renderable.normals)
        : undefined,
    };
    return this.bakeRenderableTransformForReferenceCapture(normalized);
  }

  private bakeRenderableTransformForReferenceCapture(renderable: RenderableMesh): RenderableMesh {
    if (renderable.instanceMatrices?.length || renderable.matrix.length !== 16) {
      return renderable;
    }

    const matrix = this.toRenderCoordinateMatrix(renderable.matrix);
    return {
      ...renderable,
      points: transformPoints(renderable.points, matrix),
      normals: renderable.normals
        ? transformNormals(renderable.normals, matrix)
        : undefined,
      matrix: [],
    };
  }

  private toRenderCoordinateMatrix(values: number[]): Matrix4 {
    const matrix = new Matrix4();
    matrix.set(...(values as Parameters<typeof matrix.set>));
    matrix.transpose();
    if (this.normalizeStageToYUp && this.viewUpAxis === "z") {
      matrix.premultiply(Z_UP_TO_Y_UP).multiply(Y_UP_TO_Z_UP);
    }
    return matrix;
  }

  private setReferenceModelNormalization(options: ReferenceCaptureOptions["modelNormalization"]): void {
    if (!options || (typeof options === "object" && options.enabled === false)) {
      this.referenceModelNormalization = null;
      this.stageRoot.position.set(0, 0, 0);
      this.stageRoot.scale.setScalar(1);
      return;
    }

    this.referenceModelNormalization =
      typeof options === "object" ? options : {};
    this.applyReferenceModelNormalization();
  }

  private applyReferenceModelNormalization(): void {
    if (!this.referenceModelNormalization || this.stageRoot.children.length === 0) {
      return;
    }

    this.stageRoot.position.set(0, 0, 0);
    this.stageRoot.scale.setScalar(1);
    this.stageRoot.updateMatrixWorld(true);

    const box = new Box3().setFromObject(this.stageRoot);
    if (box.isEmpty()) {
      return;
    }

    const size = box.getSize(new Vector3());
    const radius = size.length() * 0.5;
    const targetRadius = this.referenceModelNormalization.targetRadius ?? 2;
    if (!Number.isFinite(radius) || radius <= 0 || targetRadius <= 0) {
      return;
    }

    const target = new Vector3().fromArray(this.referenceModelNormalization.target ?? [0, 0, 0]);
    const center = box.getCenter(new Vector3());
    const scale = targetRadius / radius;
    this.stageRoot.scale.setScalar(scale);
    this.stageRoot.position.copy(target).sub(center.multiplyScalar(scale));
    this.stageRoot.updateMatrixWorld(true);
  }

  private syncMaterialXDefaultLight(): void {
    // Three's MaterialXLoader renders through the active Three lighting stack.
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

function rotateZUpVectorsToYUp(values: ArrayLike<number>): Float32Array {
  const transformed = new Float32Array(values.length);
  for (let index = 0; index + 2 < values.length; index += 3) {
    transformed[index] = values[index];
    transformed[index + 1] = values[index + 2];
    transformed[index + 2] = -values[index + 1];
  }
  return transformed;
}

function transformPoints(values: ArrayLike<number>, matrix: Matrix4): Float32Array {
  const transformed = new Float32Array(values.length);
  const point = new Vector3();
  for (let index = 0; index + 2 < values.length; index += 3) {
    point.set(values[index], values[index + 1], values[index + 2]).applyMatrix4(matrix);
    transformed[index] = point.x;
    transformed[index + 1] = point.y;
    transformed[index + 2] = point.z;
  }
  return transformed;
}

function transformNormals(values: ArrayLike<number>, matrix: Matrix4): Float32Array {
  const transformed = new Float32Array(values.length);
  const normalMatrix = new Matrix3().getNormalMatrix(matrix);
  const normal = new Vector3();
  for (let index = 0; index + 2 < values.length; index += 3) {
    normal.set(values[index], values[index + 1], values[index + 2])
      .applyMatrix3(normalMatrix)
      .normalize();
    transformed[index] = normal.x;
    transformed[index + 1] = normal.y;
    transformed[index + 2] = normal.z;
  }
  return transformed;
}
