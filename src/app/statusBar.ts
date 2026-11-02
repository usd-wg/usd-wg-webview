import type { RuntimeStatus } from "../usd/types";
import { state } from "./appState";
import { materialXModeLabel, runtimeArchitectureLabel, statusLabel, statusSpinner } from "./dom";

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
