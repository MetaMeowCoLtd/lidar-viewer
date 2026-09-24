import { Matrix4, Plane, Quaternion, Raycaster, Vector2, Vector3, type PerspectiveCamera } from "three";

/** Finds the scan point under a position in the page, for orbiting, zooming and panning around. */
export type PivotPicker = (clientX: number, clientY: number) => Vector3 | undefined;

const up = new Vector3(0, 1, 0);
/** How far the camera may pitch, in radians: nearly straight down, and a little above the horizon. */
const minPitch = -1.52;
const maxPitch = 0.6;
/** Rotation per pixel of drag, as a share of a full turn across the canvas height. */
const turnPerHeight = Math.PI * 1.6;
/** How quickly a wheel notch's zoom plays out, per second. */
const zoomResponse = 20;
/** How quickly flung motion dies away after release, per second. */
const inertiaDecay = 5.5;
/** Pointer moves older than this at release do not fling. */
const flingWindow = 90;

type Drag = "orbit" | "pan";

interface Flight {
  readonly fromPosition: Vector3;
  readonly toPosition: Vector3;
  readonly fromQuaternion: Quaternion;
  readonly toQuaternion: Quaternion;
  readonly toTarget: Vector3;
  elapsed: number;
  readonly duration: number;
}

/**
 * Navigation in the style of 3D modelling and point-cloud tools, replacing an
 * orbit around one fixed centre:
 *
 * - Left drag turns the view around the point under the cursor, not around
 *   the middle of the scan, so whatever was grabbed stays put.
 * - Right drag, middle drag or Shift + left drag pans, keeping the grabbed
 *   point under the cursor.
 * - The wheel zooms towards the point under the cursor, in steps proportional
 *   to the distance to it, so it slows down near a surface instead of near an
 *   arbitrary target, and never gets stuck.
 * - Double-click flies to the point clicked.
 * - W A S D or the arrow keys move across the ground - forward, left, back,
 *   right as the view faces - Q and E move down and up, and Shift moves
 *   three times faster. Keys only steer the view while it has focus, so the
 *   arrows still work in the panels; clicking the scan gives it focus.
 * - One finger turns and two fingers pinch and pan on a touch screen.
 *
 * Dragging follows the pointer exactly, with no lag; a flick carries on and
 * slows to a stop, and the wheel eases in over a few frames.
 */
export class NavigationControls {
  /** The point the view is centred on; auto-rotation turns around it. */
  public readonly target = new Vector3();
  public enableZoom = true;
  public enableKeys = true;
  /** Off while clicks mean something else in quick succession, such as placing measurement points. */
  public enableDoubleClick = true;
  public autoRotate = false;
  /** Auto-rotation speed, in turns per minute. */
  public autoRotateSpeed = 0.5;

  private readonly raycaster = new Raycaster();
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private drag: Drag | undefined;
  private readonly pivot = new Vector3();
  private readonly panPlane = new Plane();
  private lastMove = 0;
  private pinchDistance = 0;
  private readonly orbitVelocity = new Vector2();
  private readonly panVelocity = new Vector3();
  private zoomPending = 0;
  private readonly zoomPoint = new Vector3();
  private zoomPointAt = { x: Number.NaN, y: Number.NaN, time: 0 };
  private flight: Flight | undefined;
  private readonly keys = new Set<string>();
  private readonly keyVelocity = new Vector3();
  /** How far away the scene was when the keys went down, which sets how fast they move. */
  private keyRange = 10;
  private readonly sceneCenter = new Vector3();
  private sceneRadius = 100;
  private groundY = 0;
  private readonly marker: HTMLDivElement;

  public constructor(
    private readonly camera: PerspectiveCamera,
    private readonly element: HTMLCanvasElement,
    private readonly pickPivot: PivotPicker,
  ) {
    // Focusable, so keyboard movement can belong to the view rather than the whole page.
    if (element.tabIndex < 0) element.tabIndex = 0;
    element.style.outline = "none";
    element.addEventListener("mousedown", this.onMouseDown);
    element.addEventListener("pointerdown", this.onPointerDown);
    element.addEventListener("pointermove", this.onPointerMove);
    element.addEventListener("pointerup", this.onPointerUp);
    element.addEventListener("pointercancel", this.onPointerUp);
    element.addEventListener("wheel", this.onWheel, { passive: false });
    element.addEventListener("dblclick", this.onDoubleClick);
    element.addEventListener("contextmenu", this.onContextMenu);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);

    // A small ring marks the point the view is turning around while dragging.
    this.marker = document.createElement("div");
    Object.assign(this.marker.style, {
      position: "fixed",
      width: "12px",
      height: "12px",
      margin: "-6px 0 0 -6px",
      borderRadius: "50%",
      border: "2px solid rgba(255, 255, 255, 0.9)",
      boxShadow: "0 0 0 1px rgba(0, 0, 0, 0.5)",
      pointerEvents: "none",
      display: "none",
      zIndex: "5",
    });
    document.body.appendChild(this.marker);
  }

  /** Tells the controls how big the scan is, for movement speeds, zoom limits and where the ground lies. */
  public setScene(center: Vector3, radius: number, groundY: number): void {
    this.sceneCenter.copy(center);
    this.sceneRadius = Math.max(radius, 1);
    this.groundY = groundY;
  }

  /** Puts the camera at `position` looking at `target`, stopping any motion in progress. */
  public setView(position: Vector3, target: Vector3): void {
    this.stopMotion();
    this.camera.position.copy(position);
    this.target.copy(target);
    this.lookAlong(target.clone().sub(position));
  }

  /** Advances motion by `seconds`; call once per frame. */
  public update(seconds: number): void {
    const dt = Math.min(seconds, 0.1);
    if (this.flight !== undefined) {
      this.advanceFlight(dt);
      return;
    }

    if (this.drag === undefined) {
      // Carry on a flick, slowing down.
      const decay = Math.exp(-inertiaDecay * dt);
      if (this.orbitVelocity.lengthSq() > 1e-8) {
        this.orbit(this.pivot, this.orbitVelocity.x * dt, this.orbitVelocity.y * dt);
        this.orbitVelocity.multiplyScalar(decay);
      }
      if (this.panVelocity.lengthSq() > 1e-8) {
        this.translate(this.panVelocity.clone().multiplyScalar(dt));
        this.panVelocity.multiplyScalar(decay);
      }
      if (this.autoRotate && this.pointers.size === 0) {
        this.orbit(this.target, -((this.autoRotateSpeed * Math.PI * 2) / 60) * dt, 0);
      }
    }

    if (this.zoomPending !== 0) {
      const share = Math.abs(this.zoomPending) < 0.5 ? this.zoomPending : this.zoomPending * (1 - Math.exp(-zoomResponse * dt));
      this.zoomPending -= share;
      this.dolly(this.zoomPoint, Math.exp(share * 0.0017));
    }

    this.moveWithKeys(dt);
    if (this.drag !== undefined) this.showMarker();
  }

  public dispose(): void {
    const element = this.element;
    element.removeEventListener("mousedown", this.onMouseDown);
    element.removeEventListener("pointerdown", this.onPointerDown);
    element.removeEventListener("pointermove", this.onPointerMove);
    element.removeEventListener("pointerup", this.onPointerUp);
    element.removeEventListener("pointercancel", this.onPointerUp);
    element.removeEventListener("wheel", this.onWheel);
    element.removeEventListener("dblclick", this.onDoubleClick);
    element.removeEventListener("contextmenu", this.onContextMenu);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    this.marker.remove();
  }

  // ------------------------------------------------------------- pointer

  /** A middle press would otherwise start the browser's autoscroll instead of a pan. */
  private readonly onMouseDown = (event: MouseEvent) => {
    if (event.button === 1) event.preventDefault();
  };

  private readonly onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === "mouse" && event.button > 2) return;
    this.element.focus({ preventScroll: true });
    this.flight = undefined;
    this.stopMotion();
    // Capture keeps a drag going when the pointer leaves the canvas; a pointer the browser no longer tracks cannot be captured.
    try {
      this.element.setPointerCapture(event.pointerId);
    } catch {
      // The drag still works while the pointer stays over the canvas.
    }
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    this.lastMove = event.timeStamp;

    if (this.pointers.size === 1) {
      const pan = event.button === 1 || event.button === 2 || event.shiftKey || event.ctrlKey || event.metaKey;
      this.beginDrag(pan ? "pan" : "orbit", event.clientX, event.clientY);
    } else if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
      this.pinchDistance = Math.hypot(a.x - b.x, a.y - b.y);
      this.beginDrag("pan", (a.x + b.x) / 2, (a.y + b.y) / 2);
    }
  };

  private readonly onPointerMove = (event: PointerEvent) => {
    const previous = this.pointers.get(event.pointerId);
    if (previous === undefined || this.drag === undefined) return;
    // Events can arrive in bursts a millisecond apart; a floor on the interval keeps a flick's speed sane.
    const elapsed = Math.max(8, event.timeStamp - this.lastMove) / 1000;
    this.lastMove = event.timeStamp;

    if (this.pointers.size >= 2) {
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const [a, b] = [...this.pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.enableZoom && this.pinchDistance > 0 && distance > 0) this.dolly(this.pivot, this.pinchDistance / distance);
      this.pinchDistance = distance;
      this.panTo((a.x + b.x) / 2, (a.y + b.y) / 2, elapsed);
      return;
    }

    const dx = event.clientX - previous.x;
    const dy = event.clientY - previous.y;
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.drag === "orbit") {
      const perPixel = turnPerHeight / Math.max(1, this.element.clientHeight);
      const yaw = -dx * perPixel;
      const pitch = -dy * perPixel;
      this.orbit(this.pivot, yaw, pitch);
      this.orbitVelocity.lerp(new Vector2(yaw / elapsed, pitch / elapsed), 0.6);
    } else {
      this.panTo(event.clientX, event.clientY, elapsed);
    }
  };

  private readonly onPointerUp = (event: PointerEvent) => {
    if (!this.pointers.delete(event.pointerId)) return;
    if (this.element.hasPointerCapture(event.pointerId)) this.element.releasePointerCapture(event.pointerId);
    const still = event.timeStamp - this.lastMove > flingWindow;
    if (this.pointers.size === 1) {
      // Lifting one of two fingers carries on as a one-finger turn.
      const [remaining] = [...this.pointers.values()] as [{ x: number; y: number }];
      this.stopMotion();
      this.beginDrag("orbit", remaining.x, remaining.y);
      return;
    }
    if (this.pointers.size === 0) {
      if (still) this.stopMotion();
      this.drag = undefined;
      this.element.style.cursor = "";
      this.marker.style.display = "none";
    }
  };

  private readonly onWheel = (event: WheelEvent) => {
    if (!this.enableZoom) return;
    event.preventDefault();
    this.flight = undefined;
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1;
    // One burst of scrolling in one place zooms towards one point; picking it again every event would be wasted work.
    const last = this.zoomPointAt;
    if (event.timeStamp - last.time > 250 || Math.hypot(event.clientX - last.x, event.clientY - last.y) > 4) {
      this.zoomPoint.copy(this.pointUnder(event.clientX, event.clientY));
    }
    this.zoomPointAt = { x: event.clientX, y: event.clientY, time: event.timeStamp };
    this.zoomPending += Math.max(-400, Math.min(400, event.deltaY * scale));
  };

  private readonly onDoubleClick = (event: MouseEvent) => {
    if (!this.enableDoubleClick) return;
    const point = this.pickPivot(event.clientX, event.clientY);
    if (point === undefined) return;
    this.flyTo(point);
  };

  private readonly onContextMenu = (event: Event) => event.preventDefault();

  private beginDrag(drag: Drag, clientX: number, clientY: number): void {
    this.drag = drag;
    this.pivot.copy(this.pointUnder(clientX, clientY));
    if (drag === "orbit") this.target.copy(this.pivot);
    this.panPlane.setFromNormalAndCoplanarPoint(this.camera.getWorldDirection(new Vector3()), this.pivot);
    this.element.style.cursor = drag === "pan" ? "grabbing" : "";
    this.showMarker();
  }

  /** Moves the camera so the grabbed point sits under the given position in the page. */
  private panTo(clientX: number, clientY: number, elapsed: number): void {
    const hit = this.rayAt(clientX, clientY).ray.intersectPlane(this.panPlane, new Vector3());
    if (hit === null) return;
    const shift = this.pivot.clone().sub(hit);
    this.translate(shift);
    this.panVelocity.lerp(shift.divideScalar(elapsed), 0.6);
  }

  // ------------------------------------------------------------ keyboard

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (!this.enableKeys || event.ctrlKey || event.metaKey || event.altKey) return;
    // Only when nothing else has focus: arrow keys in a panel belong to the panel.
    if (event.target !== this.element && event.target !== document.body) return;
    const key = movementKey(event.code);
    if (key === undefined) return;
    if (!["forward", "back", "left", "right", "up", "down"].some((held) => this.keys.has(held))) {
      // Speed is set by how far away the scene in the middle of the view is, measured as movement starts.
      const rect = this.element.getBoundingClientRect();
      this.keyRange = this.camera.position.distanceTo(this.pointUnder(rect.left + rect.width / 2, rect.top + rect.height / 2));
    }
    this.flight = undefined;
    this.keys.add(key);
    if (event.shiftKey) this.keys.add("fast");
    event.preventDefault();
  };

  private readonly onKeyUp = (event: KeyboardEvent) => {
    const key = movementKey(event.code);
    if (key !== undefined) this.keys.delete(key);
    if (!event.shiftKey) this.keys.delete("fast");
  };

  private readonly onBlur = () => this.keys.clear();

  private moveWithKeys(dt: number): void {
    const wanted = new Vector3();
    if (this.keys.size > 0) {
      const forward = this.camera.getWorldDirection(new Vector3());
      forward.y = 0;
      // Looking straight down, "forward" is towards the top of the screen.
      if (forward.lengthSq() < 1e-4) forward.copy(up).applyQuaternion(this.camera.quaternion).setY(0);
      forward.normalize();
      const right = new Vector3().crossVectors(forward, up).normalize();
      if (this.keys.has("forward")) wanted.add(forward);
      if (this.keys.has("back")) wanted.sub(forward);
      if (this.keys.has("right")) wanted.add(right);
      if (this.keys.has("left")) wanted.sub(right);
      if (this.keys.has("up")) wanted.add(up);
      if (this.keys.has("down")) wanted.sub(up);
      // Speed follows how far away the scene is, so the same key covers a street up close and a valley from above.
      const speed = clamp(this.keyRange, 2, this.sceneRadius * 2) * 0.6 * (this.keys.has("fast") ? 3 : 1);
      if (wanted.lengthSq() > 0) wanted.normalize().multiplyScalar(speed);
    }
    this.keyVelocity.lerp(wanted, 1 - Math.exp(-10 * dt));
    if (this.keyVelocity.lengthSq() > 1e-6) this.translate(this.keyVelocity.clone().multiplyScalar(dt));
  }

  // -------------------------------------------------------------- motion

  /** Turns the camera around `pivot`: `yaw` about the vertical, `pitch` about the camera's own horizontal. */
  private orbit(pivot: Vector3, yaw: number, pitch: number): void {
    const offset = this.camera.position.clone().sub(pivot);
    const forward = this.camera.getWorldDirection(new Vector3());
    const turn = new Quaternion().setFromAxisAngle(up, yaw);
    offset.applyQuaternion(turn);
    forward.applyQuaternion(turn);

    const current = Math.asin(Math.max(-1, Math.min(1, forward.y)));
    const tilt = Math.max(minPitch, Math.min(maxPitch, current + pitch)) - current;
    if (tilt !== 0) {
      const right = new Vector3().crossVectors(forward, up).normalize();
      turn.setFromAxisAngle(right, tilt);
      offset.applyQuaternion(turn);
      forward.applyQuaternion(turn);
    }
    const targetOffset = this.target.clone().sub(pivot);
    targetOffset.applyAxisAngle(up, yaw);
    this.camera.position.copy(pivot).add(offset);
    this.target.copy(pivot).add(targetOffset);
    this.lookAlong(forward);
  }

  /** Scales the camera's distance from `point` by `factor`, keeping `point` where it is on screen. */
  private dolly(point: Vector3, factor: number): void {
    const offset = this.camera.position.clone().sub(point);
    const distance = offset.length();
    const nearest = Math.max(0.3, this.sceneRadius * 0.0005);
    let scaled = Math.max(nearest, distance * factor);
    // Never so far that the scan shrinks to nothing.
    const fromCenter = this.camera.position.distanceTo(this.sceneCenter);
    if (factor > 1 && fromCenter > this.sceneRadius * 6) scaled = distance;
    if (distance === 0) return;
    offset.multiplyScalar(scaled / distance);
    this.camera.position.copy(point).add(offset);
    this.camera.updateMatrixWorld();
  }

  /** Moves the camera and its target; a grabbed point stays where it is in the world. */
  private translate(shift: Vector3): void {
    this.camera.position.add(shift);
    this.target.add(shift);
    this.camera.updateMatrixWorld();
  }

  private flyTo(point: Vector3): void {
    this.stopMotion();
    const distance = this.camera.position.distanceTo(point);
    const away = this.camera.position.clone().sub(point).normalize();
    const toPosition = point.clone().add(away.multiplyScalar(Math.max(distance * 0.35, Math.min(12, distance))));
    const toQuaternion = new Quaternion().setFromRotationMatrix(new Matrix4().lookAt(toPosition, point, up));
    this.flight = {
      fromPosition: this.camera.position.clone(),
      toPosition,
      fromQuaternion: this.camera.quaternion.clone(),
      toQuaternion,
      toTarget: point.clone(),
      elapsed: 0,
      duration: 0.7,
    };
  }

  private advanceFlight(dt: number): void {
    const flight = this.flight!;
    flight.elapsed += dt;
    const t = Math.min(1, flight.elapsed / flight.duration);
    const eased = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
    this.camera.position.lerpVectors(flight.fromPosition, flight.toPosition, eased);
    this.camera.quaternion.slerpQuaternions(flight.fromQuaternion, flight.toQuaternion, eased);
    this.camera.updateMatrixWorld();
    if (t >= 1) {
      this.target.copy(flight.toTarget);
      this.flight = undefined;
    }
  }

  private stopMotion(): void {
    this.orbitVelocity.set(0, 0);
    this.panVelocity.set(0, 0, 0);
    this.zoomPending = 0;
  }

  private lookAlong(direction: Vector3): void {
    this.camera.up.copy(up);
    this.camera.lookAt(this.camera.position.clone().add(direction));
    this.camera.updateMatrixWorld();
  }

  // ------------------------------------------------------------- picking

  private rayAt(clientX: number, clientY: number): Raycaster {
    const rect = this.element.getBoundingClientRect();
    const ndc = new Vector2(((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1, -((clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1);
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster;
  }

  /**
   * The scan point under a position in the page; where there is none, the
   * ground plane under it, or failing that a point as far away as the target.
   */
  private pointUnder(clientX: number, clientY: number): Vector3 {
    const picked = this.pickPivot(clientX, clientY);
    if (picked !== undefined) return picked;
    const ray = this.rayAt(clientX, clientY).ray;
    const ground = ray.intersectPlane(new Plane(up.clone(), -this.groundY), new Vector3());
    if (ground !== null && ground.distanceTo(this.camera.position) < this.sceneRadius * 4) return ground;
    return ray.at(Math.max(1, this.camera.position.distanceTo(this.target)), new Vector3());
  }

  private showMarker(): void {
    const rect = this.element.getBoundingClientRect();
    const projected = this.pivot.clone().project(this.camera);
    const visible = projected.z > -1 && projected.z < 1 && Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1;
    this.marker.style.display = visible && this.drag === "orbit" ? "block" : "none";
    this.marker.style.left = `${rect.left + ((projected.x + 1) / 2) * rect.width}px`;
    this.marker.style.top = `${rect.top + ((1 - projected.y) / 2) * rect.height}px`;
  }
}

function movementKey(code: string): string | undefined {
  switch (code) {
    case "KeyW":
    case "ArrowUp":
      return "forward";
    case "KeyS":
    case "ArrowDown":
      return "back";
    case "KeyA":
    case "ArrowLeft":
      return "left";
    case "KeyD":
    case "ArrowRight":
      return "right";
    case "KeyE":
      return "up";
    case "KeyQ":
      return "down";
    default:
      return undefined;
  }
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}
