export type RuntimeState =
  | "idle"
  | "loading"
  | "ready"
  | "unavailable"
  | "error";

export type RuntimeStatus = {
  state: RuntimeState;
  source: string;
  detail: string;
};

export type StageSummary = {
  rootFile: string;
  rootLayerIdentifier?: string;
  primCount?: number;
  layerCount?: number;
  meshPrimCount?: number;
  authoredPointCount?: number;
  authoredFaceCount?: number;
  materialPrimCount?: number;
  materialBindingCount?: number;
  textureAssetCount?: number;
  payloadPrimCount?: number;
  variantSetCount?: number;
  instancePrimCount?: number;
  timeCodesPerSecond?: number;
  startTimeCode?: number;
  endTimeCode?: number;
  upAxis?: string;
  environment?: StageEnvironment;
  error?: string;
};

export type StageEnvironment = {
  sourcePath?: string;
  intensity?: number;
  authoredIntensity?: number;
  authoredExposure?: number;
  viewportCompensation?: number;
  warning?: string;
  texture: RenderableTexture;
};

export type RenderableMesh = {
  path: string;
  name: string;
  points: ArrayLike<number>;
  indices: ArrayLike<number>;
  uvs?: ArrayLike<number>;
  // Corner-stream normals supplied by the unified stage driver; when present
  // (and matching the expanded position count) they are used directly instead
  // of the position-welded recompute.
  normals?: Float32Array;
  matrix: number[];
  instanceMatrices?: number[][];
  instanceOwnerPath?: string;
  color?: number[];
  material?: RenderableMaterial;
  materialSubsets?: RenderableMaterialSubset[];
};

export type RenderableMaterialSubset = {
  path: string;
  name: string;
  start: number;
  count: number;
  material?: RenderableMaterial;
};

export type RenderableMaterial = {
  path?: string;
  shaderId?: string;
  // Scalars
  diffuseColor?: number[];
  roughness?: number;
  metallic?: number;
  opacity?: number;
  emissiveColor?: number[];
  clearcoat?: number;
  clearcoatRoughness?: number;
  ior?: number;
  // Textures
  diffuseTexture?: RenderableTexture;
  roughnessTexture?: RenderableTexture;
  metallicTexture?: RenderableTexture;
  normalTexture?: RenderableTexture;
  occlusionTexture?: RenderableTexture;
  emissiveTexture?: RenderableTexture;
  clearcoatTexture?: RenderableTexture;
  clearcoatRoughnessTexture?: RenderableTexture;
  opacityTexture?: RenderableTexture;
  materialX?: RenderableMaterialX;
};

export type RenderableTexture = {
  path: string;
  mimeType: string;
  data: Uint8Array;
};

export type RenderableMaterialX = RenderableTexture & {
  materialName?: string;
  resources?: RenderableTexture[];
  report?: unknown;
};

export type StageLoadRequest = {
  files: File[];
  rootFile?: File;
  loadAllPayloads?: boolean;
  purposePolicy?: RenderPurposePolicy;
};

export type RenderPurposePolicy =
  | "defaultRender"
  | "render"
  | "proxy"
  | "all";

export type RenderableGaussianSplat = {
  path: string;
  name: string;
  count: number;
  matrix: number[];
  positions: Float32Array;
  scales: Float32Array;
  orientations: Float32Array;
  opacities: Float32Array;
  shCoeffs?: Float32Array;
  shDegree?: number;
};

export type StageLoadResult = {
  summary: StageSummary | null;
  renderables?: RenderableMesh[];
  gaussianSplats?: RenderableGaussianSplat[];
  diagnostics?: StageLoadDiagnostics;
};

// --- Unified stage driver contract (v2) ---

export type StageDriverCapabilities = {
  hasSkelContent: boolean;
  skelBindingsInferred: boolean;
  hasTimeVaryingPoints: boolean;
  hasTimeVaryingXforms: boolean;
  hasAnimationRange: boolean;
  hasPointInstancers: boolean;
  hasMaterialX: boolean;
  hasGaussianSplats: boolean;
};

export type StageLoadDiagnostics = {
  capabilities?: StageDriverCapabilities;
  inferredBindingCount?: number;
  bakeTimeMs?: number;
  rootLayerClean?: boolean;
};

export type MeshUpdateSubset = {
  path: string;
  name: string;
  start: number;
  count: number;
  materialPath?: string;
};

// One mesh from StageDriverDraw. Corner-expanded entries carry
// positions/normals/uvs in the same vertex stream (no index handshake);
// point-instancer entries reuse the legacy points+indices shape.
export type MeshUpdate = {
  path: string;
  name: string;
  positions?: Float32Array;
  normals?: Float32Array;
  uvs?: Float32Array;
  points?: number[];
  indices?: number[];
  matrix: number[];
  instanceMatrices?: number[][];
  instanceOwnerPath?: string;
  displayColor?: number[];
  color?: number[];
  material?: RenderableMaterial;
  materialSubsets?: RenderableMaterialSubset[];
  materialPath?: string;
  subsets?: MeshUpdateSubset[];
};

export type DrawResult = {
  meshes: MeshUpdate[];
};

export type MaterialPayloadEntry = {
  path: string;
  material: RenderableMaterial;
};

export type PrimTransform = {
  path: string;
  matrix: number[];
};

export type SceneGraphPrim = {
  path: string;
  name: string;
  typeName: string;
  depth: number;
  isActive: boolean;
  hasChildren: boolean;
  hasVariantSets?: boolean;
  hasPayloads?: boolean;
  isPayloadLoaded?: boolean;
};

export type PrimAttribute = {
  name: string;
  typeName: string;
  isAuthored: boolean;
  value?: string;
  valueIsArray?: boolean;
  valueElementCount?: number;
  editable?: boolean;
  variantOptions?: string[]; // defined when typeName === "variantSet"
};

export type UsdWebViewBindings = {
  ready?: Promise<unknown>;
  createDataFile?: (path: string, data: Uint8Array) => void;
  closeStage?: (path: string) => void;
  extractTransformsAtTime?: (path: string, timeCode: number) => PrimTransform[];
  openStage?: (path: string, loadAllPayloads?: boolean) => Promise<StageSummary> | StageSummary;
  inspectPrimRelationships?: (stagePath: string, primPath: string) => unknown;
  getSkelDebugInfo?: (stagePath: string, primPath: string, timeA?: number, timeB?: number) => unknown;
  getLastSkelBindingOverlayContents?: (stagePath: string) => string;
  getSceneGraph?: (stagePath: string) => SceneGraphPrim[];
  getPrimAttributes?: (stagePath: string, primPath: string) => PrimAttribute[];
  setPrimAttribute?: (stagePath: string, primPath: string, attrName: string, value: string) => boolean;
  setVariantSelection?: (stagePath: string, primPath: string, variantSetName: string, selection: string) => boolean;
  setPayloadLoaded?: (stagePath: string, primPath: string, loaded: boolean) => boolean;
  setAllPayloadsLoaded?: (stagePath: string, loaded: boolean) => void;
  extractGaussianSplats?: (stagePath: string) => RenderableGaussianSplat[];
  extractStageEnvironment?: (stagePath: string) => StageEnvironment | undefined;
  // Unified stage driver (contract v2)
  createStageDriver?: (stagePath: string) => boolean;
  deleteStageDriver?: (stagePath: string) => void;
  stageDriverSetTime?: (stagePath: string, timeCode: number) => void;
  stageDriverDraw?: (stagePath: string, full: boolean, purposePolicy: RenderPurposePolicy) => DrawResult | undefined;
  stageDriverDrawSubtree?: (stagePath: string, primPath: string, purposePolicy: RenderPurposePolicy) => DrawResult | undefined;
  stageDriverGetTiming?: (stagePath: string) => { start?: number; end?: number; fps?: number };
  stageDriverGetCapabilities?: (stagePath: string) => StageDriverCapabilities | undefined;
  stageDriverGetDiagnostics?: (stagePath: string) => StageLoadDiagnostics | undefined;
  stageDriverNotifyStageEdited?: (stagePath: string) => void;
  extractMaterialPayloads?: (stagePath: string) => MaterialPayloadEntry[];
};

export type UsdWebViewFactory = (options: {
  locateFile: (path: string) => string;
}) => Promise<UsdWebViewBindings> | UsdWebViewBindings;

declare global {
  interface Window {
    UsdWebViewBindings?: {
      createRuntime: UsdWebViewFactory;
    };
  }
}
