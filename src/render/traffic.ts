// Cosmetic life: cars driving the road network and people walking its sidewalks. Nothing here
// touches the simulation; counts follow the report (trips for cars, residents for people).
//
// Cars drive on the right. Inside a road cell a car follows a curve from the middle of the edge it
// came in by to the middle of the edge it leaves by, offset into its lane, so turns are arcs and a
// dead end is a U-turn inside the cell. Spacing is by position: a car never closes within its own
// half-length + the other's half-length + GAP of whatever is ahead of it in its lane.
// Junctions and dead ends: a car goes in only if its path through the cell keeps clear of every car
// already inside (opposite straights and right turns can share), nobody who has waited longer wants a
// crossing path, and there is room to leave on the far side (don't block the box). A car that hasn't
// moved for STUCK seconds is quietly taken off the road and the spawner puts one back somewhere free:
// cars never drive through each other. Jammed roads crawl.

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { City } from "@/sim/city";
import { coords, index, inBounds, isRoadId } from "@/sim/district";
import { defById } from "@/sim/tileDefs";
import { CELL, cellCentre } from "./coords";
import { instantiate, plainMaterial } from "./models";
import { surfaceHeight, type RoadTier } from "./roads";

const CAR_KEYS = ["sedan", "hatchback", "taxi", "van", "pickup", "truck", "bus", "police", "sedan", "hatchback"];
const CAR_SPEED = 3.2; // units per second
const CAR_SCALE = 0.85;
const LANE = 0.95; // right-hand lane offset from the road's centre line
const GAP = 0.6; // bumper to bumper
const LOOK = 8; // how far ahead a car looks for the one in front
const STUCK = 8; // seconds refused entry to a junction before a car is taken off the road (its queue then moves)
const STUCK_ANY = 25; // seconds without moving at all, for any other reason
const CLEAR = 1.5; // two paths through a junction closer than this cross
const DENSITY = 0.35; // at most this many cars per reachable road cell
const WALK_SPEED = 1.6;
const SIDEWALK = 1.75;
const MAX_CARS = 70;
const MAX_PEOPLE = 90;

type V = THREE.Vector3;

interface Car {
  obj: THREE.Object3D;
  len: number;
  prev: number; // cell it came from
  cur: number; // cell it's in
  next: number; // cell it's heading to
  after: number; // and the one after that (to plan the way through a junction)
  s: number; // 0..1 through `cur`
  speed: number;
  path: [V, V, V, V]; // cubic Bézier through `cur`
  pathLen: number;
  pos: V;
  dir: V;
  waited: number; // at a junction edge
  stuck: number; // without moving at all (queues behind a waiting car are normal; see STUCK_ANY)
  committed: number; // the junction it has been let into, before its centre crosses the edge (-1: none)
  commitPath: [V, V, V, V] | null; // its way through that junction
}

interface Walker {
  obj: THREE.Object3D;
  from: number;
  to: number;
  t: number;
  speed: number;
  offset: number;
}

// A small person: legs, a coloured shirt, a head. Six shirt colours, built once.
const SHIRTS = [0xe05a4e, 0x3b8ed0, 0xf2c14e, 0x59b36a, 0x8e6bd6, 0xf08a4b];
const personGeo: THREE.BufferGeometry[] = [];
function personGeometry(variant: number): THREE.BufferGeometry {
  if (personGeo[variant]) return personGeo[variant];
  const part = (w: number, h: number, d: number, y: number, colour: number) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.deleteAttribute("uv");
    const c = new THREE.Color(colour);
    const n = g.getAttribute("position").count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
    }
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.translate(0, y, 0);
    return g.toNonIndexed();
  };
  const g = mergeGeometries([part(0.42, 0.5, 0.26, 0.25, 0x2f3a4a), part(0.5, 0.55, 0.3, 0.78, SHIRTS[variant]), part(0.34, 0.34, 0.34, 1.25, 0xf1c9a5)], false)!;
  personGeo[variant] = g;
  return g;
}

const carLength = new Map<string, number>();

function bezier(p: [V, V, V, V], s: number, out: V): V {
  const u = 1 - s;
  return out
    .copy(p[0]).multiplyScalar(u * u * u)
    .addScaledVector(p[1], 3 * u * u * s)
    .addScaledVector(p[2], 3 * u * s * s)
    .addScaledVector(p[3], s * s * s);
}

function bezierDir(p: [V, V, V, V], s: number, out: V): V {
  const u = 1 - s;
  out.set(0, 0, 0)
    .addScaledVector(p[1].clone().sub(p[0]), 3 * u * u)
    .addScaledVector(p[2].clone().sub(p[1]), 6 * u * s)
    .addScaledVector(p[3].clone().sub(p[2]), 3 * s * s);
  out.y = 0;
  return out.lengthSq() > 1e-8 ? out.normalize() : out.set(0, 0, 1);
}

export class Traffic {
  readonly group = new THREE.Group();
  private cars: Car[] = [];
  private people: Walker[] = [];
  private roads: number[] = [];
  private targetCars = 0;
  private targetPeople = 0;
  private spawnTimer = 0;
  private adj = new Map<number, number[]>(); // reachable road cell -> its reachable road neighbours
  removed = 0; // cars taken off for being stuck (tests watch this)
  private fading: { obj: THREE.Object3D; t: number }[] = []; // removed cars shrinking away

  constructor(private readonly city: City) {
    this.refresh();
  }

  // Call after any change to the city: the road network or the counts may have moved.
  refresh(): void {
    const d = this.city.district;
    this.roads = [];
    for (const t of d.tiles.values()) if (isRoadId(t.id) && t.reachable) this.roads.push(t.anchor);
    this.adj.clear();
    for (const cell of this.roads) this.adj.set(cell, this.scanNeighbours(cell));
    const r = this.city.report;
    this.targetCars = this.roads.length < 3 ? 0 : Math.min(MAX_CARS, Math.ceil(r.traffic.trips / 2), Math.floor(this.roads.length * DENSITY));
    this.targetPeople = this.roads.length < 2 ? 0 : Math.min(MAX_PEOPLE, Math.floor(r.population / 2.5));
    for (const c of [...this.cars]) {
      if (!this.isRoad(c.prev) || !this.isRoad(c.cur) || !this.isRoad(c.next) || !this.isRoad(c.after)) this.removeCar(c);
    }
    this.people = this.people.filter((w) => {
      if (this.isRoad(w.from) && this.isRoad(w.to)) return true;
      this.group.remove(w.obj);
      return false;
    });
  }

  private isRoad(cell: number): boolean {
    const t = this.city.district.tiles.get(cell);
    return t !== undefined && isRoadId(t.id) && t.reachable;
  }

  private neighbours(cell: number): number[] {
    return this.adj.get(cell) ?? [];
  }

  private scanNeighbours(cell: number): number[] {
    const d = this.city.district;
    const [x, y] = coords(d.size, cell);
    const out: number[] = [];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (inBounds(d.size, nx, ny) && this.isRoad(index(d.size, nx, ny))) out.push(index(d.size, nx, ny));
    }
    return out;
  }

  // Straights and bends let both directions pass; anything else takes one side at a time.
  private isExclusive(cell: number): boolean {
    return this.neighbours(cell).length !== 2;
  }

  private chooseNext(cur: number, prev: number): number {
    const all = this.neighbours(cur);
    const forward = all.filter((n) => n !== prev);
    const pool = forward.length ? forward : all;
    return pool.length ? pool[Math.floor(Math.random() * pool.length)] : prev;
  }

  private centre(cell: number): V {
    const [x, y] = coords(this.city.district.size, cell);
    return cellCentre(x, y, new THREE.Vector3());
  }

  private buildPath(c: Car): void {
    const p = this.makePath(c.prev, c.cur, c.next);
    c.path = p.path;
    c.pathLen = p.len;
  }

  // The lane curve through `cur`, coming from `prev` and leaving toward `next`.
  private makePath(prev: number, cur: number, next: number): { path: [V, V, V, V]; len: number } {
    const cp = this.centre(prev);
    const cc = this.centre(cur);
    const cn = this.centre(next);
    const dirIn = cc.clone().sub(cp).normalize();
    const dirOut = cn.clone().sub(cc).normalize();
    const rightIn = new THREE.Vector3(-dirIn.z, 0, dirIn.x);
    const rightOut = new THREE.Vector3(-dirOut.z, 0, dirOut.x);
    const q0 = cp.clone().add(cc).multiplyScalar(0.5).addScaledVector(rightIn, LANE);
    const q3 = cc.clone().add(cn).multiplyScalar(0.5).addScaledVector(rightOut, LANE);
    const dot = dirIn.dot(dirOut);
    let k: number;
    if (dot > 0.5) k = CELL / 3; // straight on
    else if (dot < -0.5) k = 1.6; // U-turn inside the cell
    else {
      const right = dirIn.x * dirOut.z - dirIn.z * dirOut.x > 0;
      k = 0.552 * (CELL / 2 + (right ? -LANE : LANE)); // quarter-circle arc, inner or outer lane
    }
    const q1 = q0.clone().addScaledVector(dirIn, k);
    const q2 = q3.clone().addScaledVector(dirOut, -k);
    const path: [V, V, V, V] = [q0, q1, q2, q3];
    // length by sampling: good enough for a constant on-screen speed
    let len = 0;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    bezier(path, 0, a);
    for (let i = 1; i <= 8; i++) {
      bezier(path, i / 8, b);
      len += a.distanceTo(b);
      a.copy(b);
    }
    return { path, len: Math.max(len, 0.5) };
  }

  // Do the rest of path a (from sa) and the rest of path b (from sb) come within CLEAR of each other?
  private crosses(a: [V, V, V, V], sa: number, b: [V, V, V, V], sb: number): boolean {
    const pa = this.tmpA;
    const pb = this.tmpB;
    for (let i = 0; i <= 6; i++) {
      bezier(a, sa + ((1 - sa) * i) / 6, pa);
      for (let j = 0; j <= 6; j++) {
        bezier(b, sb + ((1 - sb) * j) / 6, pb);
        if (Math.abs(pa.x - pb.x) < CLEAR && Math.abs(pa.z - pb.z) < CLEAR && pa.distanceTo(pb) < CLEAR) return true;
      }
    }
    return false;
  }

  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();

  // May `c` drive from its cell into `c.next`? Straights and bends always (the car ahead is handled by
  // spacing); junctions and dead ends only when its way through is clear and it can get out again.
  private canEnter(c: Car): boolean {
    const j = c.next;
    const mine = this.makePath(c.cur, j, c.after).path;
    for (const o of this.cars) {
      if (o === c) continue;
      // inside (or let in): its way through must not cross ours. Cars that came in the way we will are
      // simply ahead of us in the lane.
      if (o.cur === j && o.prev !== c.cur && this.crosses(mine, 0, o.path, o.s)) return false;
      if (o.committed === j && o.cur !== c.cur && this.crosses(mine, 0, o.commitPath!, 0)) return false;
      // just out, but its tail is still in the junction
      if (o.prev === j && o.s * o.pathLen < o.len / 2 + 0.3 && this.near(mine, o.pos, o.len / 2 + 0.9)) return false;
      // waiting at another edge for longer, on a crossing path
      if (o.next === j && o.cur !== c.cur && o.committed !== j && o.waited > c.waited + 0.3 && o.s > 0.5 && this.crosses(mine, 0, this.makePath(o.cur, j, o.after).path, 0)) return false;
      // don't block the box: the lane out must have room for us
      if (o.cur === c.after && o.prev === j && o.s * o.pathLen < c.len + GAP + 0.3) return false;
    }
    return true;
  }

  private near(path: [V, V, V, V], p: V, r: number): boolean {
    for (let i = 0; i <= 8; i++) if (bezier(path, i / 8, this.tmpA).distanceTo(p) < r) return true;
    return false;
  }

  private removeCar(c: Car): void {
    this.group.remove(c.obj);
    this.cars.splice(this.cars.indexOf(c), 1);
  }

  private spawnCar(): void {
    if (this.roads.length < 2) return;
    const cur = this.roads[Math.floor(Math.random() * this.roads.length)];
    if (this.isExclusive(cur)) return; // never appear in the middle of a junction
    const ns = this.neighbours(cur);
    if (!ns.length) return;
    const prev = ns[Math.floor(Math.random() * ns.length)];
    const key = CAR_KEYS[Math.floor(Math.random() * CAR_KEYS.length)];
    const inst = instantiate(key, "vehicles");
    inst.group.scale.setScalar(CAR_SCALE);
    if (!carLength.has(key)) carLength.set(key, new THREE.Box3().setFromObject(inst.group).getSize(new THREE.Vector3()).z);
    const next = this.chooseNext(cur, prev);
    const c: Car = {
      obj: inst.group, len: carLength.get(key)!, prev, cur, next, after: this.chooseNext(next, cur), s: 0,
      speed: CAR_SPEED * (0.85 + Math.random() * 0.3), path: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()],
      pathLen: CELL, pos: new THREE.Vector3(), dir: new THREE.Vector3(0, 0, 1), waited: 0, stuck: 0, committed: -1, commitPath: null,
    };
    this.buildPath(c);
    bezier(c.path, 0, c.pos);
    for (const o of this.cars) if (o.pos.distanceTo(c.pos) < (o.len + c.len) / 2 + GAP + 0.5) return; // no room here
    bezierDir(c.path, 0, c.dir);
    this.cars.push(c);
    this.group.add(c.obj);
    this.place(c);
  }

  // The driving surface under a cell: land roads are low, bridge decks higher.
  private deck(cell: number): number {
    const t = this.city.district.tiles.get(cell);
    return t ? surfaceHeight(defById(t.id).key as RoadTier) : 0.2;
  }

  private place(c: Car): void {
    // ride up onto a bridge over the half-cell before it, not with a jump at the edge
    const y = c.s < 0.5 ? this.deck(c.prev) + (this.deck(c.cur) - this.deck(c.prev)) * (c.s + 0.5) : this.deck(c.cur) + (this.deck(c.next) - this.deck(c.cur)) * (c.s - 0.5);
    c.obj.position.set(c.pos.x, y + 0.05, c.pos.z);
    c.obj.rotation.y = Math.atan2(-c.dir.x, -c.dir.z);
  }

  // How far `c` may move before touching whatever is ahead of it in its lane.
  private room(c: Car): number {
    let room = Infinity;
    for (const o of this.cars) {
      if (o === c) continue;
      const dx = o.pos.x - c.pos.x;
      const dz = o.pos.z - c.pos.z;
      const along = dx * c.dir.x + dz * c.dir.z;
      if (along <= 0 || along > LOOK) continue;
      const lateral = Math.abs(dx * c.dir.z - dz * c.dir.x);
      if (lateral > 1.15) continue; // other lane
      if (o.dir.x * c.dir.x + o.dir.z * c.dir.z < -0.5) continue; // oncoming: always in the other lane (seen mid-turn it can look ahead)
      room = Math.min(room, along - (c.len + o.len) / 2 - GAP);
    }
    return room;
  }

  // Returns false when the car was taken off the road.
  private stepCar(c: Car, dt: number): boolean {
    const road = this.city.district.tiles.get(c.cur);
    let speed = c.speed;
    if (road?.jammed) speed *= 0.3;
    else if (road && road.load > defById(road.id).roadCapacity * 0.7) speed *= 0.6;
    let move = Math.min(speed * dt, Math.max(0, this.room(c)));
    const moved = move > 1e-4;
    while (move > 0) {
      // a junction ahead: stop with the front bumper at its edge unless we're let in
      if (c.committed !== c.next && this.isExclusive(c.next)) {
        const stopS = Math.max(0, 1 - (c.len / 2 + 0.2) / c.pathLen);
        if (c.s + move / c.pathLen >= stopS) {
          if (!this.canEnter(c)) {
            if (c.s < stopS) c.s = stopS;
            c.waited += dt;
            break;
          }
          c.committed = c.next;
          c.commitPath = this.makePath(c.cur, c.next, c.after).path;
        }
      }
      const left = (1 - c.s) * c.pathLen;
      if (move < left) {
        c.s += move / c.pathLen;
        break;
      }
      move -= left;
      c.waited = 0;
      c.committed = -1;
      c.commitPath = null;
      c.prev = c.cur;
      c.cur = c.next;
      c.next = c.after;
      c.after = this.chooseNext(c.next, c.cur);
      c.s = 0;
      this.buildPath(c);
    }
    c.stuck = moved ? 0 : c.stuck + dt;
    if (c.waited > STUCK || c.stuck > STUCK_ANY) {
      this.cars.splice(this.cars.indexOf(c), 1); // off the road at once; the model shrinks away
      this.fading.push({ obj: c.obj, t: 0.5 });
      this.removed++;
      return false;
    }
    bezier(c.path, c.s, c.pos);
    bezierDir(c.path, c.s, c.dir);
    this.place(c);
    return true;
  }

  // ---------------------------------------------------------------------------------------------
  // people: a simple walk along the sidewalks, either side of the road
  // ---------------------------------------------------------------------------------------------
  private spawnWalker(): void {
    if (this.roads.length < 2) return;
    const from = this.roads[Math.floor(Math.random() * this.roads.length)];
    const ns = this.neighbours(from);
    if (!ns.length) return;
    const m = new THREE.Mesh(personGeometry(Math.floor(Math.random() * SHIRTS.length)), plainMaterial);
    m.castShadow = true;
    m.scale.setScalar(0.8);
    this.group.add(m);
    this.people.push({ obj: m, from, to: ns[Math.floor(Math.random() * ns.length)], t: Math.random(), speed: WALK_SPEED * (0.7 + Math.random() * 0.6), offset: Math.random() < 0.5 ? SIDEWALK : -SIDEWALK });
  }

  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();

  private stepWalker(w: Walker, dt: number): void {
    w.t += (w.speed * dt) / CELL;
    while (w.t >= 1) {
      w.t -= 1;
      const next = this.chooseNext(w.to, w.from);
      w.from = w.to;
      w.to = next;
      if (!this.isRoad(w.to)) return;
    }
    const d = this.city.district;
    const [fx, fy] = coords(d.size, w.from);
    const [tx, ty] = coords(d.size, w.to);
    cellCentre(fx, fy, this.a);
    cellCentre(tx, ty, this.b);
    const dx = this.b.x - this.a.x;
    const dz = this.b.z - this.a.z;
    const l = Math.hypot(dx, dz) || 1;
    w.obj.position.lerpVectors(this.a, this.b, w.t);
    w.obj.position.x += (-dz / l) * w.offset;
    w.obj.position.z += (dx / l) * w.offset;
    w.obj.position.y = this.deck(w.t < 0.5 ? w.from : w.to) + Math.abs(Math.sin(w.t * 24)) * 0.06; // a little bob while walking
    w.obj.rotation.y = Math.atan2(-dx, -dz);
  }

  update(dt: number): void {
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = 0.25;
      if (this.cars.length < this.targetCars) this.spawnCar();
      else if (this.cars.length > this.targetCars) this.removeCar(this.cars[this.cars.length - 1]);
      if (this.people.length < this.targetPeople) this.spawnWalker();
      else if (this.people.length > this.targetPeople) this.group.remove(this.people.pop()!.obj);
    }
    for (const c of [...this.cars]) this.stepCar(c, dt);
    for (const f of this.fading) {
      f.t -= dt;
      f.obj.scale.setScalar(CAR_SCALE * Math.max(0, f.t / 0.5));
      if (f.t <= 0) this.group.remove(f.obj);
    }
    this.fading = this.fading.filter((f) => f.t > 0);
    for (const w of this.people) this.stepWalker(w, dt);
  }
}