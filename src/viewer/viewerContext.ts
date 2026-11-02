// Shared state for the viewport's single initialized renderer and controls.
import type { Group, OrthographicCamera, PerspectiveCamera, Scene } from "three";
import type { WebGPURenderer } from "three/webgpu";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export interface ViewportContext {
  readonly host: HTMLElement;
  readonly camera: PerspectiveCamera;
  activeCamera: PerspectiveCamera | OrthographicCamera;
  readonly scene: Scene;
  readonly stageRoot: Group;
  renderer: WebGPURenderer;
  controls: OrbitControls;
}
