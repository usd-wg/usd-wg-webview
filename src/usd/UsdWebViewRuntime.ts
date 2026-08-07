import type {
  UsdWebViewBindings,
  MeshUpdate,
  PrimAttribute,
  RenderableGaussianSplat,
  RenderableMaterial,
  RenderableMesh,
  RenderableTexture,
  RenderPurposePolicy,
  RuntimeStatus,
  SceneGraphPrim,
  StageLoadRequest,
  StageLoadResult,
  StageSummary,
} from "./types";
import { WASM_BUILD_NAME } from "./generated/buildId";

const RUNTIME_ENTRYPOINT = `/usd-webview-bindings/usdWebViewBindings.js?v=${WASM_BUILD_NAME}`;
const RUNTIME_ASSET_ROOT = "/usd-webview-bindings/";

export class UsdWebViewRuntime {
  private bindings: UsdWebViewBindings | null = null;
  private materialXResources: RenderableTexture[] = [];
  private materialPayloadByPath = new Map<string, RenderableMaterial>();
  private hasStageDriver = false;
  private purposePolicy: RenderPurposePolicy = "defaultRender";
  // Identity index arrays for corner-expanded meshes are constant per vertex
  // count and only ever read downstream, so cache them by length instead of
  // reallocating on every playback frame.
  private identityIndicesByLength = new Map<number, Uint32Array>();
  currentStagePath: string | null = null;

  status: RuntimeStatus = {
    state: "idle",
    source: RUNTIME_ENTRYPOINT,
    detail: "Not loaded",
  };

  async load(): Promise<RuntimeStatus> {
    this.status = {
      state: "loading",
      source: RUNTIME_ENTRYPOINT,
      detail: "Looking for USD Web View bindings",
    };

    try {
      await loadRuntimeEntrypoint(RUNTIME_ENTRYPOINT);

      if (!window.UsdWebViewBindings?.createRuntime) {
        this.status = {
          state: "unavailable",
          source: RUNTIME_ENTRYPOINT,
          detail:
            "Bindings entrypoint loaded, but window.UsdWebViewBindings.createRuntime was not registered",
        };
        return this.status;
      }

      this.bindings = await window.UsdWebViewBindings.createRuntime({
        locateFile: (path) => `${RUNTIME_ASSET_ROOT}${path}`,
      });
      await this.bindings.ready;

      this.status = {
        state: "ready",
        source: RUNTIME_ENTRYPOINT,
        detail: `USD Web View bindings ready (${WASM_BUILD_NAME})`,
      };
      console.info(`[USD WebView] runtime ready on WASM build ${WASM_BUILD_NAME}`);
      return this.status;
    } catch (error) {
      this.status = {
        state: "unavailable",
        source: RUNTIME_ENTRYPOINT,
        detail: describeError(error),
      };
      return this.status;
    }
  }

  async loadStage(request: StageLoadRequest): Promise<StageLoadResult> {
    const rootFile = request.rootFile ?? request.files[0];
    this.purposePolicy = request.purposePolicy ?? this.purposePolicy;

    if (!rootFile) {
      return { summary: null };
    }

    if (!this.bindings?.createDataFile || !this.bindings.openStage) {
      return {
        summary: {
          rootFile: rootFile.webkitRelativePath || rootFile.name,
        },
      };
    }

    // Release the previous stage's native caches and MEMFS files before
    // writing the new stage's files.
    if (this.currentStagePath) {
      this.bindings.deleteStageDriver?.(this.currentStagePath);
      this.bindings.closeStage?.(this.currentStagePath);
      this.currentStagePath = null;
    }
    this.hasStageDriver = false;
    this.materialPayloadByPath.clear();

    const materialXResources: RenderableTexture[] = [];
    for (const file of request.files) {
      const path = file.webkitRelativePath || file.name;
      const data = new Uint8Array(await file.arrayBuffer());
      this.bindings.createDataFile(path, data);
      if (isMaterialXResourcePath(path)) {
        materialXResources.push({
          path,
          mimeType: mimeTypeForPath(path),
          data,
        });
      }
    }
    this.materialXResources = materialXResources;

    const rootPath = rootFile.webkitRelativePath || rootFile.name;
    const summary = await this.bindings.openStage(rootPath, request.loadAllPayloads ?? true);
    const normalizedSummary = normalizeStageSummary(rootPath, summary);

    if (normalizedSummary.error) {
      return { summary: normalizedSummary, renderables: [] };
    }

    this.currentStagePath = rootPath;
    const gaussianSplats = this.bindings.extractGaussianSplats?.(rootPath) ?? [];

    this.hasStageDriver = this.bindings.createStageDriver?.(rootPath) ?? false;
    let renderables: RenderableMesh[] = [];
    let diagnostics: StageLoadResult["diagnostics"];
    if (this.hasStageDriver) {
      this.refreshMaterialPayloads();
      const timing = this.bindings.stageDriverGetTiming?.(rootPath);
      renderables = this.drawAtTime(timing?.start ?? 0, true);
      diagnostics = this.bindings.stageDriverGetDiagnostics?.(rootPath);
    }

    return { summary: normalizedSummary, renderables, gaussianSplats, diagnostics };
  }

  // Draw the stage through the unified driver and resolve material payloads
  // onto the returned renderables. full=false returns only the time-varying
  // set (partial update).
  drawAtTime(timeCode: number, full: boolean): RenderableMesh[] {
    if (!this.bindings?.stageDriverDraw || !this.currentStagePath || !this.hasStageDriver) {
      return [];
    }
    this.bindings.stageDriverSetTime?.(this.currentStagePath, timeCode);
    const drawResult = this.bindings.stageDriverDraw(
      this.currentStagePath,
      full,
      this.purposePolicy
    );
    const meshes = drawResult?.meshes ?? [];
    return this.withMaterialXResources(
      meshes.map((update) => this.meshUpdateToRenderable(update))
    );
  }

  // Uniform stage-edit refresh: recompose the driver stage (re-mirror load
  // rules, re-infer bindings, re-bake) and return a coherent full redraw.
  refreshAfterStageEdit(timeCode: number): RenderableMesh[] {
    if (!this.bindings || !this.currentStagePath || !this.hasStageDriver) {
      return [];
    }
    this.bindings.stageDriverNotifyStageEdited?.(this.currentStagePath);
    this.refreshMaterialPayloads();
    return this.drawAtTime(timeCode, true);
  }

  setPurposePolicy(policy: RenderPurposePolicy): void {
    this.purposePolicy = policy;
  }

  getStageTiming(): { start: number; end: number; fps: number } | null {
    if (!this.bindings?.stageDriverGetTiming || !this.currentStagePath || !this.hasStageDriver) {
      return null;
    }
    const timing = this.bindings.stageDriverGetTiming(this.currentStagePath);
    if (timing?.start === undefined) {
      return null;
    }
    return { start: timing.start ?? 0, end: timing.end ?? 0, fps: timing.fps ?? 24 };
  }

  private refreshMaterialPayloads(): void {
    this.materialPayloadByPath.clear();
    if (!this.bindings?.extractMaterialPayloads || !this.currentStagePath) {
      return;
    }
    for (const entry of this.bindings.extractMaterialPayloads(this.currentStagePath)) {
      if (entry?.path && entry.material) {
        this.materialPayloadByPath.set(entry.path, entry.material);
      }
    }
  }

  private meshUpdateToRenderable(update: MeshUpdate): RenderableMesh {
    // Point-instancer entries reuse the legacy points+indices shape (with
    // materials already extracted natively); pass them through.
    if (!update.positions) {
      return update as RenderableMesh;
    }

    // Corner-expanded entry: identity indices route it through the existing
    // face-expansion pipeline untouched (expansion becomes a copy), while the
    // provided corner-stream normals are honored directly.
    const positions = new Float32Array(update.positions);
    const vertexCount = positions.length / 3;
    const indices = this.getIdentityIndices(vertexCount);

    const material = update.materialPath
      ? this.materialPayloadByPath.get(update.materialPath)
      : undefined;
    const materialSubsets = update.subsets?.map((subset) => ({
      path: subset.path,
      name: subset.name,
      start: subset.start,
      count: subset.count,
      material: subset.materialPath
        ? this.materialPayloadByPath.get(subset.materialPath)
        : material,
    }));

    return {
      path: update.path,
      name: update.name,
      points: positions,
      indices,
      normals: update.normals ? new Float32Array(update.normals) : undefined,
      uvs: update.uvs ? new Float32Array(update.uvs) : undefined,
      matrix: update.matrix,
      color: update.displayColor,
      material,
      materialSubsets,
    };
  }

  private getIdentityIndices(vertexCount: number): Uint32Array {
    const cached = this.identityIndicesByLength.get(vertexCount);
    if (cached) {
      return cached;
    }
    const indices = new Uint32Array(vertexCount);
    for (let index = 0; index < vertexCount; index += 1) {
      indices[index] = index;
    }
    this.identityIndicesByLength.set(vertexCount, indices);
    return indices;
  }

  getSceneGraph(): SceneGraphPrim[] {
    if (!this.bindings?.getSceneGraph || !this.currentStagePath) return [];
    return this.bindings.getSceneGraph(this.currentStagePath);
  }

  getPrimAttributes(primPath: string): PrimAttribute[] {
    if (!this.bindings?.getPrimAttributes || !this.currentStagePath) return [];
    return this.bindings.getPrimAttributes(this.currentStagePath, primPath);
  }

  setPrimAttribute(primPath: string, attrName: string, value: string): boolean {
    if (!this.bindings?.setPrimAttribute || !this.currentStagePath) return false;
    return this.bindings.setPrimAttribute(this.currentStagePath, primPath, attrName, value);
  }

  extractStageEnvironment() {
    if (!this.bindings?.extractStageEnvironment || !this.currentStagePath) return undefined;
    return this.bindings.extractStageEnvironment(this.currentStagePath);
  }

  getSkelDebugInfo(primPath: string, timeA = 0, timeB = 60): unknown {
    if (!this.bindings?.getSkelDebugInfo || !this.currentStagePath) {
      return null;
    }
    return this.bindings.getSkelDebugInfo(this.currentStagePath, primPath, timeA, timeB);
  }

  getLastSkelBindingOverlayContents(): string {
    if (!this.bindings?.getLastSkelBindingOverlayContents || !this.currentStagePath) {
      return "";
    }
    return this.bindings.getLastSkelBindingOverlayContents(this.currentStagePath);
  }

  extractGaussianSplats(): RenderableGaussianSplat[] {
    if (!this.bindings?.extractGaussianSplats || !this.currentStagePath) return [];
    return this.bindings.extractGaussianSplats(this.currentStagePath);
  }

  setVariantSelection(primPath: string, variantSetName: string, selection: string): boolean {
    if (!this.bindings?.setVariantSelection || !this.currentStagePath) return false;
    return this.bindings.setVariantSelection(this.currentStagePath, primPath, variantSetName, selection);
  }

  setPayloadLoaded(primPath: string, loaded: boolean): boolean {
    if (!this.bindings?.setPayloadLoaded || !this.currentStagePath) return false;
    return this.bindings.setPayloadLoaded(this.currentStagePath, primPath, loaded);
  }

  setAllPayloadsLoaded(loaded: boolean): void {
    if (!this.bindings?.setAllPayloadsLoaded || !this.currentStagePath) return;
    this.bindings.setAllPayloadsLoaded(this.currentStagePath, loaded);
  }

  private withMaterialXResources(renderables: RenderableMesh[] | null | undefined): RenderableMesh[] {
    if (!renderables?.length || !this.materialXResources.length) {
      return renderables ?? [];
    }

    for (const renderable of renderables) {
      attachMaterialXResources(renderable.material, this.materialXResources);
      for (const subset of renderable.materialSubsets ?? []) {
        attachMaterialXResources(subset.material, this.materialXResources);
      }
    }
    return renderables;
  }
}

export function attachMaterialXResources(
  material: RenderableMesh["material"],
  resources: RenderableTexture[]
): void {
  if (!material?.materialX) {
    return;
  }
  const merged = [...(material.materialX.resources ?? [])];
  const seen = new Set(merged.map((resource) => resource.path));
  for (const resource of resources) {
    if (!seen.has(resource.path)) {
      merged.push(resource);
      seen.add(resource.path);
    }
  }
  material.materialX.resources = merged;
}

export function isMaterialXResourcePath(path: string): boolean {
  return /\.(png|jpe?g|webp|svg|hdr|exr)$/i.test(path);
}

export function mimeTypeForPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".hdr")) return "image/vnd.radiance";
  if (lower.endsWith(".exr")) return "image/x-exr";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

function loadRuntimeEntrypoint(source: string): Promise<void> {
  const existingScript = document.querySelector<HTMLScriptElement>(
    `script[data-usd-webview-runtime="${source}"]`
  );

  if (existingScript?.dataset.loaded === "true") {
    return Promise.resolve();
  }

  if (existingScript) {
    return new Promise((resolve, reject) => {
      existingScript.addEventListener("load", () => resolve(), { once: true });
      existingScript.addEventListener(
        "error",
        () => reject(new Error(`Failed to load ${source}`)),
        {
          once: true,
        }
      );
    });
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.type = "module";
    script.src = source;
    script.dataset.usdWebviewRuntime = source;

    script.addEventListener(
      "load",
      () => {
        script.dataset.loaded = "true";
        resolve();
      },
      { once: true }
    );
    script.addEventListener(
      "error",
      () => reject(new Error(`Failed to load ${source}`)),
      {
        once: true,
      }
    );

    document.head.append(script);
  });
}

export function normalizeStageSummary(
  rootFile: string,
  summary: StageSummary | null
): StageSummary {
  return {
    rootFile,
    ...summary,
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
