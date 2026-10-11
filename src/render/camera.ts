// The tilted city camera: looks at a target on the ground from a fixed pitch, pans, zooms, and turns
// in quarter steps. Input (drag, wheel, pinch, keys) is wired in input.ts.
import * as THREE from "three";

export class CityCamera {
  readonly target = new THREE.Vector3();
  distance = 120;
  yaw = 0; // radians, 0 = looking from the front (-z) toward +z
  pitch = THREE.MathUtils.degToRad(46);
  minDistance = 30;
  maxDistance = 400;
  bounds = new THREE.Box3();
  private goalYaw = 0;

  constructor(readonly camera: THREE.PerspectiveCamera) {}

  setBounds(extent: number, margin: number): void {
    this.bounds.set(new THREE.Vector3(-margin, 0, -margin), new THREE.Vector3(extent + margin, 0, extent + margin));
  }

  // A drag of (dx, dz) screen pixels (right, down): the ground follows the pointer. Keys call it too:
  // A / left arrow is pan(+x), so the ground moves right and the view goes left.
  pan(dx: number, dz: number): void {
    const s = this.distance * 0.0016;
    // the screen's right on the ground: forward x up for a camera looking along `forward`
    const right = new THREE.Vector3(-Math.cos(this.yaw), 0, Math.sin(this.yaw));
    const forward = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    this.target.addScaledVector(right, -dx * s).addScaledVector(forward, dz * s);
    this.target.clamp(this.bounds.min, this.bounds.max);
  }

  zoom(factor: number): void {
    this.distance = THREE.MathUtils.clamp(this.distance * factor, this.minDistance, this.maxDistance);
  }

  minPitch = THREE.MathUtils.degToRad(12); // almost level with the ground, horizon in view
  maxPitch = THREE.MathUtils.degToRad(85); // nearly straight down

  // Free orbit around the target: right-drag turns (yaw) and tilts (pitch) the view.
  orbit(dYaw: number, dPitch: number): void {
    this.yaw += dYaw;
    this.goalYaw = this.yaw;
    this.pitch = THREE.MathUtils.clamp(this.pitch + dPitch, this.minPitch, this.maxPitch);
  }

  setYaw(r: number): void {
    this.yaw = r;
    this.goalYaw = r;
  }

  turn(quarterTurns: number): void {
    this.goalYaw += quarterTurns * (Math.PI / 2);
  }

  update(dt: number): void {
    // ease the turn
    const d = this.goalYaw - this.yaw;
    this.yaw += d * Math.min(1, dt * 8);
    if (Math.abs(d) < 0.0005) this.yaw = this.goalYaw;
    const back = new THREE.Vector3(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
    this.camera.position.copy(this.target).addScaledVector(back, this.distance);
    this.camera.lookAt(this.target);
  }

  // Frame a world point from a distance (for "jump to building").
  focus(p: THREE.Vector3, distance?: number): void {
    this.target.copy(p).clamp(this.bounds.min, this.bounds.max);
    if (distance) this.distance = THREE.MathUtils.clamp(distance, this.minDistance, this.maxDistance);
  }
}