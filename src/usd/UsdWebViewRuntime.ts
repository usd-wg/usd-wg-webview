import type {
  UsdWebViewBindings,
  MeshUpdate,
  PrimAttribute,
  RenderableGaussianSplat,
  RenderableLight,
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
import { loadSelectedRuntime, parseRuntimeManifest, runtimePreference, type RuntimeManifest } from "./runtimeSelection";
import { summarizeFiles, type StageLoadMetrics } from "./loadMetrics";

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
  loadMetrics: StageLoadMetrics | null = null;
  private peakAllocatedBytes = 0;

  getMemoryStats() {
    const memory = this.bindings?.getMemoryStats?.();
    if (memory?.allocatedBytes !== undefined) {
      this.peakAllocatedBytes = Math.max(this.peakAllocatedBytes, memory.allocatedBytes);
    }
    return { ...memory, peakAllocatedBytes: memory?.allocatedBytes === undefined ? undefined : this.peakAllocatedBytes };
  }

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

      const preference = runtimePreference(window.location.search);
      let manifest: RuntimeManifest = {
        version: 1,
        wasm32: {
          architecture: "wasm32", buildId: WASM_BUILD_NAME,
          moduleUrl: `${RUNTIME_ASSET_ROOT}usdWebViewBindingsModule.js?v=${WASM_BUILD_NAME}`,
          wasmUrl: `${RUNTIME_ASSET_ROOT}usdWebViewBindingsModule.wasm?v=${WASM_BUILD_NAME}`,
        },
      };
      // Optional small manifest; ordinary source checkouts remain WASM32-only.
      const response = await fetch(`${RUNTIME_ASSET_ROOT}runtimes.json`, { cache: "no-store" });
      if (response.ok) manifest = parseRuntimeManifest(await response.json());
      else if (response.status !== 404) throw new Error(`Runtime manifest HTTP ${response.status}`);
      const loaded = await loadSelectedRuntime(manifest, preference, async (variant) => {
        const bindings = await window.UsdWebViewBindings!.createRuntime({
          locateFile: (path) => `${RUNTIME_ASSET_ROOT}${path}`,
          runtimeModule: variant,
        });
        await bindings.ready;
        return bindings;
      });
      this.bindings = loaded.runtime;

      this.status = {
        state: "ready",
        source: RUNTIME_ENTRYPOINT,
        architecture: loaded.variant.architecture,
        buildId: loaded.variant.buildId,
        fallbackReason: loaded.fallbackReason,
        detail: `USD Web View bindings ready (${loaded.variant.architecture}, ${loaded.variant.buildId})${loaded.fallbackReason ? " — WASM64 startup failed; using WASM32" : ""}`,
      };
      console.info("[USD WebView] runtime ready", this.status);
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
    const started = performance.now();
    this.peakAllocatedBytes = 0;
    this.loadMetrics = { ...summarizeFiles(request.files, request.rootFile ?? request.files[0]), state: "loading" };
    try {
      const result = await this.loadStageContents(request);
      this.loadMetrics.state = result.summary?.error ? "failed" : "complete";
      return result;
    } catch (error) {
      this.loadMetrics.state = "failed";
      throw error;
    } finally {
      this.loadMetrics.runtimeMs = performance.now() - started;
      this.getMemoryStats();
    }
  }

  private async loadStageContents(request: StageLoadRequest): Promise<StageLoadResult> {
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

    const importStarted = performance.now();
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
    this.loadMetrics!.importMs = performance.now() - importStarted;
    this.getMemoryStats();

    const rootPath = rootFile.webkitRelativePath || rootFile.name;
    const openStarted = performance.now();
    const summary = await this.bindings.openStage(rootPath, request.loadAllPayloads ?? true);
    this.loadMetrics!.openMs = performance.now() - openStarted;
    this.getMemoryStats();
    const normalizedSummary = normalizeStageSummary(rootPath, summary);

    if (normalizedSummary.error) {
      return { summary: normalizedSummary, renderables: [] };
    }

    this.currentStagePath = rootPath;
    const extractionStarted = performance.now();
    const gaussianSplats = this.bindings.extractGaussianSplats?.(rootPath) ?? [];
    const lights = this.bindings.extractStageLights?.(rootPath, normalizedSummary.startTimeCode ?? 0) ?? [];

    this.hasStageDriver = this.bindings.createStageDriver?.(rootPath) ?? false;
    let renderables: RenderableMesh[] = [];
    let diagnostics: StageLoadResult["diagnostics"];
    if (this.hasStageDriver) {
      this.refreshMaterialPayloads();
      const timing = this.bindings.stageDriverGetTiming?.(rootPath);
      renderables = this.drawAtTime(timing?.start ?? 0, true);
      diagnostics = this.bindings.stageDriverGetDiagnostics?.(rootPath);
    }

    this.loadMetrics!.extractionMs = performance.now() - extractionStarted;
    return { summary: normalizedSummary, renderables, gaussianSplats, lights, diagnostics };
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
    // face-expansion pipeline untouched, while the provided corner-stream
    // normals are honored directly. The native driver has already copied
    // these arrays out of WASM memory, so retain them without a second copy.
    const positions = update.positions;
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
      normals: update.normals,
      uvs: update.uvs,
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

  extractStageLights(timeCode = 0): RenderableLight[] {
    if (!this.bindings?.extractStageLights || !this.currentStagePath) return [];
    return this.bindings.extractStageLights(this.currentStagePath, timeCode);
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
