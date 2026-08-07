import {
  ACESFilmicToneMapping,
  AgXToneMapping,
  CineonToneMapping,
  CustomToneMapping,
  LinearSRGBColorSpace,
  LinearToneMapping,
  NeutralToneMapping,
  NoToneMapping,
  ReinhardToneMapping,
  SRGBColorSpace,
  type ColorSpace,
  type ToneMapping,
} from "three";
import { ThreeViewport, type NavigationMode } from "../viewer/ThreeViewport";
import {
  loadAllPayloadsOnStageOpenStorageKey,
  runtime,
  splatDetailOptions,
  splatFidelityOptions,
  state,
  type LightingMode,
  type PurposeChoice,
  type ToneMappingChoice,
  type UpAxisChoice,
} from "./appState";
import {
  app,
  filePicker,
  folderPicker,
  hdriIntensityInput,
  hdriIntensityValue,
  hdriPicker,
  statsClose,
  statsPanel,
  toneMappingExposureInput,
  toneMappingExposureValue,
  tutorialClose,
  tutorialOverlay,
  viewportElement,
} from "./dom";
import { waitForUiPaint } from "./automation";
import { onTick } from "./animation";
import { setStatus } from "./statusBar";
import { collectRendererStats, getEffectiveUpAxis, renderStageSummary } from "./summaries";
import { applyStageEdit } from "./stageEdits";

const menuItems = Array.from(app.querySelectorAll<HTMLElement>(".menu-item"));
let activeMenu: HTMLElement | null = null;
let menuClickActive = false;

function openMenu(item: HTMLElement): void {
  activeMenu?.classList.remove("menu-open");
  activeMenu = item;
  item.classList.add("menu-open");
}

export function closeMenus(): void {
  activeMenu?.classList.remove("menu-open");
  activeMenu = null;
  menuClickActive = false;
}

for (const item of menuItems) {
  const btn = item.querySelector<HTMLButtonElement>(".menu-btn");
  if (!btn) continue;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (activeMenu === item && menuClickActive) {
      closeMenus();
    } else {
      openMenu(item);
      menuClickActive = true;
    }
  });
  btn.addEventListener("mouseenter", () => {
    if (menuClickActive && activeMenu !== item) openMenu(item);
  });
}

document.addEventListener("click", () => closeMenus());

app.querySelector("#menuOpenFile")?.addEventListener("click", () => {
  filePicker.click();
});

app.querySelector("#menuOpenFolder")?.addEventListener("click", () => {
  folderPicker.click();
});

app.querySelector("#menuStats")?.addEventListener("click", () => {
  statsPanel.hidden = !statsPanel.hidden;
});

export function applyNavigationOptions(): void {
  state.viewport.setNavigationMode(state.navigationMode);
  state.viewport.setGameCameraSpeed(state.gameCameraSpeed);

  for (const button of app.querySelectorAll<HTMLButtonElement>("[data-navigation-mode]")) {
    button.classList.toggle("menu-option--checked", button.dataset.navigationMode === state.navigationMode);
  }
  for (const button of app.querySelectorAll<HTMLButtonElement>("[data-camera-speed]")) {
    button.classList.toggle("menu-option--checked", Number(button.dataset.cameraSpeed) === state.gameCameraSpeed);
  }
}

export function applyUpAxisOptions(): void {
  const effectiveUpAxis = getEffectiveUpAxis(state.currentStageSummary?.upAxis);
  state.viewport.setViewUpAxis(effectiveUpAxis);

  for (const button of app.querySelectorAll<HTMLButtonElement>("[data-up-axis]")) {
    button.classList.toggle("menu-option--checked", button.dataset.upAxis === state.upAxisChoice);
  }
  renderStageSummary(state.currentStageSummary);
}

export function applyColorSpaceOptions(): void {
  state.viewport.setOutputColorSpace(state.outputColorSpace as ColorSpace);
  for (const button of app.querySelectorAll<HTMLButtonElement>("[data-output-color-space]")) {
    button.classList.toggle("menu-option--checked", button.dataset.outputColorSpace === state.outputColorSpace);
  }
}

export async function applyMaterialXOptions(): Promise<void> {
  state.viewport.setMaterialXFlipV(state.materialXFlipV);
  app.querySelector<HTMLButtonElement>("#menuMaterialXFlipV")
    ?.classList.toggle("menu-option--checked", state.materialXFlipV);

  if (!runtime.currentStagePath || state.isLoadingStage) {
    return;
  }

  const materializedRenderables = runtime.drawAtTime(state.animCurrent, true);
  if (materializedRenderables.length === 0) {
    return;
  }

  setStatus("reloading MaterialX...", true);
  await state.viewport.updateRenderablesAsync(materializedRenderables);
  setStatus("Ready", false);
}

export async function applyPurposeOptions(): Promise<void> {
  runtime.setPurposePolicy(state.purposePolicy);
  for (const button of app.querySelectorAll<HTMLButtonElement>("[data-purpose-policy]")) {
    button.classList.toggle("menu-option--checked", button.dataset.purposePolicy === state.purposePolicy);
  }

  if (!runtime.currentStagePath || state.isLoadingStage) {
    return;
  }

  setStatus("updating purpose...", true);
  const renderables = runtime.drawAtTime(state.animCurrent, true);
  await state.viewport.prepareForRenderables(renderables);
  state.viewport.updateRenderables(renderables, true);
  if (renderables.length > 0) {
    await state.viewport.updateRenderablesAsync(renderables);
  }
  const gaussianSplats = runtime.extractGaussianSplats();
  state.viewport.renderGaussianSplats(gaussianSplats);
  state.currentRendererStats = collectRendererStats(renderables, gaussianSplats);
  renderStageSummary(state.currentStageSummary);
  setStatus("Ready", false);
}

function toneMappingForChoice(choice: ToneMappingChoice): ToneMapping {
  switch (choice) {
    case "linear":
      return LinearToneMapping;
    case "reinhard":
      return ReinhardToneMapping;
    case "cineon":
      return CineonToneMapping;
    case "aces":
      return ACESFilmicToneMapping;
    case "agx":
      return AgXToneMapping;
    case "neutral":
      return NeutralToneMapping;
    case "custom":
      return CustomToneMapping;
    case "none":
    default:
      return NoToneMapping;
  }
}

export function applyToneMappingOptions(): void {
  state.viewport.setToneMapping(toneMappingForChoice(state.toneMappingChoice));
  state.viewport.setToneMappingExposure(state.toneMappingExposure);
  for (const button of app.querySelectorAll<HTMLButtonElement>("[data-tone-mapping]")) {
    button.classList.toggle("menu-option--checked", button.dataset.toneMapping === state.toneMappingChoice);
  }
  toneMappingExposureInput.value = String(state.toneMappingExposure);
  toneMappingExposureValue.textContent = state.toneMappingExposure.toFixed(2);
}

export function applyLightingOptions(): void {
  for (const button of app.querySelectorAll<HTMLButtonElement>("[data-lighting-mode]")) {
    button.classList.toggle("menu-option--checked", button.dataset.lightingMode === state.lightingMode);
  }
  app.querySelector<HTMLButtonElement>("#menuHdriVisible")
    ?.classList.toggle("menu-option--checked", state.hdriMapVisible);
  app.querySelector<HTMLButtonElement>("#menuLightGizmos")
    ?.classList.toggle("menu-option--checked", state.lightGizmosVisible);
  const loadButton = app.querySelector<HTMLButtonElement>("#menuLoadHdriMap");
  if (loadButton) {
    loadButton.classList.toggle("menu-option--checked", state.lightingMode === "hdri");
    loadButton.textContent = state.hdriMapLabel
      ? `Load HDRi map... (${state.hdriMapLabel})`
      : "Load HDRi map...";
  }
  hdriIntensityInput.value = String(state.hdriIntensity);
  hdriIntensityValue.textContent = state.hdriIntensity.toFixed(2);
}

export function syncViewportState(target: ThreeViewport): void {
  target.setSplatViewOptions({
    maxShDegree: splatFidelityOptions[state.splatFidelityIndex].maxShDegree,
    scaleMultiplier: splatDetailOptions[state.splatDetailIndex].scaleMultiplier,
  });
  target.setNavigationMode(state.navigationMode);
  target.setGameCameraSpeed(state.gameCameraSpeed);
  target.setViewUpAxis(getEffectiveUpAxis(state.currentStageSummary?.upAxis));
  target.setOutputColorSpace(state.outputColorSpace as ColorSpace);
  target.setMaterialXFlipV(state.materialXFlipV);
  target.setToneMapping(toneMappingForChoice(state.toneMappingChoice));
  target.setToneMappingExposure(state.toneMappingExposure);
  if (state.lightingMode === "default" || !state.hdriMapLabel) {
    target.useDefaultLighting();
  }
  target.setHdriMapVisible(state.hdriMapVisible);
  target.setHdriIntensity(state.hdriIntensity);
  target.setHdriRotation(state.currentStageSummary?.environment?.rotation ?? 0);
  target.setLightGizmosVisible(state.lightGizmosVisible);
}

export function replaceViewport(): void {
  state.viewport.dispose();
  state.viewport = new ThreeViewport(viewportElement);
  syncViewportState(state.viewport);
  state.viewport.start(onTick);
}

for (const button of app.querySelectorAll<HTMLButtonElement>("[data-navigation-mode]")) {
  button.addEventListener("click", () => {
    state.navigationMode = button.dataset.navigationMode as NavigationMode;
    applyNavigationOptions();
  });
}

for (const button of app.querySelectorAll<HTMLButtonElement>("[data-camera-speed]")) {
  button.addEventListener("click", () => {
    state.gameCameraSpeed = Number(button.dataset.cameraSpeed);
    applyNavigationOptions();
  });
}

viewportElement.addEventListener("camera-speed-change", (event) => {
  state.gameCameraSpeed = (event as CustomEvent<{ speed: number }>).detail.speed;
  for (const button of app.querySelectorAll<HTMLButtonElement>("[data-camera-speed]")) {
    button.classList.toggle("menu-option--checked", Number(button.dataset.cameraSpeed) === state.gameCameraSpeed);
  }
});

for (const button of app.querySelectorAll<HTMLButtonElement>("[data-up-axis]")) {
  button.addEventListener("click", () => {
    state.upAxisChoice = button.dataset.upAxis as UpAxisChoice;
    applyUpAxisOptions();
  });
}

for (const button of app.querySelectorAll<HTMLButtonElement>("[data-output-color-space]")) {
  button.addEventListener("click", () => {
    state.outputColorSpace = button.dataset.outputColorSpace === LinearSRGBColorSpace
      ? LinearSRGBColorSpace
      : SRGBColorSpace;
    applyColorSpaceOptions();
  });
}

app.querySelector("#menuMaterialXFlipV")?.addEventListener("click", () => {
  state.materialXFlipV = !state.materialXFlipV;
  void applyMaterialXOptions();
});

for (const button of app.querySelectorAll<HTMLButtonElement>("[data-purpose-policy]")) {
  button.addEventListener("click", () => {
    state.purposePolicy = button.dataset.purposePolicy as PurposeChoice;
    void applyPurposeOptions();
  });
}

for (const button of app.querySelectorAll<HTMLButtonElement>("[data-tone-mapping]")) {
  button.addEventListener("click", () => {
    state.toneMappingChoice = (button.dataset.toneMapping ?? "none") as ToneMappingChoice;
    applyToneMappingOptions();
  });
}

app.querySelector("#toneMappingExposureControl")?.addEventListener("click", (event) => {
  event.stopPropagation();
});

toneMappingExposureInput.addEventListener("input", () => {
  state.toneMappingExposure = Number(toneMappingExposureInput.value);
  applyToneMappingOptions();
});

app.querySelector("#menuLoadHdriMap")?.addEventListener("click", () => {
  hdriPicker.value = "";
  hdriPicker.click();
});

for (const button of app.querySelectorAll<HTMLButtonElement>("[data-lighting-mode]")) {
  button.addEventListener("click", () => {
    state.lightingMode = button.dataset.lightingMode as LightingMode;
    if (state.lightingMode === "default") {
      state.viewport.useDefaultLighting();
      state.hdriMapLabel = null;
    }
    applyLightingOptions();
    setStatus("Ready", false);
  });
}

app.querySelector("#menuHdriVisible")?.addEventListener("click", () => {
  state.hdriMapVisible = !state.hdriMapVisible;
  state.viewport.setHdriMapVisible(state.hdriMapVisible);
  applyLightingOptions();
});

app.querySelector("#menuLightGizmos")?.addEventListener("click", () => {
  state.lightGizmosVisible = !state.lightGizmosVisible;
  state.viewport.setLightGizmosVisible(state.lightGizmosVisible);
  applyLightingOptions();
});

app.querySelector("#hdriIntensityControl")?.addEventListener("click", (event) => {
  event.stopPropagation();
});

hdriIntensityInput.addEventListener("input", () => {
  state.hdriIntensity = Number(hdriIntensityInput.value);
  state.viewport.setHdriIntensity(state.hdriIntensity);
  applyLightingOptions();
});

export function applySplatViewOptions(): void {
  const fidelity = splatFidelityOptions[state.splatFidelityIndex];
  const detail = splatDetailOptions[state.splatDetailIndex];
  state.viewport.setSplatViewOptions({
    maxShDegree: fidelity.maxShDegree,
    scaleMultiplier: detail.scaleMultiplier,
  });

  for (const button of app.querySelectorAll<HTMLButtonElement>("[data-splat-fidelity]")) {
    button.classList.toggle("menu-option--checked", Number(button.dataset.splatFidelity) === state.splatFidelityIndex);
  }
  for (const button of app.querySelectorAll<HTMLButtonElement>("[data-splat-detail]")) {
    button.classList.toggle("menu-option--checked", Number(button.dataset.splatDetail) === state.splatDetailIndex);
  }
}

export function applyPayloadOpenOptions(): void {
  localStorage.setItem(
    loadAllPayloadsOnStageOpenStorageKey,
    String(state.loadAllPayloadsOnStageOpen)
  );
  for (const button of app.querySelectorAll<HTMLButtonElement>("[data-load-payloads-on-open]")) {
    button.classList.toggle(
      "menu-option--checked",
      button.dataset.loadPayloadsOnOpen === String(state.loadAllPayloadsOnStageOpen)
    );
  }
}

for (const button of app.querySelectorAll<HTMLButtonElement>("[data-splat-fidelity]")) {
  button.addEventListener("click", () => {
    state.splatFidelityIndex = Number(button.dataset.splatFidelity);
    applySplatViewOptions();
  });
}

for (const button of app.querySelectorAll<HTMLButtonElement>("[data-splat-detail]")) {
  button.addEventListener("click", () => {
    state.splatDetailIndex = Number(button.dataset.splatDetail);
    applySplatViewOptions();
  });
}

for (const button of app.querySelectorAll<HTMLButtonElement>("[data-load-payloads-on-open]")) {
  button.addEventListener("click", () => {
    state.loadAllPayloadsOnStageOpen = button.dataset.loadPayloadsOnOpen === "true";
    applyPayloadOpenOptions();
  });
}

applySplatViewOptions();
applyNavigationOptions();
applyUpAxisOptions();
applyColorSpaceOptions();
void applyMaterialXOptions();
void applyPurposeOptions();
applyToneMappingOptions();
applyLightingOptions();
applyPayloadOpenOptions();

app.querySelector("#menuLoadAllPayloads")?.addEventListener("click", () => {
  runtime.setAllPayloadsLoaded(true);
  void applyStageEdit(undefined, "loading payloads...");
});

app.querySelector("#menuUnloadAllPayloads")?.addEventListener("click", () => {
  runtime.setAllPayloadsLoaded(false);
  void applyStageEdit(undefined, "unloading payloads...");
});

statsClose.addEventListener("click", () => {
  statsPanel.hidden = true;
});

app.querySelector("#menuTutorial")?.addEventListener("click", () => {
  tutorialOverlay.hidden = false;
});

tutorialClose.addEventListener("click", () => {
  tutorialOverlay.hidden = true;
});

tutorialOverlay.addEventListener("click", (e) => {
  if (e.target === tutorialOverlay) tutorialOverlay.hidden = true;
});

// HDRi picker lives with the lighting options it drives.
hdriPicker.addEventListener("change", () => {
  const file = hdriPicker.files?.[0];
  if (!file) {
    return;
  }

  void (async () => {
    setStatus("loading HDRi map...", true);
    await waitForUiPaint();
    try {
      state.viewport.setHdriMapVisible(state.hdriMapVisible);
      state.viewport.setHdriIntensity(state.hdriIntensity);
      await state.viewport.loadHdriMap(file);
      state.lightingMode = "hdri";
      state.hdriMapLabel = file.name;
      applyLightingOptions();
      setStatus("Ready", false);
    } catch (error) {
      setStatus(`HDRi load failed: ${error instanceof Error ? error.message : String(error)}`, false);
      console.warn("Failed to load HDRi map", error);
    }
  })();
});
