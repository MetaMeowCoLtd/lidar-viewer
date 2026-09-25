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

/**
 * What a drag does, after Unreal Engine's viewport: walk (left), look (right),
 * pan (middle, or left and right together), and with Alt held, orbit (left),
 * dolly (right) and pan (middle). A finger always orbits.
 */
type Drag = "orbit" | "pan" | "walk" | "look" | "dolly";

/** Look and walk turn the camera in place, a little gentler than an orbit around a point. */
const lookPerHeight = Math.PI * 1.1;

function mouseDrag(buttons: number, alt: boolean, panModifier: boolean): Drag | undefined {
  const left = (buttons & 1) !== 0;
  const right = (buttons & 2) !== 0;
  const middle = (buttons & 4) !== 0;
  if (middle || (left && right)) return "pan";
  if (left) return alt ? "orbit" : panModifier ? "pan" : "walk";
  if (right) return alt ? "dolly" : "look";
  return undefined;
}

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
 * Navigation laid out like Unreal Engine's level viewport, so moving through a
 * scan feels like moving through a 3D scene rather than spinning a model:
 *
 * - Left drag walks: up and down moves forward and back over the ground,
 *   left and right turns.
 * - Right drag looks around from where the camera stands. While it is held,
 *   W A S D fly in the direction of view, Q and E drop and rise, and the
 *   wheel sets how fast.
 * - Middle drag, or left and right together, pans - the grabbed point stays
 *   under the cursor.
 * - Alt + left drag orbits around the point under the cursor, Alt + right
 *   drag dollies towards it, Alt + middle pans.
 * - The wheel zooms towards the point under the cursor; double-click flies to
 *   a point.
 * - W A S D and the arrows also work without a button held, once the view
 *   has focus; Shift triples their speed.
 * - On a touch screen one finger orbits and two pinch and pan.
 *
 * Dragging follows the pointer exactly. An orbit or pan flicked and released
 * carries on and slows to a stop; walking and looking stop dead, as in Unreal.
 */
/** How far, in CSS pixels, a mouse press must move before the cursor is locked for a drag. */
const lockAfter = 4;

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
  /** A multiplier on flying speed, set with the wheel while looking around, as in Unreal. */
  private flySpeed = 1;
  /** How far away the scene was when a walk or dolly began, which sets how far a pixel of drag moves. */
  private dragRange = 10;
  private readonly sceneCenter = new Vector3();
  private sceneRadius = 100;
  private groundY = 0;
  private readonly marker: HTMLDivElement;
  /**
   * True while a mouse drag holds the pointer lock: the cursor is hidden and
   * held in place, so it cannot run off the window or onto the page around the
   * scan, and movement comes from the mouse itself rather than the cursor.
   */
  private locked = false;
  /** How far, in CSS pixels, the pointer has travelled since it was pressed. */
  private travelled = 0;
  /** Set when the lock ends mid-drag: the next move starts again from the real cursor. */
  private resync = false;
  /** Set when the browser refused the lock, so the rest of the drag does not ask again. */
  private lockRefused = false;

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
    document.addEventListener("pointerlockchange", this.onPointerLockChange);

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
    document.removeEventListener("pointerlockchange", this.onPointerLockChange);
    this.releaseLock();
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
    this.travelled = 0;
    this.lockRefused = false;

    if (this.pointers.size === 1) {
      // An embedded preview that cannot zoom is a turntable: every drag orbits.
      const drag = event.pointerType !== "mouse" || !this.enableZoom ? "orbit" : mouseDrag(event.buttons, event.altKey, event.shiftKey || event.ctrlKey || event.metaKey);
      this.beginDrag(drag ?? "walk", event.clientX, event.clientY);
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

    // Under the pointer lock the cursor stands still and only the mouse's own
    // movement arrives; a virtual cursor carries on from where it was, so every
    // kind of drag works on exactly the same numbers as without the lock.
    if (this.resync) {
      this.resync = false;
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      return;
    }
    const dx = this.locked ? event.movementX : event.clientX - previous.x;
    const dy = this.locked ? event.movementY : event.clientY - previous.y;
    const at = { x: previous.x + dx, y: previous.y + dy };
    this.pointers.set(event.pointerId, at);
    this.travelled += Math.abs(dx) + Math.abs(dy);
    // Locked only once the press has become a drag, so a click still reaches whatever it clicks.
    if (!this.locked && !this.lockRefused && event.pointerType === "mouse" && this.enableZoom && this.travelled > lockAfter) this.requestLock();

    // Pressing or releasing a second mouse button mid-drag changes what the drag does, as in Unreal.
    if (event.pointerType === "mouse" && this.enableZoom) {
      const drag = mouseDrag(event.buttons, event.altKey, event.shiftKey || event.ctrlKey || event.metaKey);
      if (drag !== undefined && drag !== this.drag) {
        this.stopMotion();
        this.beginDrag(drag, at.x, at.y);
        return;
      }
    }

    const height = Math.max(1, this.element.clientHeight);
    switch (this.drag) {
      case "orbit": {
        const perPixel = turnPerHeight / height;
        const yaw = -dx * perPixel;
        const pitch = -dy * perPixel;
        this.orbit(this.pivot, yaw, pitch);
        this.orbitVelocity.lerp(new Vector2(yaw / elapsed, pitch / elapsed), 0.6);
        break;
      }
      case "look": {
        const perPixel = lookPerHeight / height;
        this.orbit(this.camera.position.clone(), -dx * perPixel, -dy * perPixel);
        break;
      }
      case "walk": {
        // Turn with the sideways motion, and move over the ground with the vertical.
        this.orbit(this.camera.position.clone(), (-dx * lookPerHeight) / height, 0);
        const forward = this.groundForward();
        this.translate(forward.multiplyScalar((-dy / height) * this.dragRange * 1.5));
        break;
      }
      case "dolly": {
        const forward = this.camera.getWorldDirection(new Vector3());
        this.translate(forward.multiplyScalar((-dy / height) * this.dragRange * 2));
        break;
      }
      default:
        this.panTo(at.x, at.y, elapsed);
    }
  };

  /**
   * How far the last press travelled before it was released, in CSS pixels.
   * Under the pointer lock the cursor never moves, so this - not where the
   * press and release happened - tells a drag from a click.
   */
  public get dragDistance(): number {
    return this.travelled;
  }

  private requestLock(): void {
    this.locked = true;
    const refused = () => {
      // Without the lock the drag carries on with the visible cursor, as before.
      this.locked = false;
      this.lockRefused = true;
    };
    try {
      // Raw movement, free of the system's pointer acceleration, where the browser offers it.
      const request = this.element.requestPointerLock({ unadjustedMovement: true }) as Promise<void> | undefined;
      void request?.catch(() => {
        if (this.pointers.size === 0) return refused();
        const plain = this.element.requestPointerLock() as Promise<void> | undefined;
        void plain?.catch(refused);
      });
    } catch {
      refused();
    }
  }

  private releaseLock(): void {
    if (document.pointerLockElement === this.element) document.exitPointerLock();
    this.locked = false;
  }

  /** The lock can end without a release, when Escape is pressed or the window loses focus. */
  private readonly onPointerLockChange = () => {
    if (document.pointerLockElement === this.element) {
      // Granted after a quick drag had already ended: nothing is holding it, so let go at once.
      if (this.pointers.size === 0) this.releaseLock();
      return;
    }
    if (!this.locked) return;
    this.locked = false;
    if (this.drag !== undefined) this.resync = true;
  };

  private readonly onPointerUp = (event: PointerEvent) => {
    if (!this.pointers.delete(event.pointerId)) return;
    if (this.pointers.size === 0) this.releaseLock();
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
    if (this.drag === "look") {
      // While looking around, the wheel sets flying speed rather than zooming.
      this.flySpeed = clamp(this.flySpeed * (event.deltaY < 0 ? 1.25 : 0.8), 0.1, 10);
      return;
    }
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
    if (drag === "walk" || drag === "dolly" || drag === "look") {
      // A pixel of drag covers more ground the further away the scene is.
      const rect = this.element.getBoundingClientRect();
      const reference = drag === "dolly" ? this.pivot : this.pointUnder(rect.left + rect.width / 2, rect.top + rect.height / 2);
      this.dragRange = clamp(this.camera.position.distanceTo(reference), 2, this.sceneRadius * 3);
      if (drag === "look") this.keyRange = this.dragRange;
    }
    this.element.style.cursor = drag === "pan" ? "grabbing" : drag === "look" ? "crosshair" : drag === "walk" ? "move" : "";
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
    if (this.drag !== "look" && !["forward", "back", "left", "right", "up", "down"].some((held) => this.keys.has(held))) {
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
      // Keys fly where the camera looks, as in Unreal: W towards the centre of the view.
      const forward = this.camera.getWorldDirection(new Vector3());
      const right = new Vector3().crossVectors(this.groundForward(), up).normalize();
      if (this.keys.has("forward")) wanted.add(forward);
      if (this.keys.has("back")) wanted.sub(forward);
      if (this.keys.has("right")) wanted.add(right);
      if (this.keys.has("left")) wanted.sub(right);
      if (this.keys.has("up")) wanted.add(up);
      if (this.keys.has("down")) wanted.sub(up);
      // Speed follows how far away the scene is, so the same key covers a street up close and a valley from above.
      const speed = clamp(this.keyRange, 2, this.sceneRadius * 2) * 0.6 * this.flySpeed * (this.keys.has("fast") ? 3 : 1);
      if (wanted.lengthSq() > 0) wanted.normalize().multiplyScalar(speed);
    }
    this.keyVelocity.lerp(wanted, 1 - Math.exp(-10 * dt));
    if (this.keyVelocity.lengthSq() > 1e-6) this.translate(this.keyVelocity.clone().multiplyScalar(dt));
  }

  /** The horizontal direction the camera faces; looking straight down, the top of the screen. */
  private groundForward(): Vector3 {
    const forward = this.camera.getWorldDirection(new Vector3());
    forward.y = 0;
    if (forward.lengthSq() < 1e-4) forward.copy(up).applyQuaternion(this.camera.quaternion).setY(0);
    return forward.normalize();
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
