// Mouse and touch on the canvas. One finger or the left button drags the view; a short press with
// no movement is a tap; the wheel or a pinch zooms; Q/E (or two-finger twist later) turn the camera.
// The game decides what a tap means (build, inspect, buy land); this only reports cells.

import * as THREE from "three";
import type { CityCamera } from "./camera";

// What a ray from the pointer hits. `anchor` is the building (or road) whose model is nearest along the
// ray: clicking a tall building's wall means that building, not whatever stands on the ground behind
// it. `world` is where the ray meets the ground (for placing), `hit` the first other pickable (land
// overlays for sale).
export interface Pick {
  world: THREE.Vector3 | null;
  hit: THREE.Object3D | null;
  anchor: number | undefined;
}

function tileAnchor(o: THREE.Object3D | null): number | undefined {
  for (let p = o; p; p = p.parent) if (typeof p.userData.anchor === "number") return p.userData.anchor;
  return undefined;
}

export function pickHits(ray: THREE.Raycaster, ground: THREE.Object3D, others: THREE.Object3D[], tiles: THREE.Object3D[]): Pick {
  const hits = ray.intersectObjects([ground, ...others, ...tiles], true); // sorted nearest first
  let world: THREE.Vector3 | null = null;
  let hit: THREE.Object3D | null = null;
  let anchor: number | undefined;
  let first = true;
  for (const h of hits) {
    const a = h.object === ground ? undefined : tileAnchor(h.object);
    if (first) {
      anchor = a; // only the nearest thing counts as "the building under the pointer"
      first = false;
    }
    if (h.object === ground) {
      if (!world) world = h.point.clone();
    } else if (a === undefined && !hit) {
      hit = h.object;
    }
  }
  return { world, hit, anchor };
}

export interface InputHandlers {
  onTap: (cell: [number, number] | null, world: THREE.Vector3 | null, hit: THREE.Object3D | null, anchor: number | undefined) => void;
  onHover: (cell: [number, number] | null, anchor: number | undefined) => void;
  onKey?: (key: string, e: KeyboardEvent) => void;
}

interface Touch {
  id: number;
  x: number;
  y: number;
}

const TAP_MOVE = 6; // px: a press that moves less than this is a tap, whatever its length

export class Input {
  private readonly ray = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly touches: Touch[] = [];
  private pressX = 0;
  private pressY = 0;
  private pressMoved = false;
  private last: { x: number; y: number } | null = null;
  private pinchDist = 0;
  private hoverCell: [number, number] | null = null;
  pickables: THREE.Object3D[] = [];
  tiles: () => THREE.Object3D[] = () => []; // the building and road models, for clicking a building itself
  private hoverAnchor: number | undefined;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly camera: CityCamera,
    private readonly ground: () => THREE.Object3D,
    private readonly handlers: InputHandlers,
  ) {
    canvas.addEventListener("pointerdown", this.onDown);
    canvas.addEventListener("pointermove", this.onMove);
    canvas.addEventListener("pointerup", this.onUp);
    canvas.addEventListener("pointercancel", this.onUp);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", (e) => this.held.delete(e.key.toLowerCase()));
    window.addEventListener("blur", () => this.held.clear());
  }

  private readonly held = new Set<string>();
  private static readonly PAN_KEYS: Record<string, [number, number]> = {
    w: [0, 1], arrowup: [0, 1], s: [0, -1], arrowdown: [0, -1], a: [1, 0], arrowleft: [1, 0], d: [-1, 0], arrowright: [-1, 0],
  };

  // Call once per frame: pans while W/A/S/D or the arrow keys are held.
  update(dt: number): void {
    let dx = 0;
    let dz = 0;
    for (const k of this.held) {
      const v = Input.PAN_KEYS[k];
      if (v) {
        dx += v[0];
        dz += v[1];
      }
    }
    if (dx || dz) this.camera.pan(dx * 700 * dt, dz * 700 * dt);
  }

  // withTiles: false for zooming, which only needs the ground point (and skips testing every model)
  private pick(x: number, y: number, withTiles = true): Pick {
    const r = this.canvas.getBoundingClientRect();
    this.ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.camera.camera);
    return pickHits(this.ray, this.ground(), this.pickables, withTiles ? this.tiles() : []);
  }

  private cellOf(world: THREE.Vector3 | null): [number, number] | null {
    if (!world) return null;
    return [Math.floor(world.x / 4), Math.floor(world.z / 4)];
  }

  private onDown = (e: PointerEvent): void => {
    this.canvas.setPointerCapture(e.pointerId);
    this.touches.push({ id: e.pointerId, x: e.clientX, y: e.clientY });
    if (this.touches.length === 1) {
      this.pressX = e.clientX;
      this.pressY = e.clientY;
      this.pressMoved = false;
      this.last = { x: e.clientX, y: e.clientY };
    } else if (this.touches.length === 2) {
      this.pinchDist = this.dist();
      this.pressMoved = true;
    }
  };

  private dist(): number {
    const [a, b] = this.touches;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  private onMove = (e: PointerEvent): void => {
    const t = this.touches.find((x) => x.id === e.pointerId);
    if (!t) {
      // hover with no button
      const { world, anchor } = this.pick(e.clientX, e.clientY);
      this.setHover(this.cellOf(world), anchor);
      return;
    }
    t.x = e.clientX;
    t.y = e.clientY;
    if (this.touches.length === 1 && this.last) {
      const dx = e.clientX - this.last.x;
      const dy = e.clientY - this.last.y;
      if (!this.pressMoved && Math.hypot(e.clientX - this.pressX, e.clientY - this.pressY) > TAP_MOVE) this.pressMoved = true;
      if (this.pressMoved) {
        // right button, middle button, or Alt + left (for trackpads): orbit; left: pan
        if (e.pointerType === "mouse" && (e.buttons === 2 || e.buttons === 4 || (e.buttons === 1 && e.altKey))) this.camera.orbit(dx * 0.006, dy * 0.005);
        else this.camera.pan(dx, dy);
        this.last = { x: e.clientX, y: e.clientY };
      } else {
        const { world, anchor } = this.pick(e.clientX, e.clientY);
        this.setHover(this.cellOf(world), anchor);
      }
    } else if (this.touches.length === 2) {
      const d = this.dist();
      const [a, b] = this.touches;
      if (this.pinchDist > 0 && d > 0) this.zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, this.pinchDist / d);
      this.pinchDist = d;
    }
  };

  private onUp = (e: PointerEvent): void => {
    const i = this.touches.findIndex((x) => x.id === e.pointerId);
    if (i >= 0) this.touches.splice(i, 1);
    if (this.touches.length === 0) {
      if (!this.pressMoved && e.button === 0) {
        const { world, hit, anchor } = this.pick(e.clientX, e.clientY);
        this.handlers.onTap(this.cellOf(world), world, hit, anchor);
      }
      this.last = null;
    }
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.zoomAt(e.clientX, e.clientY, Math.exp(e.deltaY * 0.0012));
  };

  // Zoom so the ground point under (x, y) stays under (x, y): pick it, zoom, pick again at the same
  // screen spot, and shift the camera target by the difference.
  private zoomAt(x: number, y: number, factor: number): void {
    const before = this.pick(x, y, false).world;
    this.camera.zoom(factor);
    this.camera.update(0);
    const after = this.pick(x, y, false).world;
    if (before && after) {
      this.camera.target.add(before).sub(after);
      this.camera.target.clamp(this.camera.bounds.min, this.camera.bounds.max);
      this.camera.update(0);
    }
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if ((e.target as HTMLElement)?.tagName === "INPUT") return;
    const k = e.key.toLowerCase();
    if (Input.PAN_KEYS[k]) {
      this.held.add(k);
      e.preventDefault();
    } else if (k === "q") this.camera.turn(1);
    else if (k === "e") this.camera.turn(-1);
    else this.handlers.onKey?.(e.key, e);
  };

  private setHover(cell: [number, number] | null, anchor: number | undefined): void {
    if (cell?.[0] === this.hoverCell?.[0] && cell?.[1] === this.hoverCell?.[1] && anchor === this.hoverAnchor) return;
    this.hoverCell = cell;
    this.hoverAnchor = anchor;
    this.handlers.onHover(cell, anchor);
  }

  // Set from the game when the camera moved under a resting pointer (keyboard pan etc.)
  get hovered(): [number, number] | null {
    return this.hoverCell;
  }
}