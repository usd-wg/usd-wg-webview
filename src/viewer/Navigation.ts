// Camera navigation: orbital/game mode switching, WASD+mouse game
// navigation, and the eased camera framing animation.

import { Box3, Vector3 } from "three";
import type { ViewportContext } from "./viewerContext";

export type NavigationMode = "orbital" | "game";
export type CameraPose = {
  fov?: number;
  near?: number;
  far?: number;
  position: [number, number, number];
  target: [number, number, number];
};

interface FrameAnim {
  startPos: Vector3;
  startTarget: Vector3;
  endPos: Vector3;
  endTarget: Vector3;
  t: number; // 0 → 1
}

export class NavigationController {
  private navigationMode: NavigationMode = "orbital";
  private gameCameraSpeed = 2;
  private gamePointerActive = false;
  private lastFrameTime = performance.now();
  private frameAnim: FrameAnim | null = null;
  private readonly gameKeys = new Set<string>();
  private readonly gameForward = new Vector3();
  private readonly gameRight = new Vector3();
  private readonly gameMove = new Vector3();
  private readonly gameUp = new Vector3(0, 1, 0);

  constructor(private readonly ctx: ViewportContext) {}

  setNavigationMode(mode: NavigationMode): void {
    this.navigationMode = mode;
    this.ctx.controls.enabled = mode === "orbital";
    if (mode === "game") {
      this.frameAnim = null;
      this.syncOrbitTargetToGameHeading();
    } else {
      this.gamePointerActive = false;
      this.gameKeys.clear();
      this.syncOrbitTargetToGameHeading();
    }
  }

  getNavigationMode(): NavigationMode {
    return this.navigationMode;
  }

  setGameCameraSpeed(speed: number): void {
    const nextSpeed = Math.min(50, Math.max(0.1, speed));
    if (nextSpeed === this.gameCameraSpeed) return;
    this.gameCameraSpeed = nextSpeed;
    this.ctx.host.dispatchEvent(new CustomEvent("camera-speed-change", {
      detail: { speed: this.gameCameraSpeed },
    }));
  }

  getGameCameraSpeed(): number {
    return this.gameCameraSpeed;
  }

  cancelFrameAnim(): void {
    this.frameAnim = null;
  }

  isFrameAnimating(): boolean {
    return this.frameAnim !== null;
  }

  setCameraPose(pose: CameraPose): void {
    this.frameAnim = null;
    if (pose.fov !== undefined && Number.isFinite(pose.fov)) {
      this.ctx.camera.fov = pose.fov;
    }
    if (pose.near !== undefined && Number.isFinite(pose.near)) {
      this.ctx.camera.near = pose.near;
    }
    if (pose.far !== undefined && Number.isFinite(pose.far)) {
      this.ctx.camera.far = pose.far;
    }
    this.ctx.camera.position.fromArray(pose.position);
    this.ctx.controls.target.fromArray(pose.target);
    this.ctx.camera.lookAt(this.ctx.controls.target);
    this.ctx.camera.updateProjectionMatrix();
    this.ctx.controls.update();
  }

  tickFrameAnim(): void {
    const a = this.frameAnim;
    if (!a) return;
    // ~18 frames at 60fps ≈ 300ms ease-out
    a.t = Math.min(1, a.t + 0.055);
    const ease = 1 - Math.pow(1 - a.t, 3);
    this.ctx.camera.position.lerpVectors(a.startPos, a.endPos, ease);
    this.ctx.controls.target.lerpVectors(a.startTarget, a.endTarget, ease);
    if (a.t >= 1) this.frameAnim = null;
  }

  tickGameNavigation(): void {
    const now = performance.now();
    const deltaSeconds = Math.min((now - this.lastFrameTime) / 1000, 0.05);
    this.lastFrameTime = now;

    if (this.navigationMode !== "game" || !this.gamePointerActive) {
      return;
    }

    const camera = this.ctx.camera;
    camera.getWorldDirection(this.gameForward);
    this.gameRight.crossVectors(this.gameForward, this.gameUp).normalize();
    this.gameMove.set(0, 0, 0);

    if (this.gameKeys.has("w")) this.gameMove.add(this.gameForward);
    if (this.gameKeys.has("s")) this.gameMove.sub(this.gameForward);
    if (this.gameKeys.has("d")) this.gameMove.add(this.gameRight);
    if (this.gameKeys.has("a")) this.gameMove.sub(this.gameRight);
    if (this.gameKeys.has("e")) this.gameMove.add(this.gameUp);
    if (this.gameKeys.has("q")) this.gameMove.sub(this.gameUp);

    if (this.gameMove.lengthSq() > 0) {
      this.gameMove.normalize().multiplyScalar(this.gameCameraSpeed * deltaSeconds);
      camera.position.add(this.gameMove);
      this.syncOrbitTargetToGameHeading();
    }
  }

  installGameNavigationHandlers(): void {
    this.ctx.renderer.domElement.addEventListener("contextmenu", this.onGameContextMenu);
    this.ctx.renderer.domElement.addEventListener("mousedown", this.onGameMouseDown);
    window.addEventListener("mouseup", this.onGameMouseUp);
    window.addEventListener("mousemove", this.onGameMouseMove);
    window.addEventListener("keydown", this.onGameKeyDown);
    window.addEventListener("keyup", this.onGameKeyUp);
    this.ctx.renderer.domElement.addEventListener("wheel", this.onGameWheel, { passive: false });
  }

  removeGameNavigationHandlers(): void {
    this.ctx.renderer.domElement.removeEventListener("contextmenu", this.onGameContextMenu);
    this.ctx.renderer.domElement.removeEventListener("mousedown", this.onGameMouseDown);
    window.removeEventListener("mouseup", this.onGameMouseUp);
    window.removeEventListener("mousemove", this.onGameMouseMove);
    window.removeEventListener("keydown", this.onGameKeyDown);
    window.removeEventListener("keyup", this.onGameKeyUp);
    this.ctx.renderer.domElement.removeEventListener("wheel", this.onGameWheel);
  }

  private readonly onGameContextMenu = (event: MouseEvent): void => {
    if (this.navigationMode === "game") {
      event.preventDefault();
    }
  };

  private readonly onGameMouseDown = (event: MouseEvent): void => {
    if (this.navigationMode !== "game" || event.button !== 2) return;
    event.preventDefault();
    this.gamePointerActive = true;
    this.ctx.controls.enabled = false;
  };

  private readonly onGameMouseUp = (event: MouseEvent): void => {
    if (event.button !== 2) return;
    this.gamePointerActive = false;
    this.gameKeys.clear();
    if (this.navigationMode === "orbital") {
      this.ctx.controls.enabled = true;
    }
  };

  private readonly onGameMouseMove = (event: MouseEvent): void => {
    if (this.navigationMode !== "game" || !this.gamePointerActive) return;
    event.preventDefault();

    const camera = this.ctx.camera;
    camera.rotation.order = "YXZ";
    camera.rotation.y -= event.movementX * 0.002;
    camera.rotation.x = Math.max(
      -Math.PI / 2 + 0.01,
      Math.min(Math.PI / 2 - 0.01, camera.rotation.x - event.movementY * 0.002)
    );
    this.syncOrbitTargetToGameHeading();
  };

  private readonly onGameKeyDown = (event: KeyboardEvent): void => {
    if (this.navigationMode !== "game" || !this.gamePointerActive) return;
    const key = event.key.toLowerCase();
    if (!"wasdqe".includes(key)) return;
    event.preventDefault();
    this.gameKeys.add(key);
  };

  private readonly onGameKeyUp = (event: KeyboardEvent): void => {
    this.gameKeys.delete(event.key.toLowerCase());
  };

  private readonly onGameWheel = (event: WheelEvent): void => {
    if (this.navigationMode !== "game" || !this.gamePointerActive) return;
    event.preventDefault();
    const multiplier = event.deltaY < 0 ? 1.15 : 1 / 1.15;
    this.setGameCameraSpeed(this.gameCameraSpeed * multiplier);
  };

  private syncOrbitTargetToGameHeading(): void {
    this.ctx.camera.getWorldDirection(this.gameForward);
    this.ctx.controls.target.copy(this.ctx.camera.position).add(this.gameForward);
  }

  animateToBox(box: Box3, keepDirection: boolean): void {
    const camera = this.ctx.camera;
    const controls = this.ctx.controls;
    const center = new Vector3();
    const size = new Vector3();
    box.getCenter(center);
    box.getSize(size);
    const maxSize = Math.max(size.x, size.y, size.z, 0.001);
    const fovRad = (camera.fov * Math.PI) / 180;
    const distance = (maxSize * 0.5) / Math.tan(fovRad * 0.5) * 1.6;

    const dir = keepDirection
      ? camera.position.clone().sub(controls.target).normalize()
      : new Vector3(1, 0.65, 1).normalize();

    const endPos = center.clone().addScaledVector(dir, distance);
    camera.near = Math.max(distance / 100, 0.001);
    camera.far = distance * 100;
    camera.updateProjectionMatrix();

    this.frameAnim = {
      startPos: camera.position.clone(),
      startTarget: controls.target.clone(),
      endPos,
      endTarget: center,
      t: 0,
    };
  }
}
