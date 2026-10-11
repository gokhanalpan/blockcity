// Keeps the scene in step with the City. Reads game state, never writes it. Tiles are model
// instances on shared geometry; roads are one mesh each on a per-shape geometry; land you don't own
// is an overlay; labels hang over buildings that need something and over chunks for sale.

import * as THREE from "three";
import { City, type Change } from "@/sim/city";
import { coords, index, inBounds, isRoadId, landPrice, chunkCount, footprint, neighbours, type Tile } from "@/sim/district";
import { defById, defByKey, isRuins, type TileDef } from "@/sim/tileDefs";
import { CELL, cellCentre, tilePosition, tileRotation } from "./coords";
import { instantiate, type ModelInstance } from "./models";
import { ROAD_DIRS, pulseJammedRoads, roadGeometry, roadMaterial, roadTint, type RoadTier } from "./roads";
import { LandOverlay, buildTerrain, type Terrain } from "./terrain";
import { FireLayer, type FireSource } from "./fire";
import { AirTraffic } from "./aviation";
import { areaMesh, coverageCells, coverageOf, disposeArea } from "./coverage";
import { EVENTS } from "@/config/tuning";
import type { Labels } from "./labels";
import { ECONOMY } from "@/config/tuning";

const ghostOk = new THREE.MeshLambertMaterial({ vertexColors: true, color: 0xb0ffb0, transparent: true, opacity: 0.55, depthWrite: false });
const ghostBad = new THREE.MeshLambertMaterial({ vertexColors: true, color: 0xff8a8a, transparent: true, opacity: 0.55, depthWrite: false });
const footOk = new THREE.MeshBasicMaterial({ color: 0x40d060, transparent: true, opacity: 0.35, depthWrite: false });
const footBad = new THREE.MeshBasicMaterial({ color: 0xe04040, transparent: true, opacity: 0.35, depthWrite: false });
const selectMat = new THREE.LineBasicMaterial({ color: 0xffd040 });

const EVENT_ICON: Record<string, string> = { burning: "🔥", blackout: "⚡", crash: "💥", storm: "🌊", crime: "🚔" };

interface TileView {
  tile: Tile;
  group: THREE.Group;
  inst?: ModelInstance; // buildings
  road?: THREE.Mesh; // roads
  tier?: RoadTier;
  mask?: number;
}

export class WorldView {
  readonly group = new THREE.Group();
  terrain: Terrain;
  readonly land: LandOverlay;
  private readonly views = new Map<number, TileView>();
  private ghost: { key: string; inst: ModelInstance; foot: THREE.Mesh; reach: THREE.Group | null; reachAt: string } | null = null;
  private coverage: { anchor: number; mesh: THREE.Group } | null = null; // the selected building's reach
  private selection: THREE.LineSegments | null = null;
  private rotors: { mesh: THREE.Mesh; tile: Tile }[] = [];
  private unsubscribe: () => void;
  readonly fires = new FireLayer();
  readonly air: AirTraffic;
  private clock = 0;

  constructor(readonly city: City, private readonly labels: Labels) {
    this.air = new AirTraffic(city);
    this.terrain = buildTerrain(city.district);
    this.group.add(this.terrain.group);
    this.land = new LandOverlay(city.district.size);
    this.group.add(this.land.group);
    this.group.add(this.fires.group);
    this.group.add(this.air.group);
    this.syncAll();
    this.unsubscribe = city.onChange((c) => this.apply(c));
  }

  dispose(): void {
    this.unsubscribe();
    this.terrain.dispose();
    this.labels.removeWhere(() => true);
  }

  get ground(): THREE.Mesh {
    return this.terrain.ground;
  }

  // The model of every tile (each group carries userData.anchor), for clicking a building itself.
  tileObjects(): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    for (const v of this.views.values()) out.push(v.group);
    return out;
  }

  get chunkMeshes(): THREE.Object3D[] {
    return this.land.group.children;
  }

  // -------------------------------------------------------------------------------------------
  // sync
  // -------------------------------------------------------------------------------------------
  syncAll(): void {
    for (const v of this.views.values()) this.group.remove(v.group);
    this.views.clear();
    this.rotors = [];
    for (const t of this.city.district.tiles.values()) this.addTile(t);
    this.refreshRoadsAround([...this.city.district.tiles.keys()]);
    this.refreshStates();
    this.refreshLand();
  }

  private apply(c: Change): void {
    if (c.kind === "load") {
      this.fires.clear();
      this.air.clear();
      this.group.remove(this.terrain.group);
      this.terrain.dispose();
      this.terrain = buildTerrain(this.city.district);
      this.group.add(this.terrain.group);
      this.syncAll();
      return;
    }
    if (c.kind === "place" || c.kind === "remove" || c.kind === "tick") {
      // tiles gone
      for (const anchor of c.anchors ?? []) {
        const v = this.views.get(anchor);
        if (v && !this.city.district.tiles.has(anchor)) this.removeView(anchor);
        else if (v && this.city.district.tiles.get(anchor) !== v.tile) this.removeView(anchor); // replaced in place
      }
      // tiles new (a road upgrade reuses the anchor; a burn-down puts ruins on the same anchor)
      for (const t of this.city.district.tiles.values()) if (!this.views.has(t.anchor)) this.addTile(t);
      if (c.cells) this.refreshRoadsAround(c.cells);
    }
    if (c.kind === "land") this.refreshLand();
    this.refreshStates();
  }

  private removeView(anchor: number): void {
    const v = this.views.get(anchor);
    if (!v) return;
    if (this.wreck?.anchor === anchor) this.markDemolish(null);
    if (this.coverage?.anchor === anchor) this.showCoverage(null);
    this.group.remove(v.group);
    this.views.delete(anchor);
    this.rotors = this.rotors.filter((r) => r.tile !== v.tile);
    this.labels.remove(`t${anchor}`);
  }

  private addTile(t: Tile): void {
    const def = defById(t.id);
    const group = new THREE.Group();
    const view: TileView = { tile: t, group };
    if (isRoadId(t.id)) {
      view.tier = def.key as RoadTier;
      view.mask = -1; // decorated by refreshRoadsAround
      const mesh = new THREE.Mesh(roadGeometry(view.tier, 0), roadMaterial);
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      view.road = mesh;
      group.add(mesh);
      group.position.copy(cellCentre(t.x, t.y));
    } else {
      const inst = instantiate(def.key);
      view.inst = inst;
      group.add(inst.group);
      const [w, h] = footprint(def, t.rot);
      group.position.copy(tilePosition(t.x, t.y, w, h));
      group.rotation.y = tileRotation(t.rot);
      if (inst.rotor) this.rotors.push({ mesh: inst.rotor, tile: t });
    }
    group.userData.anchor = t.anchor;
    this.group.add(group);
    this.views.set(t.anchor, view);
  }

  private roadMask(t: Tile): number {
    const d = this.city.district;
    const entrance = this.city.entrance.includes(t.anchor);
    let mask = 0;
    ROAD_DIRS.forEach(([dx, dy], i) => {
      const nx = t.x + dx;
      const ny = t.y + dy;
      let ok = false;
      if (inBounds(d.size, nx, ny)) {
        const n = d.tiles.get(index(d.size, nx, ny));
        ok = n !== undefined && isRoadId(n.id);
      } else if (entrance && dy === -1) {
        ok = true; // the entrance continues onto the main road outside the island
      }
      if (ok) mask |= 1 << i;
    });
    return mask;
  }

  private refreshRoadsAround(cells: number[]): void {
    const d = this.city.district;
    const seen = new Set<number>();
    const touch = (c: number) => {
      const anchor = d.occupied.get(c);
      if (anchor === undefined || seen.has(anchor)) return;
      seen.add(anchor);
      const v = this.views.get(anchor);
      if (!v || !v.road || !v.tier) return;
      const mask = this.roadMask(v.tile);
      if (mask !== v.mask) {
        v.mask = mask;
        v.road.geometry = roadGeometry(v.tier, mask);
      }
    };
    for (const c of cells) touch(c);
    for (const n of neighbours(d.size, cells)) touch(n);
  }

  // Per-tick visuals: faded buildings, road tints, labels.
  refreshStates(): void {
    for (const v of this.views.values()) {
      const t = v.tile;
      const def = defById(t.id);
      if (v.road) {
        v.road.material = roadTint(t.load, def.roadCapacity, t.jammed);
        if (t.event === "crash") this.labels.set(`t${t.anchor}`, this.labelPos(t, 1.5), EVENT_ICON.crash, "badge");
        else this.labels.remove(`t${t.anchor}`);
        continue;
      }
      // buildings stay solid whatever they lack, as in Roblox: the badge over them says what's wrong
      const html = this.tileLabel(t, def);
      if (html) this.labels.set(`t${t.anchor}`, this.labelPos(t, (v.inst?.height ?? 2) + 0.8), html, t.event ? "badge bad" : t.needs.length ? "badge warn" : "badge");
      else this.labels.remove(`t${t.anchor}`);
    }
    this.syncFires();
    this.air.sync(); // planes at every working airport
  }

  // Tell the fire layer which buildings burn, how hot, and whether (and from where) a station fights it.
  private syncFires(): void {
    const sources: FireSource[] = [];
    for (const e of this.city.events.events) {
      if (e.kind !== "fire" || e.anchor === undefined) continue;
      const v = this.views.get(e.anchor);
      if (!v || !v.inst) continue;
      const t = v.tile;
      const [w, h] = footprint(defById(t.id), t.rot);
      const centre = tilePosition(t.x, t.y, w, h);
      // the fire grows over its countdown: half strength when it starts, full when it's about to win
      const heat = 0.5 + 0.5 * Math.min(1, Math.max(0, 1 - e.ticksLeft / EVENTS.FIRE_TICKS));
      sources.push({
        anchor: e.anchor,
        centre,
        width: w * CELL,
        depth: h * CELL,
        height: v.inst.height,
        heat,
        fighting: e.fighting === true,
        sprayFrom: e.fighting ? this.sprayOrigin(centre, Math.max(w, h) * CELL) : null,
      });
    }
    this.fires.sync(sources, (anchor) => {
      const t = this.city.district.tiles.get(anchor);
      return t !== undefined && isRuins(defById(t.id));
    });
  }

  // The water comes from the side of the nearest working fire station, from just outside the building.
  private sprayOrigin(centre: THREE.Vector3, size: number): THREE.Vector3 {
    let best: THREE.Vector3 | null = null;
    let bestD = Infinity;
    for (const t of this.city.district.tiles.values()) {
      const def = defById(t.id);
      if (def.key !== "fire_station" || !t.active || !t.powered) continue;
      const [w, h] = footprint(def, t.rot);
      const p = tilePosition(t.x, t.y, w, h);
      const d = p.distanceToSquared(centre);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    const dir = best ? best.clone().sub(centre).setY(0) : new THREE.Vector3(-1, 0, -1);
    if (dir.lengthSq() < 1e-6) dir.set(-1, 0, -1);
    dir.normalize();
    return centre.clone().addScaledVector(dir, size / 2 + 4).setY(0.8);
  }

  private tileLabel(t: Tile, def: TileDef): string {
    if (t.event) return EVENT_ICON[t.event] ?? "!";
    if (def.population > 0) return `${t.occ}/${def.population}${t.needs.length ? " !" : ""}`;
    if (t.needs.length) return "!";
    return "";
  }

  private labelPos(t: Tile, y: number): THREE.Vector3 {
    const [w, h] = footprint(defById(t.id), t.rot);
    return tilePosition(t.x, t.y, w, h).setY(y);
  }

  refreshLand(): void {
    const d = this.city.district;
    const buyable = this.land.update(d);
    this.labels.removeWhere((id) => id.startsWith("c"));
    const price = landPrice(chunkCount(d));
    for (const ci of buyable) this.labels.set(`c${ci}`, this.land.chunkCentre(ci).setY(1), `$${price.toLocaleString()}`, "price");
  }

  // -------------------------------------------------------------------------------------------
  // ghost preview and selection
  // -------------------------------------------------------------------------------------------
  showGhost(key: string, x: number, y: number, rot: number, valid: boolean): void {
    const def = defByKey(key);
    if (!this.ghost || this.ghost.key !== key) {
      this.clearGhost();
      const inst = instantiate(key, "tiles", true);
      const foot = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), footOk);
      foot.rotation.x = -Math.PI / 2;
      this.ghost = { key, inst, foot, reach: null, reachAt: "" };
      this.group.add(inst.group, foot);
    }
    const g = this.ghost;
    const [w, h] = footprint(def, rot);
    const pos = tilePosition(x, y, w, h);
    g.inst.group.position.copy(pos);
    g.inst.group.rotation.y = tileRotation(rot);
    for (const child of g.inst.group.children) (child as THREE.Mesh).material = valid ? ghostOk : ghostBad;
    g.foot.position.copy(pos).setY(0.12);
    g.foot.scale.set(w * CELL, h * CELL, 1);
    g.foot.material = valid ? footOk : footBad;
    // what it would reach from here, in its colour (rebuilt only when the footprint moves)
    const cover = coverageOf(def);
    const at = `${x},${y},${rot}`;
    if (cover && g.reachAt !== at) {
      if (g.reach) {
        this.group.remove(g.reach);
        disposeArea(g.reach);
      }
      g.reach = areaMesh(coverageCells(x, y, w, h, cover.radius, this.city.district.size), cover.kind, false);
      g.reachAt = at;
      this.group.add(g.reach);
    }
  }

  clearGhost(): void {
    if (!this.ghost) return;
    this.group.remove(this.ghost.inst.group, this.ghost.foot);
    if (this.ghost.reach) {
      this.group.remove(this.ghost.reach);
      disposeArea(this.ghost.reach);
    }
    this.ghost = null;
  }

  select(anchor: number | null): void {
    if (this.selection) {
      this.group.remove(this.selection);
      this.selection = null;
    }
    this.showCoverage(null);
    if (anchor === null) return;
    const t = this.city.district.tiles.get(anchor);
    if (!t) return;
    const def = defById(t.id);
    const [w, h] = footprint(def, t.rot);
    const box = new THREE.BoxGeometry(w * CELL + 0.3, 0.3, h * CELL + 0.3);
    this.selection = new THREE.LineSegments(new THREE.EdgesGeometry(box), selectMat);
    this.selection.position.copy(tilePosition(t.x, t.y, w, h)).setY(0.3);
    this.group.add(this.selection);
    this.showCoverage(anchor);
  }

  // Shade the ground a selected service (police, clinic, park, car park, a polluter's smoke...) reaches.
  private showCoverage(anchor: number | null): void {
    if (this.coverage) {
      this.group.remove(this.coverage.mesh);
      disposeArea(this.coverage.mesh);
      this.coverage = null;
    }
    if (anchor === null) return;
    const t = this.city.district.tiles.get(anchor);
    if (!t) return;
    const def = defById(t.id);
    const cover = coverageOf(def);
    if (!cover) return;
    const [w, h] = footprint(def, t.rot);
    const mesh = areaMesh(coverageCells(t.x, t.y, w, h, cover.radius, this.city.district.size), cover.kind, true);
    this.group.add(mesh);
    this.coverage = { anchor, mesh };
  }

  // Red box around a building the Demolish tool points at ("hover") or has asked to confirm ("armed").
  private wreck: { anchor: number; box: THREE.Mesh; edges: THREE.LineSegments; armed: boolean } | null = null;
  private readonly wreckFill = new THREE.MeshBasicMaterial({ color: 0xff3b30, transparent: true, opacity: 0.22, depthWrite: false });
  private readonly wreckLine = new THREE.LineBasicMaterial({ color: 0xff3b30 });
  private wreckTime = 0;

  markDemolish(anchor: number | null, armed = false): void {
    if (this.wreck && (this.wreck.anchor !== anchor || anchor === null)) {
      this.group.remove(this.wreck.box, this.wreck.edges);
      this.wreck.box.geometry.dispose();
      this.wreck.edges.geometry.dispose();
      this.wreck = null;
    }
    if (anchor === null) return;
    if (this.wreck) {
      this.wreck.armed = armed;
      return;
    }
    const t = this.city.district.tiles.get(anchor);
    const v = this.views.get(anchor);
    if (!t || !v) return;
    const [w, h] = footprint(defById(t.id), t.rot);
    const height = Math.max(0.6, (v.inst?.height ?? 0.4) + 0.3);
    const geo = new THREE.BoxGeometry(w * CELL + 0.3, height, h * CELL + 0.3);
    const box = new THREE.Mesh(geo, this.wreckFill);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), this.wreckLine);
    const pos = tilePosition(t.x, t.y, w, h).setY(height / 2);
    box.position.copy(pos);
    edges.position.copy(pos);
    box.renderOrder = 7;
    this.group.add(box, edges);
    this.wreck = { anchor, box, edges, armed };
  }

  // Which tile (if any) a world point is on.
  tileAtPoint(p: THREE.Vector3): Tile | undefined {
    const x = Math.floor(p.x / CELL);
    const y = Math.floor(p.z / CELL);
    return this.city.tileAtCell(x, y);
  }

  // pixelScale: viewport height / (2 tan(fov / 2)), for the fire particles' sizes
  update(dt: number, pixelScale = 600): void {
    this.terrain.update(dt);
    if (this.wreck) {
      this.wreckTime += dt;
      // armed: a strong pulsing red, so it's obvious which building is about to go
      this.wreckFill.opacity = this.wreck.armed ? 0.32 + 0.14 * Math.sin(this.wreckTime * 7) : 0.18;
    }
    this.fires.update(dt, pixelScale);
    this.air.update(dt);
    this.clock += dt;
    pulseJammedRoads(this.clock);
    for (const r of this.rotors) {
      const t = r.tile;
      if (t.active && t.powered) r.mesh.rotation.z += dt * (defById(t.id).key === "ferris_wheel" ? 0.25 : 1.2);
    }
  }

  heightOf(anchor: number): number {
    return this.views.get(anchor)?.inst?.height ?? 1;
  }

  worldOf(anchor: number): THREE.Vector3 | undefined {
    const t = this.city.district.tiles.get(anchor);
    if (!t) return undefined;
    const [w, h] = footprint(defById(t.id), t.rot);
    return tilePosition(t.x, t.y, w, h);
  }
}

export const TICK_MS = ECONOMY.TICK_SECONDS * 1000;
export { coords };