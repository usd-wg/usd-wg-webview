// Default light rig, room environment, and HDRI environment handling.

import {
  AmbientLight,
  Box3,
  BufferGeometry,
  type Camera,
  Color,
  type ColorSpace,
  DirectionalLight,
  DirectionalLightHelper,
  EquirectangularReflectionMapping,
  Float32BufferAttribute,
  Group,
  HemisphereLight,
  LinearSRGBColorSpace,
  Line,
  LineBasicMaterial,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PMREMGenerator as WebGLPMREMGenerator,
  PointLight,
  PointLightHelper,
  Raycaster,
  RectAreaLight,
  type RenderTarget,
  type Scene,
  SphereGeometry,
  SpotLight,
  SpotLightHelper,
  SRGBColorSpace,
  Texture,
  TextureLoader,
  Vector3,
  Vector2,
  type WebGLRenderer,
} from "three";
import { PMREMGenerator as WebGPUPMREMGenerator, type WebGPURenderer } from "three/webgpu";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { EXRLoader } from "three/examples/jsm/loaders/EXRLoader.js";
import { HDRLoader } from "three/examples/jsm/loaders/HDRLoader.js";
import { RectAreaLightUniformsLib } from "three/examples/jsm/lights/RectAreaLightUniformsLib.js";
import type { RenderableLight, RenderableTexture } from "../usd/types";

RectAreaLightUniformsLib.init();

const LOCAL_FORWARD = new Vector3(0, 0, -1);

export class LightingRig {
  private readonly exrLoader = new EXRLoader();
  private readonly hdrLoader = new HDRLoader();
  private readonly textureLoader = new TextureLoader();
  private readonly raycaster = new Raycaster();
  private readonly ambientLight: AmbientLight;
  private readonly hemisphereLight: HemisphereLight;
  private readonly stageLightGroup = new Group();
  private readonly helperGroup = new Group();
  private readonly pickTargets: Object3D[] = [];
  private readonly warnedUnsupportedLights = new Set<string>();
  private defaultEnvironmentTarget: RenderTarget;
  private readonly defaultAmbientIntensity = 0.22;
  private readonly defaultHemisphereIntensity = 1.25;
  private readonly defaultEnvironmentIntensity = 0.7;
  private hdriTexture: Texture | null = null;
  private hdriMapVisible = true;
  private hdriIntensity = 1;
  private hdriRotation = 0;
  private stageDirectLightCount = 0;
  private lightGizmosVisible = true;
  private selectedLightPath: string | null = null;
  private currentStageLights: RenderableLight[] = [];
  private usingWebGpuRenderer = false;

  constructor(
    private readonly scene: Scene,
    private readonly defaultBackground: Color,
    renderer: WebGLRenderer
  ) {
    this.usingWebGpuRenderer = isWebGpuRenderer(renderer);
    this.defaultEnvironmentTarget = createRoomEnvironmentTarget(renderer);

    this.ambientLight = new AmbientLight(0xffffff, this.defaultAmbientIntensity);
    this.scene.add(this.ambientLight);

    this.hemisphereLight = new HemisphereLight(0xfff7ec, 0x6b737c, this.defaultHemisphereIntensity);
    this.scene.add(this.hemisphereLight);

    this.stageLightGroup.name = "USD Stage Lights";
    this.scene.add(this.stageLightGroup);
    this.helperGroup.name = "USD Light Gizmos";
    this.scene.add(this.helperGroup);

    this.applyDefaultEnvironment();
  }

  dispose(): void {
    this.disposeHdriTexture();
    this.clearStageLights();
    this.defaultEnvironmentTarget.dispose();
  }

  async loadHdriMap(file: File): Promise<void> {
    const url = URL.createObjectURL(file);
    try {
      const environmentTexture = await this.loadHdriTexture(file.name, url, file.type);
      this.applyHdriTexture(environmentTexture.texture, file.name, environmentTexture.colorSpace);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async loadHdriAsset(asset: RenderableTexture, label?: string): Promise<void> {
    const bytes = new Uint8Array(asset.data.byteLength);
    bytes.set(asset.data);
    const url = URL.createObjectURL(
      new Blob([bytes.buffer], { type: asset.mimeType || "application/octet-stream" })
    );
    try {
      const environmentTexture = await this.loadHdriTexture(asset.path, url, asset.mimeType);
      this.applyHdriTexture(
        environmentTexture.texture,
        label ?? asset.path,
        environmentTexture.colorSpace
      );
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  useDefaultLighting(): void {
    this.disposeHdriTexture();
    this.scene.background = this.defaultBackground;
    this.applyDefaultEnvironment();
    this.updateDefaultLightRig();
  }

  setHdriMapVisible(visible: boolean): void {
    this.hdriMapVisible = visible;
    if (!this.hdriTexture) {
      return;
    }
    this.scene.background = visible ? this.hdriTexture : this.defaultBackground;
  }

  setHdriIntensity(intensity: number): void {
    this.hdriIntensity = Math.min(5, Math.max(0, intensity));
    if (this.hdriTexture) {
      this.applyHdriIntensity();
    }
  }

  setHdriRotation(degrees: number): void {
    this.hdriRotation = Number.isFinite(degrees) ? degrees : 0;
    this.applyHdriRotation();
  }

  hasHdriMap(): boolean {
    return this.hdriTexture !== null;
  }

  useRenderer(renderer: WebGLRenderer | WebGPURenderer): void {
    const wasWebGpu = this.usingWebGpuRenderer;
    this.usingWebGpuRenderer = isWebGpuRenderer(renderer);
    const previousTarget = this.defaultEnvironmentTarget;
    this.defaultEnvironmentTarget = createRoomEnvironmentTarget(renderer);
    previousTarget.dispose();

    if (!this.hdriTexture) {
      this.applyDefaultEnvironment();
    }
    if (wasWebGpu !== this.usingWebGpuRenderer && this.currentStageLights.length > 0) {
      this.setStageLights(this.currentStageLights);
    }
  }

  setViewUpAxis(axis: "y" | "z"): void {
    this.stageLightGroup.rotation.set(axis === "z" ? -Math.PI / 2 : 0, 0, 0);
    this.helperGroup.rotation.set(0, 0, 0);
    this.refreshLightGizmos();
  }

  setLightGizmosVisible(visible: boolean): void {
    this.lightGizmosVisible = visible;
    this.helperGroup.visible = visible;
  }

  pickLight(clientX: number, clientY: number, host: HTMLElement, camera: Camera): string | null {
    if (!this.lightGizmosVisible || !this.pickTargets.length) {
      return null;
    }
    const rect = host.getBoundingClientRect();
    const ndc = new Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(ndc, camera);
    this.raycaster.params.Line = {
      threshold: Math.max(0.05, camera.position.length() * 0.005),
    };
    const hits = this.raycaster.intersectObjects(this.pickTargets, true);
    for (const hit of hits) {
      const path = lightPathForObject(hit.object);
      if (path) {
        return path;
      }
    }
    return null;
  }

  setSelectedLight(path: string | null): void {
    this.selectedLightPath = path;
    for (const helper of this.helperGroup.children) {
      const selected = !!path && helper.userData.usdLightPath === path;
      setHelperColor(helper, selected ? 0xffb347 : undefined);
    }
  }

  getLightBox(path: string): Box3 | null {
    for (const target of this.pickTargets) {
      if (target.userData.usdLightPath !== path) {
        continue;
      }
      target.updateWorldMatrix(true, false);
      const position = new Vector3().setFromMatrixPosition(target.matrixWorld);
      return new Box3(
        position.clone().addScalar(-0.35),
        position.clone().addScalar(0.35)
      );
    }
    return null;
  }

  setStageLights(lights: RenderableLight[]): void {
    this.currentStageLights = [...lights];
    this.clearStageLightObjects();

    for (const light of lights) {
      if (!light.supported) {
        this.warnUnsupportedLight(light);
        continue;
      }

      const object = this.createStageLight(light);
      if (!object) {
        this.warnUnsupportedLight({
          ...light,
          warning: `No Three.js mapping was created for ${light.typeName}.`,
        });
        continue;
      }

      object.name = light.name || light.path;
      object.userData.usdLightPath = light.path;
      object.userData.usdLightTypeName = light.typeName;
      this.stageLightGroup.add(object);
      this.addLightHelper(light, object);
      this.stageDirectLightCount += 1;
    }

    this.updateDefaultLightRig();
    this.setSelectedLight(this.selectedLightPath);
  }

  clearStageLights(): void {
    this.currentStageLights = [];
    this.clearStageLightObjects();
  }

  private clearStageLightObjects(): void {
    this.stageLightGroup.clear();
    for (const helper of this.helperGroup.children) {
      disposeHelper(helper);
    }
    this.helperGroup.clear();
    this.pickTargets.length = 0;
    this.stageDirectLightCount = 0;
    this.updateDefaultLightRig();
  }

  private async loadHdriTexture(
    name: string,
    url: string,
    mimeType = ""
  ): Promise<{ texture: Texture; colorSpace: ColorSpace }> {
    if (isExrTexture(name, mimeType)) {
      return { texture: await this.exrLoader.loadAsync(url), colorSpace: LinearSRGBColorSpace };
    }
    if (isHdrTexture(name, mimeType)) {
      return { texture: await this.hdrLoader.loadAsync(url), colorSpace: LinearSRGBColorSpace };
    }
    return { texture: await this.textureLoader.loadAsync(url), colorSpace: SRGBColorSpace };
  }

  private applyHdriTexture(
    texture: Texture,
    name: string,
    colorSpace: ColorSpace
  ): void {
    texture.name = name;
    texture.mapping = EquirectangularReflectionMapping;
    texture.colorSpace = colorSpace;
    texture.needsUpdate = true;

    this.disposeHdriTexture();
    this.hdriTexture = texture;
    this.scene.environment = texture;
    this.scene.background = this.hdriMapVisible ? texture : this.defaultBackground;
    this.applyHdriIntensity();
    this.applyHdriRotation();
    this.updateDefaultLightRig();
  }

  private setDefaultLightRigEnabled(enabled: boolean): void {
    this.ambientLight.intensity = enabled ? this.defaultAmbientIntensity : 0;
    this.hemisphereLight.intensity = enabled ? this.defaultHemisphereIntensity : 0;
  }

  private updateDefaultLightRig(): void {
    this.setDefaultLightRigEnabled(!this.hdriTexture && this.stageDirectLightCount === 0);
  }

  private applyDefaultEnvironment(): void {
    this.scene.environment = this.defaultEnvironmentTarget.texture;
    this.scene.environmentIntensity = this.defaultEnvironmentIntensity;
    this.scene.backgroundIntensity = 1;
    this.scene.environmentRotation.set(0, 0, 0);
    this.scene.backgroundRotation.set(0, 0, 0);
  }

  private applyHdriIntensity(): void {
    this.scene.environmentIntensity = this.hdriIntensity;
    this.scene.backgroundIntensity = this.hdriIntensity;
  }

  private applyHdriRotation(): void {
    const radians = this.hdriRotation * Math.PI / 180;
    this.scene.environmentRotation.set(0, radians, 0);
    this.scene.backgroundRotation.set(0, radians, 0);
  }

  private disposeHdriTexture(): void {
    if (!this.hdriTexture) {
      return;
    }
    if (this.scene.environment === this.hdriTexture) {
      this.scene.environment = null;
    }
    if (this.scene.background === this.hdriTexture) {
      this.scene.background = this.defaultBackground;
    }
    this.hdriTexture.dispose();
    this.hdriTexture = null;
    this.updateDefaultLightRig();
  }

  private createStageLight(light: RenderableLight): Object3D | null {
    const matrix = matrixFromUsd(light.matrix);
    const color = stageLightColor(light);
    const intensity = stageLightIntensity(light);
    const position = new Vector3();
    const scale = new Vector3();
    const quaternion = new Object3D().quaternion;
    matrix.decompose(position, quaternion, scale);

    if (light.kind === "distant") {
      const directional = new DirectionalLight(color, intensity);
      directional.position.copy(position);
      directional.quaternion.copy(quaternion);
      const target = makeLightTarget();
      directional.target = target;
      directional.add(target);
      return directional;
    }

    if (light.kind === "sphere") {
      if ((light.coneAngle ?? 0) > 0) {
        return this.createSpotLight(light, color, intensity, position, quaternion);
      }
      const point = new PointLight(color, intensity, 0, 2);
      point.position.copy(position);
      return point;
    }

    if (light.kind === "rect") {
      if (this.usingWebGpuRenderer) {
        return this.createAreaApproximationLight(light, color, intensity, position, quaternion);
      }
      const rect = new RectAreaLight(color, intensity, light.width ?? 1, light.height ?? 1);
      rect.matrix.copy(matrix);
      rect.matrixAutoUpdate = false;
      return rect;
    }

    if (light.kind === "disk") {
      if ((light.coneAngle ?? 0) > 0) {
        return this.createSpotLight(light, color, intensity, position, quaternion);
      }
      if (this.usingWebGpuRenderer) {
        return this.createAreaApproximationLight(light, color, intensity, position, quaternion);
      }
      const side = (light.radius ?? 0.5) * 2;
      const rect = new RectAreaLight(color, intensity, side, side);
      rect.matrix.copy(matrix);
      rect.matrixAutoUpdate = false;
      rect.userData.usdApproximation = "UsdLuxDiskLight rendered as square RectAreaLight";
      return rect;
    }

    return null;
  }

  private createAreaApproximationLight(
    light: RenderableLight,
    color: Color,
    intensity: number,
    position: Vector3,
    quaternion: Object3D["quaternion"]
  ): SpotLight {
    const spot = this.createSpotLight(
      { ...light, coneAngle: light.coneAngle ?? 80, coneSoftness: light.coneSoftness ?? 0.55 },
      color,
      intensity,
      position,
      quaternion
    );
    spot.userData.usdApproximation = `${light.typeName} rendered as SpotLight for WebGPU compatibility`;
    return spot;
  }

  private createSpotLight(
    light: RenderableLight,
    color: Color,
    intensity: number,
    position: Vector3,
    quaternion: Object3D["quaternion"]
  ): SpotLight {
    const angleDegrees = Math.min(Math.max(light.coneAngle ?? 45, 0.1), 90);
    const spot = new SpotLight(
      color,
      intensity,
      0,
      angleDegrees * Math.PI / 180,
      Math.min(Math.max(light.coneSoftness ?? 0, 0), 1),
      2
    );
    spot.position.copy(position);
    spot.quaternion.copy(quaternion);
    const target = makeLightTarget();
    spot.target = target;
    spot.add(target);
    return spot;
  }

  private warnUnsupportedLight(light: RenderableLight): void {
    const key = `${light.path}:${light.warning ?? light.typeName}`;
    if (this.warnedUnsupportedLights.has(key)) {
      return;
    }
    this.warnedUnsupportedLights.add(key);
    console.warn("[USD WebView] USDLux light not rendered", {
      path: light.path,
      typeName: light.typeName,
      warning: light.warning ?? "Unsupported USDLux light type.",
    });
  }

  private refreshLightGizmos(): void {
    for (const helper of this.helperGroup.children) {
      const source = helper.userData.usdLightObject;
      if (!(source instanceof Object3D)) {
        continue;
      }
      if (helper.userData.usdLightWorldMatrix) {
        copyWorldMatrix(helper, source);
        continue;
      }
      const update = (helper as { update?: () => void }).update;
      update?.call(helper);
    }
  }

  private addLightHelper(light: RenderableLight, object: Object3D): void {
    const helper = createLightHelper(light, object);
    if (helper) {
      tagLightHelper(helper, light, object);
      helper.visible = this.lightGizmosVisible;
      this.helperGroup.add(helper);
      this.pickTargets.push(helper);
    }

    const pickTarget = createLightPickTarget(light, object);
    tagLightHelper(pickTarget, light, object);
    pickTarget.userData.usdLightWorldMatrix = true;
    this.helperGroup.add(pickTarget);
    this.pickTargets.push(pickTarget);
  }
}

function createRoomEnvironmentTarget(renderer: WebGLRenderer | WebGPURenderer): RenderTarget {
  const pmremGenerator = isWebGpuRenderer(renderer)
    ? new WebGPUPMREMGenerator(renderer)
    : new WebGLPMREMGenerator(renderer);
  const roomEnvironment = new RoomEnvironment();
  const target = pmremGenerator.fromScene(roomEnvironment);
  pmremGenerator.dispose();
  return target;
}

function isWebGpuRenderer(renderer: WebGLRenderer | WebGPURenderer): renderer is WebGPURenderer {
  return (renderer as WebGPURenderer).isWebGPURenderer === true;
}

function matrixFromUsd(values: number[]): Matrix4 {
  const matrix = new Matrix4();
  if (values.length === 16) {
    matrix.set(...(values as Parameters<typeof matrix.set>));
    matrix.transpose();
  }
  return matrix;
}

function makeLightTarget(): Object3D {
  const target = new Object3D();
  target.position.copy(LOCAL_FORWARD);
  return target;
}

function stageLightIntensity(light: RenderableLight): number {
  const lobeScale = Math.max(light.diffuse ?? 1, light.specular ?? 1, 0);
  return (light.effectiveIntensity ?? light.intensity ?? 1) * lobeScale * stageLightAreaScale(light);
}

function stageLightAreaScale(light: RenderableLight): number {
  if (light.normalize) {
    return 1;
  }
  if (light.kind === "sphere" || light.kind === "disk") {
    const radius = Math.max(light.radius ?? 0.5, 0);
    return Math.max((radius / 0.5) ** 2, 0.001);
  }
  if (light.kind === "rect") {
    const width = Math.max(light.width ?? 1, 0);
    const height = Math.max(light.height ?? 1, 0);
    return Math.max(width * height, 0.001);
  }
  return 1;
}

function stageLightColor(light: RenderableLight): Color {
  const [r = 1, g = 1, b = 1] = light.color ?? [];
  const color = new Color(r, g, b);
  if (light.enableColorTemperature) {
    color.multiply(colorTemperature(light.colorTemperature ?? 6500));
  }
  return color;
}

function colorTemperature(kelvin: number): Color {
  const temp = kelvin / 100;
  let r: number;
  let g: number;
  let b: number;

  if (temp <= 66) {
    r = 1;
    g = 0.3900815787690196 * Math.log(temp) - 0.6318414437886275;
  } else {
    r = 1.292936186062745 * Math.pow(temp - 60, -0.1332047592);
    g = 1.129890860895294 * Math.pow(temp - 60, -0.0755148492);
  }

  if (temp >= 66) {
    b = 1;
  } else if (temp <= 19) {
    b = 0;
  } else {
    b = 0.5432067891101961 * Math.log(temp - 10) - 1.19625408914;
  }

  return new Color(clamp01(r), clamp01(g), clamp01(b));
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

function createLightHelper(light: RenderableLight, object: Object3D): Object3D | null {
  if (light.kind === "rect") {
    const helper = createRectHelper(light.width ?? 1, light.height ?? 1);
    copyWorldMatrix(helper, object);
    helper.matrixAutoUpdate = false;
    helper.userData.usdLightWorldMatrix = true;
    return helper;
  }
  if (light.kind === "disk" && (light.coneAngle ?? 0) <= 0) {
    const helper = createDiskHelper(light.radius ?? 0.5);
    copyWorldMatrix(helper, object);
    helper.matrixAutoUpdate = false;
    helper.userData.usdLightWorldMatrix = true;
    return helper;
  }
  if (object instanceof DirectionalLight) {
    const helper = new DirectionalLightHelper(object, 0.6);
    helper.update();
    return helper;
  }
  if (object instanceof PointLight) {
    const helper = new PointLightHelper(object, Math.max(light.radius ?? 0.25, 0.25));
    helper.update();
    return helper;
  }
  if (object instanceof SpotLight) {
    const helper = new SpotLightHelper(object);
    helper.update();
    return helper;
  }
  if (object instanceof RectAreaLight) {
    const helper = createRectHelper(object.width, object.height);
    copyWorldMatrix(helper, object);
    helper.matrixAutoUpdate = false;
    helper.userData.usdLightWorldMatrix = true;
    return helper;
  }
  return null;
}

function createRectHelper(width: number, height: number): Line {
  const halfWidth = width * 0.5;
  const halfHeight = height * 0.5;
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute([
    -halfWidth, halfHeight, 0,
    halfWidth, halfHeight, 0,
    halfWidth, -halfHeight, 0,
    -halfWidth, -halfHeight, 0,
    -halfWidth, halfHeight, 0,
  ], 3));
  return new Line(
    geometry,
    new LineBasicMaterial({ color: 0x89d8ff, fog: false, toneMapped: false })
  );
}

function createDiskHelper(radius: number): Line {
  const positions: number[] = [];
  const segments = 48;
  for (let index = 0; index <= segments; index += 1) {
    const theta = (index / segments) * Math.PI * 2;
    positions.push(Math.cos(theta) * radius, Math.sin(theta) * radius, 0);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  return new Line(
    geometry,
    new LineBasicMaterial({ color: 0x89d8ff, fog: false, toneMapped: false })
  );
}

function createLightPickTarget(light: RenderableLight, object: Object3D): Mesh {
  const radius = Math.max(light.radius ?? 0.25, light.width ?? 0, light.height ?? 0, 0.35) * 0.5;
  const target = new Mesh(
    new SphereGeometry(radius, 8, 4),
    new MeshBasicMaterial({
      color: 0xffb347,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      toneMapped: false,
    })
  );
  copyWorldMatrix(target, object);
  target.matrixAutoUpdate = false;
  return target;
}

function copyWorldMatrix(target: Object3D, source: Object3D): void {
  source.updateWorldMatrix(true, false);
  target.matrix.copy(source.matrixWorld);
}

function tagLightHelper(helper: Object3D, light: RenderableLight, object: Object3D): void {
  helper.traverse((child) => {
    child.userData.usdLightPath = light.path;
    child.userData.usdLightTypeName = light.typeName;
    child.userData.usdLightObject = object;
  });
}

function lightPathForObject(object: Object3D): string | null {
  let current: Object3D | null = object;
  while (current) {
    const path = current.userData.usdLightPath;
    if (typeof path === "string") {
      return path;
    }
    current = current.parent;
  }
  return null;
}

function setHelperColor(helper: Object3D, color: number | undefined): void {
  helper.traverse((object) => {
    const materials = materialsForObject(object);
    for (const material of materials) {
      const anyMaterial = material as unknown as { color?: Color; userData: Record<string, unknown> };
      if (!anyMaterial.color) {
        continue;
      }
      if (!anyMaterial.userData.usdLightHelperColor) {
        anyMaterial.userData.usdLightHelperColor = anyMaterial.color.clone();
      }
      if (color === undefined) {
        anyMaterial.color.copy(anyMaterial.userData.usdLightHelperColor as Color);
      } else {
        anyMaterial.color.set(color);
      }
    }
  });
}

function disposeHelper(helper: Object3D): void {
  const geometries = new Set<{ dispose: () => void }>();
  const materials = new Set<{ dispose: () => void }>();
  helper.traverse((object) => {
    const withGeometry = object as { geometry?: { dispose: () => void } };
    if (withGeometry.geometry) {
      geometries.add(withGeometry.geometry);
    }
    for (const material of materialsForObject(object)) {
      materials.add(material);
    }
  });
  for (const geometry of geometries) {
    geometry.dispose();
  }
  for (const material of materials) {
    material.dispose();
  }
}

function materialsForObject(object: Object3D): Array<{ dispose: () => void }> {
  const material = (object as { material?: unknown }).material;
  if (Array.isArray(material)) {
    return material as Array<{ dispose: () => void }>;
  }
  if (material && typeof (material as { dispose?: unknown }).dispose === "function") {
    return [material as { dispose: () => void }];
  }
  return [];
}

function isExrTexture(name: string, mimeType: string): boolean {
  const lowerName = name.toLowerCase();
  const lowerMime = mimeType.toLowerCase();
  return lowerName.endsWith(".exr") || lowerMime === "image/x-exr";
}

function isHdrTexture(name: string, mimeType: string): boolean {
  const lowerName = name.toLowerCase();
  const lowerMime = mimeType.toLowerCase();
  return lowerName.endsWith(".hdr") ||
    lowerMime === "image/vnd.radiance" ||
    lowerMime === "image/x-hdr";
}
