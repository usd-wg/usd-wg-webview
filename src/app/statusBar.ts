import type { RuntimeStatus } from "../usd/types";
import { state } from "./appState";
import { materialXModeLabel, runtimeArchitectureLabel, splatDegradationLabel, statusLabel, statusSpinner, viewportElement } from "./dom";

export function setStatus(message: string, busy = false): void {
  statusLabel.textContent = message;
  statusSpinner.hidden = !busy;
  materialXModeLabel.hidden = !state.viewport.isExperimentalMaterialXMode();
}

export function renderRuntimeStatus(status: RuntimeStatus): void {
  runtimeArchitectureLabel.hidden = status.state !== "ready";
  runtimeArchitectureLabel.textContent = status.buildId ?? status.architecture?.toUpperCase() ?? "";
  runtimeArchitectureLabel.dataset.architecture = status.architecture ?? "";
  runtimeArchitectureLabel.dataset.buildId = status.buildId ?? "";
  runtimeArchitectureLabel.title = `${status.buildId ?? ""}${status.fallbackReason ? ` — fallback: ${status.fallbackReason}` : ""}`;
  if (!state.isLoadingStage) {
    setStatus(status.detail, status.state === "loading");
  }
}

// Persistent degradation notice: SparkJS splats only render on the WebGL
// path, so MaterialX content (which switches to the WebGPU renderer) drops
// any Gaussian splats in the stage.
let stageHasGaussianSplats = false;
let currentRendererDropsSplats = false;

export function setStageHasGaussianSplats(hasSplats: boolean): void {
  stageHasGaussianSplats = hasSplats;
  if (!hasSplats) {
    currentRendererDropsSplats = false;
  }
  renderSplatDegradationNotice();
}

viewportElement.addEventListener("renderer-switched", (event) => {
  const detail = (event as CustomEvent<{ splatsUnavailable?: boolean }>).detail;
  currentRendererDropsSplats = detail?.splatsUnavailable ?? false;
  renderSplatDegradationNotice();
});

function renderSplatDegradationNotice(): void {
  splatDegradationLabel.hidden = !(currentRendererDropsSplats && stageHasGaussianSplats);
}
