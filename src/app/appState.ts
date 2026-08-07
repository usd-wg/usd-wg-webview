import { LinearSRGBColorSpace, SRGBColorSpace } from "three";
import { UsdWebViewRuntime } from "../usd/UsdWebViewRuntime";
import type { RenderPurposePolicy, StageSummary } from "../usd/types";
import type { SceneGraphPrim } from "../usd/types";
import { ThreeViewport, type NavigationMode, type ViewUpAxis } from "../viewer/ThreeViewport";
import { viewportElement } from "./dom";

export type UpAxisChoice = "stage" | ViewUpAxis;
export type LightingMode = "default" | "hdri";
export type OutputColorSpaceChoice = typeof SRGBColorSpace | typeof LinearSRGBColorSpace;
export type ToneMappingChoice =
  | "none"
  | "linear"
  | "reinhard"
  | "cineon"
  | "aces"
  | "agx"
  | "neutral"
  | "custom";
export type PurposeChoice = RenderPurposePolicy;

export type RendererStats = {
  meshes: number;
  vertices: number;
  triangles: number;
  materialBindings: number;
  materials: number;
  textures: number;
  gaussianSplats: number;
  splatPoints: number;
};

export const splatFidelityOptions = [
  { label: "Base Color", maxShDegree: 0 },
  { label: "Low SH", maxShDegree: 1 },
  { label: "High SH", maxShDegree: 2 },
  { label: "Full SH", maxShDegree: 3 },
] as const;

export const splatDetailOptions = [
  { label: "Crisp", scaleMultiplier: 0.8 },
  { label: "Normal", scaleMultiplier: 1 },
  { label: "Smooth", scaleMultiplier: 1.2 },
] as const;

export const loadAllPayloadsOnStageOpenStorageKey = "usdWebView.loadAllPayloadsOnStageOpen";
if (localStorage.getItem(loadAllPayloadsOnStageOpenStorageKey) === null) {
  localStorage.setItem(loadAllPayloadsOnStageOpenStorageKey, "true");
}

export const runtime = new UsdWebViewRuntime();

export const state = {
  viewport: new ThreeViewport(viewportElement),

  // View options
  splatFidelityIndex: splatFidelityOptions.length - 1,
  splatDetailIndex: 1,
  navigationMode: "orbital" as NavigationMode,
  upAxisChoice: "stage" as UpAxisChoice,
  outputColorSpace: SRGBColorSpace as OutputColorSpaceChoice,
  toneMappingChoice: "none" as ToneMappingChoice,
  toneMappingExposure: 1,
  lightingMode: "default" as LightingMode,
  lightGizmosVisible: true,
  materialXFlipV: true,
  purposePolicy: "defaultRender" as PurposeChoice,
  hdriMapVisible: true,
  hdriIntensity: 1,
  hdriMapLabel: null as string | null,
  gameCameraSpeed: 2,
  loadAllPayloadsOnStageOpen:
    localStorage.getItem(loadAllPayloadsOnStageOpenStorageKey) !== "false",

  // Stage state
  currentStageSummary: null as StageSummary | null,
  currentRendererStats: null as RendererStats | null,
  isLoadingStage: false,
  variantChangeSerial: 0,
  stageLoadSerial: 0,

  // Animation state
  animStart: 0,
  animEnd: 0,
  animFps: 24,
  animCurrent: 0,
  animPlaying: false,
  animLastTimestamp: 0,

  // Scene graph state
  allPrims: [] as SceneGraphPrim[],
  collapsedNodes: new Set<string>(),
  selectedPrimPath: null as string | null,
};
