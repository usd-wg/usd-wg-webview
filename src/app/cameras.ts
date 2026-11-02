import { runtime, state } from "./appState";
import { cameraSelect } from "./dom";
import { setStatus } from "./statusBar";

export function selectCamera(path: string | null): boolean {
  if (state.isLoadingStage) return false;
  if (path && !state.stageCameras.some(camera => camera.path === path)) return false;
  state.selectedCameraPath = path;
  return sampleSelectedCamera(state.animCurrent);
}

export function sampleSelectedCamera(timeCode: number): boolean {
  const path = state.selectedCameraPath;
  const sample = path ? runtime.sampleStageCamera(path, timeCode) : null;
  if (path && (!sample || !state.viewport.setStageCamera(sample))) {
    state.selectedCameraPath = null;
    state.viewport.setStageCamera(null);
    cameraSelect.value = "";
    setStatus(`Cannot view camera ${path} at this time; returned to the editor view.`, false);
    return false;
  }
  if (!path) state.viewport.setStageCamera(null);
  cameraSelect.value = path ?? "";
  return true;
}

export function refreshCameras(): void {
  state.stageCameras = runtime.getStageCameras().sort((a, b) => a.path.localeCompare(b.path));
  cameraSelect.replaceChildren();
  if (state.stageCameras.length) {
    const group = document.createElement("optgroup");
    group.label = "Stage cameras";
    for (const camera of state.stageCameras) group.append(new Option(camera.path, camera.path));
    cameraSelect.append(group);
  }
  const editor = document.createElement("optgroup");
  editor.label = "Editor";
  editor.append(new Option("Perspective", ""));
  cameraSelect.append(editor);
  cameraSelect.disabled = false;
  if (!state.stageCameras.some(camera => camera.path === state.selectedCameraPath)) {
    state.selectedCameraPath = null;
  }
  sampleSelectedCamera(state.animCurrent);
}

export function clearCameras(): void {
  state.stageCameras = [];
  state.selectedCameraPath = null;
  state.viewport.setStageCamera(null);
  cameraSelect.replaceChildren(new Option("Perspective", ""));
  cameraSelect.disabled = true;
}

cameraSelect.addEventListener("change", () => selectCamera(cameraSelect.value || null));
