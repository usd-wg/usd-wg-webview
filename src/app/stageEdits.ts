import { runtime, state } from "./appState";
import { attrList, attrPrimPath } from "./dom";
import { waitForUiPaint } from "./automation";
import { renderAttributes } from "./attributesPanel";
import { renderSceneGraph } from "./sceneGraphPanel";
import { setStatus } from "./statusBar";
import { assetLabel, collectRendererStats, renderStageSummary } from "./summaries";

// Uniform stage-edit refresh: every composition-changing edit (variant
// selection, payload load/unload) funnels through the unified stage driver.
// NotifyStageEdited recomposes the private driver stage (re-mirrors load
// rules, re-infers skel bindings, re-bakes), so geometry and materials
// arrive coherently in one full redraw — no per-edit-kind forking.
export async function applyStageEdit(
  _primPath?: string,
  loadingMessage = "applying stage edit..."
): Promise<void> {
  const serial = ++state.variantChangeSerial;

  setStatus(loadingMessage, true);
  await waitForUiPaint();

  const renderables = runtime.refreshAfterStageEdit(state.animCurrent);
  state.viewport.updateRenderables(renderables, true);
  state.viewport.renderGaussianSplats(runtime.extractGaussianSplats());
  await refreshStageEnvironment();
  state.viewport.setStageLights(runtime.extractStageLights(state.animCurrent));
  if (renderables.length > 0) {
    await state.viewport.updateRenderablesAsync(renderables);
  }

  if (serial !== state.variantChangeSerial) {
    return;
  }

  const newPrims = runtime.getSceneGraph();
  renderSceneGraph(newPrims);
  state.currentRendererStats = collectRendererStats(
    renderables,
    runtime.extractGaussianSplats()
  );
  renderStageSummary(state.currentStageSummary);
  if (state.selectedPrimPath) {
    if (newPrims.some((p) => p.path === state.selectedPrimPath)) {
      state.viewport.setSelectedPrim(state.selectedPrimPath);
      renderAttributes(state.selectedPrimPath, runtime.getPrimAttributes(state.selectedPrimPath));
    } else {
      state.selectedPrimPath = null;
      attrList.innerHTML = '<p class="sg-empty">Select a prim to inspect</p>';
      attrPrimPath.textContent = "";
    }
  }
  setStatus(
    state.currentStageSummary?.environment?.warning
      ? "Ready - DomeLight display-compensated"
      : "Ready",
    false
  );
}

export async function applyLightAttributeEdit(refreshAttributes = true): Promise<void> {
  await refreshStageEnvironment();
  state.viewport.setStageLights(runtime.extractStageLights(state.animCurrent));
  if (refreshAttributes && state.selectedPrimPath) {
    renderAttributes(state.selectedPrimPath, runtime.getPrimAttributes(state.selectedPrimPath));
  }
  setStatus(
    state.currentStageSummary?.environment?.warning
      ? "Ready - DomeLight display-compensated"
      : "Ready",
    false
  );
}

async function refreshStageEnvironment(): Promise<void> {
  const environment = runtime.extractStageEnvironment();
  if (!environment) {
    state.lightingMode = "default";
    state.hdriMapLabel = null;
    if (state.currentStageSummary) {
      delete state.currentStageSummary.environment;
    }
    state.viewport.useDefaultLighting();
    state.viewport.setHdriRotation(0);
    return;
  }

  state.hdriIntensity = environment.intensity ?? 1;
  state.hdriMapLabel = assetLabel(environment.texture.path);
  state.lightingMode = "hdri";
  if (environment.warning) {
    console.warn("[USD WebView] Stage environment lighting was display-compensated", environment);
  }
  if (state.currentStageSummary) {
    state.currentStageSummary.environment = environment;
  }
  try {
    await state.viewport.loadHdriAsset(environment.texture, state.hdriMapLabel);
    state.viewport.setHdriIntensity(state.hdriIntensity);
    state.viewport.setHdriRotation(environment.rotation ?? 0);
    state.viewport.setHdriMapVisible(state.hdriMapVisible);
  } catch (error) {
    state.lightingMode = "default";
    state.hdriMapLabel = null;
    state.viewport.useDefaultLighting();
    state.viewport.setHdriRotation(0);
    console.warn("Failed to refresh stage dome-light environment", {
      sourcePath: environment.sourcePath,
      texturePath: environment.texture.path,
      error,
    });
  }
}
