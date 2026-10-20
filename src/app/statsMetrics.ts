import { runtime, state } from "./appState";
import { statsPanel } from "./dom";
import { escapeMetricText, formatBytes, formatDuration } from "./metricFormatting";

function show(id: string, values: Record<string, string>) {
  const element = statsPanel.querySelector(`#${id}`)!;
  element.innerHTML = Object.entries(values).map(([label, value]) =>
    `<dt>${escapeMetricText(label)}</dt><dd>${escapeMetricText(value)}</dd>`).join("");
}

export function renderStatsMetrics(): void {
  const load = runtime.loadMetrics;
  const memory = runtime.getMemoryStats();
  const resources = state.viewport.getResourceStats();
  const js = (performance as Performance & {
    memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
  }).memory;
  show("loadMetrics", {
    "input files": load ? String(load.fileCount) : "—",
    "input total": formatBytes(load?.totalBytes),
    "root file": formatBytes(load?.rootBytes),
    "largest file": formatBytes(load?.largestBytes),
    "load state": state.isLoadingStage ? "loading" : load?.state ?? "No scene",
    "file import": formatDuration(load?.importMs),
    "USD open": formatDuration(load?.openMs),
    "extraction": formatDuration(load?.extractionMs),
    "runtime load": formatDuration(load?.runtimeMs),
    "load to ready": formatDuration(state.stageLoadElapsedMs ??
      (state.isLoadingStage && state.stageLoadStartedAt !== null ? performance.now() - state.stageLoadStartedAt : undefined)),
  });
  show("memoryMetrics", {
    "runtime": runtime.status.buildId ?? "Not loaded",
    "fallback": runtime.status.fallbackReason ?? "None",
    "WASM capacity": formatBytes(memory.capacityBytes),
    "WASM ceiling": formatBytes(memory.maximumBytes),
    "native allocated": formatBytes(memory.allocatedBytes),
    "native peak (sampled)": formatBytes(memory.peakAllocatedBytes),
    "allocator free": formatBytes(memory.allocatorFreeBytes),
    "growth headroom": formatBytes(memory.maximumBytes === undefined || memory.capacityBytes === undefined
      ? undefined : Math.max(0, memory.maximumBytes - memory.capacityBytes)),
    "imported VFS files": memory.importedFileCount === undefined ? "—" : String(memory.importedFileCount),
    "VFS logical bytes": formatBytes(memory.importedFileBytes),
    "original file copies": formatBytes(memory.originalBytes),
    "JS heap used (approx.)": formatBytes(js?.usedJSHeapSize),
    "JS heap capacity": formatBytes(js?.totalJSHeapSize),
    "JS heap limit": formatBytes(js?.jsHeapSizeLimit),
  });
  show("resourceMetrics", {
    "backend": resources.backend,
    "canvas pixels": `${resources.width} × ${resources.height}`,
    "frame interval (CPU)": formatDuration(resources.frameIntervalMs),
    "FPS (approx.)": resources.frameIntervalMs ? (1000 / resources.frameIntervalMs).toFixed(1) : "—",
    "draw calls": String(resources.drawCalls ?? "Unavailable"),
    "frame triangles": resources.frameTriangles?.toLocaleString() ?? "Unavailable",
    "GPU geometries (count)": String(resources.rendererGeometries ?? "Unavailable"),
    "GPU textures (count)": String(resources.rendererTextures ?? "Unavailable"),
    "renderer tracked bytes": formatBytes(resources.rendererTrackedBytes),
    "renderer texture bytes": formatBytes(resources.rendererTextureBytes),
    "mesh instances": resources.instances.toLocaleString(),
    "geometry buffers (CPU)": formatBytes(resources.geometryBufferBytes),
    "known texture objects": String(resources.knownTextures),
    "textures sized": String(resources.sizedTextures),
    "textures RGBA8 estimate": formatBytes(resources.textureRgba8Bytes),
  });
}

// Never scan the scene every animation frame. Hidden panels do no inventory work.
window.setInterval(() => {
  if (!statsPanel.hidden && !document.hidden) renderStatsMetrics();
}, 1000);
