// Planes at working airports. Visual only. Each airport flies two airliners half a cycle apart round
// one route:
//
//   hold at the threshold -> take-off roll (accelerating, nose up at the end) -> climb out ->
//   a wide circuit round the whole city, banking into the turns -> approach lined up with the runway
//   -> flare and touch down -> roll out, braking -> taxi back along the taxiway -> hold ...
//
// The ground parts of the route are in the airport model's own frame (runway along X at z = 6, the
// taxiway at z = 2.6, see the airport in models.json), so they follow the airport however it is
// rotated; the circuit is in world space, round the city's centre.

import * as THREE from "three";
import type { City } from "@/sim/city";
import { footprint } from "@/sim/district";
import { defById } from "@/sim/tileDefs";
import { CELL, tilePosition, tileRotation } from "./coords";
import { instantiate } from "./models";

const GROUND_Y = 0.28; // the runway surface in the airport model
const RUNWAY_Z = 6;
const TAXI_Z = 2.6;
const FLY_SPEED = 16; // units/s in the air
const TAXI_SPEED = 3;
const CRUISE_ALT = 42; // well above the tallest towers (~17)
const HOLD = 3; // seconds at the threshold before rolling

interface Leg {
  curve: THREE.Curve<THREE.Vector3>; // world space
  length: number;
  v0: number; // speed at the start and end of the leg (constant acceleration in between)
  v1: number;
  hold: number; // seconds standing still at the start
  air: boolean; // in the air: bank into turns
  noseUp: boolean; // take-off roll: lift the nose over the last stretch
}

export interface Route {
  legs: Leg[];
}

// The full cycle for one airport, built from where the airport is and which way it faces.
export function buildRoute(airport: THREE.Matrix4, cityCentre: THREE.Vector3, radius: number): Route {
  const L = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).applyMatrix4(airport);
  const runwayDir = L(1, 0, 0).sub(L(0, 0, 0)).setY(0).normalize();
  const straight = (a: THREE.Vector3, b: THREE.Vector3) => new THREE.LineCurve3(a, b);
  const smooth = (pts: THREE.Vector3[], divisions: number) => {
    const c = new THREE.CatmullRomCurve3(pts, false, "centripetal");
    c.arcLengthDivisions = divisions;
    return c;
  };

  // --- the flight: lift-off, climb out, round the city, approach, flare, touch down
  const liftoff = L(6, GROUND_Y, RUNWAY_Z);
  const climb = [L(26, 5, RUNWAY_Z), L(55, 15, RUNWAY_Z), L(85, 26, RUNWAY_Z)];
  const approach = [L(-150, 34, RUNWAY_Z), L(-95, 24, RUNWAY_Z), L(-50, 11, RUNWAY_Z), L(-24, 2.2, RUNWAY_Z)];
  const touchdown = L(-13, GROUND_Y, RUNWAY_Z);
  // round the city in the direction the climb-out is already heading, at least ~3/4 of a turn
  const ang = (p: THREE.Vector3) => Math.atan2(p.z - cityCentre.z, p.x - cityCentre.x);
  const a0 = ang(climb[2]);
  const a1 = ang(approach[0]);
  const tangentAt = (a: number, sigma: number) => new THREE.Vector3(-Math.sin(a) * sigma, 0, Math.cos(a) * sigma);
  const sigma = tangentAt(a0, 1).dot(runwayDir) >= 0 ? 1 : -1;
  let sweep = sigma > 0 ? a1 - a0 : a0 - a1;
  while (sweep < 0) sweep += Math.PI * 2;
  if (sweep < Math.PI * 1.5) sweep += Math.PI * 2;
  const circuit: THREE.Vector3[] = [];
  const steps = Math.ceil(sweep / THREE.MathUtils.degToRad(24));
  for (let i = 1; i < steps; i++) {
    const a = a0 + sigma * (sweep * i) / steps;
    circuit.push(new THREE.Vector3(cityCentre.x + Math.cos(a) * radius, CRUISE_ALT + 4 * Math.sin(i * 0.9), cityCentre.z + Math.sin(a) * radius));
  }
  const flight = smooth([liftoff, ...climb, ...circuit, ...approach, touchdown], 4000);

  // --- on the ground: take-off roll, roll-out after landing, taxi back to the threshold
  const start = L(-15, GROUND_Y, RUNWAY_Z);
  const takeoff = straight(start, liftoff);
  const rollout = straight(touchdown, L(8, GROUND_Y, RUNWAY_Z));
  const taxi = smooth(
    [
      L(8, GROUND_Y, RUNWAY_Z), L(9.2, GROUND_Y, 4.7), L(8, GROUND_Y, 3.0), L(5, GROUND_Y, TAXI_Z),
      L(-11, GROUND_Y, TAXI_Z), L(-15, GROUND_Y, 2.9), L(-16.7, GROUND_Y, 4.3), L(-16.3, GROUND_Y, 5.6), start,
    ],
    400,
  );
  const leg = (curve: THREE.Curve<THREE.Vector3>, v0: number, v1: number, extra: Partial<Leg> = {}): Leg => ({
    curve, length: curve.getLength(), v0, v1, hold: 0, air: false, noseUp: false, ...extra,
  });
  return {
    legs: [
      leg(takeoff, 0, FLY_SPEED, { hold: HOLD, noseUp: true }),
      leg(flight, FLY_SPEED, FLY_SPEED, { air: true }),
      leg(rollout, FLY_SPEED, TAXI_SPEED),
      leg(taxi, TAXI_SPEED, TAXI_SPEED),
    ],
  };
}

class Plane {
  readonly group = new THREE.Group();
  leg = 0;
  s = 0; // distance along the leg
  held = 0;
  private bank = 0;
  private lastYaw: number | null = null;
  private readonly strobe: THREE.Mesh;
  private readonly fwd = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly m = new THREE.Matrix4();
  time = 0;

  constructor(readonly route: Route, startLeg: number, startFraction: number) {
    const model = instantiate("airliner", "vehicles");
    this.group.add(model.group);
    // navigation lights: red on the left wingtip, green on the right, a white strobe on the tail
    const lamp = (colour: number, x: number, y: number, z: number) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), new THREE.MeshBasicMaterial({ color: colour }));
      m.position.set(x, y, z);
      this.group.add(m);
      return m;
    };
    lamp(0xff2a2a, -3.15, 1.0, -2.8);
    lamp(0x2aff5a, 3.15, 1.0, -2.8);
    this.strobe = lamp(0xffffff, 0, 2.55, 2.2);
    this.leg = startLeg;
    this.s = route.legs[startLeg].length * startFraction;
    this.held = startFraction > 0 ? route.legs[startLeg].hold : 0;
  }

  private speed(l: Leg): number {
    // constant acceleration over the leg; never quite zero, so a roll from standstill gets going
    const k = l.length > 0 ? Math.min(1, this.s / l.length) : 1;
    return Math.max(0.8, Math.sqrt(Math.max(0, l.v0 * l.v0 + (l.v1 * l.v1 - l.v0 * l.v0) * k)));
  }

  update(dt: number): void {
    this.time += dt;
    let l = this.route.legs[this.leg];
    if (this.held < l.hold) {
      this.held += dt;
    } else {
      this.s += this.speed(l) * dt;
      while (this.s >= l.length) {
        this.s -= l.length;
        this.leg = (this.leg + 1) % this.route.legs.length;
        l = this.route.legs[this.leg];
        this.held = 0;
        if (l.hold > 0) {
          this.s = 0;
          break;
        }
      }
    }
    const u = l.length > 0 ? Math.min(1, this.s / l.length) : 0;
    const pos = l.curve.getPointAt(u);
    this.fwd.copy(l.curve.getTangentAt(u)).normalize();
    // take-off: the nose comes up over the last quarter of the roll
    if (l.noseUp) this.fwd.y += 0.22 * THREE.MathUtils.smoothstep(u, 0.7, 1);
    this.fwd.normalize();
    // bank into turns, from how fast the heading is changing
    const yaw = Math.atan2(this.fwd.x, this.fwd.z);
    let rate = 0;
    if (this.lastYaw !== null && dt > 0) {
      let d = yaw - this.lastYaw;
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      rate = d / dt;
    }
    this.lastYaw = yaw;
    const targetBank = l.air ? THREE.MathUtils.clamp(-rate * 1.1, -0.65, 0.65) : 0;
    this.bank += (targetBank - this.bank) * Math.min(1, dt * 2.5);
    this.up.set(0, 1, 0).applyAxisAngle(this.fwd, this.bank);
    // the model's front is -Z: lookAt puts -Z along the direction of travel
    this.m.lookAt(pos, pos.clone().add(this.fwd), this.up);
    this.group.quaternion.setFromRotationMatrix(this.m);
    this.group.position.copy(pos);
    this.strobe.visible = this.time % 1.1 < 0.09;
  }

  get altitude(): number {
    return this.group.position.y;
  }
}

export class AirTraffic {
  readonly group = new THREE.Group();
  private readonly airports = new Map<number, { key: string; planes: Plane[] }>();

  constructor(private readonly city: City) {}

  // Call when the city changes: planes for every working airport, none for the rest.
  sync(): void {
    const d = this.city.district;
    const extent = d.size * CELL;
    const centre = new THREE.Vector3(extent / 2, 0, extent / 2);
    const radius = extent * 0.62;
    const seen = new Set<number>();
    for (const t of d.tiles.values()) {
      const def = defById(t.id);
      if (def.key !== "airport") continue;
      const working = t.active && t.powered && !t.event && !t.needs.includes("parking");
      if (!working) continue;
      seen.add(t.anchor);
      const key = `${t.x},${t.y},${t.rot}`;
      const have = this.airports.get(t.anchor);
      if (have && have.key === key) continue;
      if (have) for (const p of have.planes) this.group.remove(p.group);
      const [w, h] = footprint(def, t.rot);
      const m = new THREE.Matrix4().compose(tilePosition(t.x, t.y, w, h), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), tileRotation(t.rot)), new THREE.Vector3(1, 1, 1));
      const route = buildRoute(m, centre, radius);
      // two planes half a cycle apart: one on the runway, one far out over the city
      const planes = [new Plane(route, 0, 0), new Plane(route, 1, 0.45)];
      for (const p of planes) this.group.add(p.group);
      this.airports.set(t.anchor, { key, planes });
    }
    for (const [anchor, a] of this.airports) {
      if (seen.has(anchor)) continue;
      for (const p of a.planes) this.group.remove(p.group);
      this.airports.delete(anchor);
    }
  }

  update(dt: number): void {
    for (const a of this.airports.values()) for (const p of a.planes) p.update(dt);
  }

  clear(): void {
    for (const a of this.airports.values()) for (const p of a.planes) this.group.remove(p.group);
    this.airports.clear();
  }

  // For tests: each plane's leg and position.
  planes(): { leg: number; altitude: number; position: THREE.Vector3 }[] {
    const out: { leg: number; altitude: number; position: THREE.Vector3 }[] = [];
    for (const a of this.airports.values()) for (const p of a.planes) out.push({ leg: p.leg, altitude: p.altitude, position: p.group.position.clone() });
    return out;
  }
}